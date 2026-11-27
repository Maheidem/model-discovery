# AGENTS.md — @maheidem/model-discovery

This repo is the pi extension "Model Discovery". Its command is `/discover` (see `extensions/metadata.ts`). Its tool is `discover_models`.
It follows the pi extension standard of the `pi-extension-builder` skill.

## Commands

```bash
npm run typecheck          # tsc, strict, noEmit
npm test                   # all tests/**/*.test.* files, no live pi
npm test -- "atomic"       # only tests whose name matches the pattern
npm run test:e2e           # tests/offline.e2e.ts: a real `pi` binary against fake local servers
npm pack --dry-run         # show the packed file list
```

- There is no build step and no linter. pi loads the `.ts` files directly (`pi.extensions` in `package.json`). Imports use the `.ts` extension.
- `npm test` needs Node 22.18 or newer. `tests/run.mjs` is the shared runner of `@maheidem/pi-panel-kit/testing`. Keep that file identical in every pi extension repo.
- The runner starts each test file in its own `node --test` child with a temporary `HOME`. Do not run `node --test tests/<file>` directly. That run uses the real `HOME`, and `storage.ts` writes to `~/.pi/agent/model-discovery.json`.
- Each argument after `--` is a `--test-name-pattern` filter. The runner still starts every file. `PI_PANEL_KIT_TEST_TIMEOUT_MS` changes the timeout for each file.
- `prepack` runs `typecheck` and `test`.
- To try a change in a real pi: `pi --no-extensions -e extensions/index.ts --list-models <provider>`.
- Schema-repair checks against a live server: `node --experimental-strip-types scripts/live-schema-repair-check.ts http://HOST` and `scripts/bisect-grammar.ts http://HOST MODEL FILTER`.

## Architecture

### Layers

| Layer | Files | Rule |
| --- | --- | --- |
| Pi adapter | `extensions/index.ts` | The only file that calls the `pi` API. It holds all panel flows, the command handler and the tool. |
| Application | `extensions/application.ts` | `createDiscoveryApplication(repository)`. All config mutations go through it. Tests give it an in-memory `DiscoveryRepository`. |
| Domain | `providers.ts`, `profiles.ts`, `families.ts`, `family-store.ts`, `model-plan.ts`, `schema-repair.ts`, `storage.ts`, `commands.ts` | Pure logic and file I/O. No `pi` API call. `config.ts` imports only `getAgentDir()`. |
| Screens | `extensions/ui/*.ts`, `ui-model.ts` | Pure builders. Input data in, `PanelSnapshot` out. `index.ts` gives the snapshot to `SettingsPanel` of `@maheidem/pi-panel-kit`. |

Tests import the domain, application and screen modules directly. Only `tests/index.test.ts` and `tests/offline.e2e.ts` load `index.ts`.

The three family modules have these roles:

- `families.ts` is pure logic. It validates a family file, matches a model to a family, finds the model kind, and makes the thinking profile, the level map and the bundled presets.
- `family-store.ts` does the file and network I/O of the family data: the bundled files, the cache file and the update from GitHub. No function in it throws.
- `model-plan.ts` is pure logic. `resolveModel` gives the effective settings of one model. `registerProvider` and the panels read the same result.

### Flow from a server to a pi model

1. `fetchModels` (`providers.ts`) reads `/v1/models`. `detectServerType` reads headers and model data.
2. `enrichModels` adds data from native endpoints (llama.cpp `/props`, oMLX `/v1/models/status`, Ollama `/api/tags` and `/api/ps`). It stores that data under the key `ENRICH_KEY` (`__md`) in each raw model. The data now also has the thinking report (oMLX `thinking_default`, `preserve_thinking_default`, `reasoning_efforts`; llama.cpp `chat_template`), the model type and the image input as yes or no.
3. The llama.cpp `/props` answer goes to one model only: the only model of the catalogue, or the model whose id is equal to `model_alias` or to the file name of `model_path`. An answer with `role: "router"` goes to no model.
4. `recordSuccessfulScan` (`storage.ts`) saves the raw catalogue as the last known-good cache. `recordFailedScan` saves only the error. A failed scan never replaces the cache.
5. `extractModelConfig` (`providers.ts`) makes one `ModelConfig` from each raw model. `vision`, `modelType` and `thinking` are `null` when the server says nothing.
6. `registerProvider` (`index.ts`) calls `resolveModel` (`model-plan.ts`) for each model. `resolveModel` decides each field. The order is: user setting, then server report, then family file, then fixed default (`128000` context, `16384` max tokens). The source default comes before the family for the context window. Max tokens has no family value.
7. `registerProvider` skips a hidden model. A model that is not a chat model is hidden by default. A source with no registered model is unregistered.
8. A base model with a thinking control gets `thinkingLevelMap` and `samplingParamsByThinkingLevel` (`resolved.baseLevelParams`). With the recommended defaults on, each level has the thinking values and the sampling of its bundled preset. With the defaults off, each level has the on/off switch only.
9. `expandModelProfiles` (`profiles.ts`) adds one fixed alias `<model>@<slug>` for each visible preset. `expandAdaptiveProfileRouters` adds one adaptive alias for each enabled routing map. The fixed fields of a fixed alias are in `samplingParams`. A sampling-only alias and an adaptive alias carry `samplingParamsByThinkingLevel`.
10. `buildLevelParams` (`profiles.ts`) makes the request fields for all three model types. It sends only the thinking values that the model accepts. The server entry in `families/index.json` selects the transport: `chat_template_kwargs`, or a top-level `reasoning_effort` (Ollama, LM Studio).
11. `pi.registerProvider` gets the full list. `compat` is attached to each model, because pi does not merge provider-level `compat` into models. A model whose thinking values come from this extension gets `extensionThinkingCompat`, so pi adds no thinking field of its own.

pi merges `samplingParamsByThinkingLevel` into each request (pi 1.6.0 and later). The type `ProviderChatModelConfig` of pi does not have this field.

At startup, all saved sources are scanned at the same time. A source that fails is registered from its cached catalogue. The start also calls `refreshFamilies()` in the background and does not wait for it.

### Request-time hook

`before_provider_request` does two things only:

- For a provider in the set `schemaRepairProviders`, it repairs tool schemas for the llama.cpp grammar converter (`repairRequestToolSchemas`). A payload with no change keeps its object identity. Cloud payloads are not touched.
- It calls `logWireRequest`. When `PI_MODEL_DISCOVERY_WIRE_LOG=<file>` is set, that function appends one JSON line for each request. The line has no message text and no API key.

The hook does not change sampling fields or thinking fields.

`index.ts` keeps three in-memory label maps, keyed by `<provider>/<modelId>`: `thinkingRoutes`, `fixedProfileLabels` and `baseDefaultLabels`. They hold only the text for the footer status (`updateThinkingProfileStatus`): `preset: <slug>`, `fixed preset: <slug>` or `defaults: <family> · <preset>`. `registerProvider` rebuilds the entries of a provider each time.

A rename or a remove of a source must call `pi.unregisterProvider` with the old name.

### Command, panel and tool parity

- `parseDiscoverArgs` (`commands.ts`) changes the `/discover` argument string into a `DiscoveryIntent`. The command handler in `index.ts` runs the intent in TUI mode (panels) or in headless mode (text).
- `tests/fixtures/discover-actions.ts` is the one inventory that joins each panel row key, its `/discover` verb and its `DiscoveryApplication` method. `tests/ui-parity.test.ts` fails when one of the three is missing. Add a new action to all three and to the fixture.
- A secret comes only from the masked field or from `--key-from-env`. It is never an inline command argument. Use `redactSecret` on text that can contain a key.
- A destructive row needs two presses in the TUI and `--yes` in headless mode.
- All panels use a fixed frame of 23 rows (`*_PANEL_ROWS`).

### Stored data

`model-discovery.json` is a JSON array of `DiscoveredProvider` (`storage.ts`). `modelOverrides`, `modelProfiles` and `modelProfileRouting` are keyed by the base model id. Writes are atomic with mode `0600`. A corrupt file is renamed to `model-discovery.json.corrupt-<timestamp>` and the load returns an empty list.

A stored preset that fails validation stays in the file. It is not registered, and `/discover doctor` lists it.

The family cache file is `model-discovery-families.json` in the same directory (`FAMILIES_CACHE_PATH` in `family-store.ts`). The cache is used only when it is valid and its `revision` is higher than the bundled `revision`.

## Rules for a change

- Keep `extensions/index.ts` as the pi entry. Put new behaviour in `extensions/application.ts` and the domain modules (`providers.ts`, `profiles.ts`, `families.ts`, `family-store.ts`, `model-plan.ts`, `storage.ts`, `schema-repair.ts`).
- Import UI parts from `@maheidem/pi-panel-kit`. Do not copy kit files into `extensions/ui/` or `extensions/lib/`. The screens in `extensions/ui/` (`home.ts`, `endpoint-panel.ts`, `add-panel.ts`, `advanced-panel.ts`) are domain screens and stay here.
- Get the config path from `getAgentDir()`. Export it as `CONFIG_PATH` from `extensions/config.ts`. `STORAGE_PATH` in `storage.ts` is the same path.
- Make only additive changes to the stored data format: add optional fields. Never rename or remove a field. Never change the file name `model-discovery.json`.
- Change a family value in `families/*.json`, and increase `revision` in `families/index.json`. `npm test` validates each family file. `docs/model-families.md` has the steps and the source of each value.
- A push of family data to `main` reaches every install in 24 hours or less. Run `npm test` before the push.
- A new control type in a family file needs a release. The validator of an older version refuses a file with an unknown key.
- Put all tests in `tests/`. `npm test` runs `tests/run.mjs` and never starts a live pi. The live-pi test is `tests/offline.e2e.ts` (`npm run test:e2e`).
- `package.json` `files` is the list of packed files. It includes `families/`. There is no `.npmignore`.
- Keep `.planning/` out of git.

## Release steps

1. Run `npm run typecheck` and `npm test`.
2. Run `npm version <minor|patch> --no-git-tag-version` and add a `## [x.y.z]` section to `CHANGELOG.md`.
3. Commit, then tag `vX.Y.Z`.
4. The owner pushes and runs `npm publish` with the OTP.
5. The owner runs `pi install npm:@maheidem/model-discovery@<x.y.z>` and checks the version of the store copy.

## Notes moved from the management workspace

Moved from the pi-coder-management workspace on 2026-11-26. Since 0.10.0 the runtime modules are in `extensions/` (for example `storage.ts` is `extensions/storage.ts`).

- `model-discovery` is published to npm as `@maheidem/model-discovery` and installed from the agent-global store (npm-first since 2026-09-10).
  - **oMLX API keys (since 2026-10-25 ~07:25, arrived with an oMLX update):** both oMLX servers — `local-mac` (`localhost:8123`) and `mac-m3` (`10.0.0.2:8123`) — now 401 every endpoint without a key, incl. `/v1/models`, `/v1/models/status`, `/api/status` (`Authorization: Bearer <key>`; `x-api-key` also works except on `/admin/*`). The key lives ONLY in `~/.pi/agent/model-discovery.json` (provider `apiKey`, file 0600) — never paste it into docs, specs, or logs. `Desktop` (`10.0.0.3`: llama-swap on :80, llama.cpp router on :8081) has no auth. A provider without a key registers `apiKey: "local"`, which oMLX logs as `Rejected API key`.
  - **Reading oMLX logs:** oMLX 0.8.4 at log level `info` writes one `Chat completion: model=…` line for each successful chat request in `~/.omlx/logs/server.log` (seen 2026-11-27). The other endpoints (for example `/v1/models`) are silent on success and log only FAILED auth (`GET /v1/models → 401: API key required` / `Rejected API key (fp=…)`). Thus "no keyed requests in the log" proves nothing for those endpoints. `mac-m3` also has TRACE lines in `~/.omlx/logs/server.log` and a uvicorn access log with client IPs in `~/.omlx/logs/launchd-stdout.log` (SSH works to `mac-m3` and `Desktop`); llama-swap exposes `GET http://10.0.0.3/logs` (client IP + user agent per request). The keyless `GET /v1/models` every 2 minutes on `mac-m3` is another client's health check, not model-discovery.
  - **Never delete and re-add providers to "retry" auth** — it wipes hand-built `modelProfiles`/`modelProfileRouting`/`modelOverrides`. On 2026-10-25 all three were deleted this way and restored from an Oct-11 config dump found in a session JSONL; Desktop's `qwen3.8-27b@adaptive` profile set was lost and recreated by copying local-mac's `Qwen3.8-27B` set. Set a key from the source screen's API-key row instead. Backups: `~/.pi/agent/model-discovery.json.bak-*`.
  - **Add-flow gate:** Register refuses until the fallback context/max-tokens rows are set whenever ANY model lacks reported values — local oMLX `MarkItDown` reports none; Desktop via llama-swap `:80` reports none at all (`:8081` direct reports them through `/props`).
  - **Scripted config surgery:** import the source tree's `extensions/storage.ts`/`extensions/providers.ts`/`extensions/profiles.ts` with `node --experimental-strip-types` (keep source == store version) and use `fetchModels`, `recordSuccessfulScan`, `saveModelProfile`/`saveModelProfileRouting`, `saveProviders`; dry-run the registered alias ids with `expandModelProfiles` + `expandAdaptiveProfileRouters` before asking the user to `/reload`. End-to-end check per provider: `pi -p --no-session --model <provider>/<model> "<prompt>"`, then confirm the hit in that server's log.

## Live test

- Do not navigate panels in the real pi with keys that you did not check.
- On 2026-11-27 a script sent Down and Enter with no check of the cursor row. It changed stored model settings. The config was restored from a backup.
- Use typed `/discover` verbs for a live test.
- If a panel is necessary, read the cursor row before each key.
- Set `PI_MODEL_DISCOVERY_WIRE_LOG=<file>` to see the request fields that the extension controls.

## Reference

- README.md: user documentation, value order of each model field, thinking profile, level map, preset and routing semantics, schema-repair details.
- `docs/model-families.md`: the values of each bundled family, the source of each value, the level map and the steps to change a value.
- `docs/providers/*.md`: research from 2026-08-28 on the API and the reported metadata of each server type.
- `.planning/`: local design notes, not in git.

# AGENTS.md — @maheidem/model-discovery

This repo is the pi extension "Model Discovery". Its command is `/discover` (see `extensions/metadata.ts`). Its tool is `discover_models`.
It follows the pi extension standard of the `pi-extension-builder` skill.

## Rules for a change

- Keep `extensions/index.ts` as the pi entry. Put new behaviour in `extensions/application.ts` and the domain modules (`providers.ts`, `profiles.ts`, `storage.ts`, `schema-repair.ts`).
- Import UI parts from `@maheidem/pi-panel-kit`. Do not copy kit files into `extensions/ui/` or `extensions/lib/`. The screens in `extensions/ui/` (`home.ts`, `endpoint-panel.ts`, `add-panel.ts`, `advanced-panel.ts`) are domain screens and stay here.
- Get the config path from `getAgentDir()`. Export it as `CONFIG_PATH` from `extensions/config.ts`. Do not change the file name `model-discovery.json` or the stored data format. `STORAGE_PATH` in `storage.ts` is the same path.
- Put all tests in `tests/`. `npm test` runs `tests/run.mjs` and never starts a live pi. The live-pi test is `tests/offline.e2e.ts` (`npm run test:e2e`).
- `package.json` `files` is the list of packed files. There is no `.npmignore`.
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
  - **Reading oMLX logs:** both servers log only FAILED auth (`GET /v1/models → 401: API key required` / `Rejected API key (fp=…)`); successful requests are silent at the local log level, so "no keyed requests in the log" proves nothing. `mac-m3` also has TRACE lines in `~/.omlx/logs/server.log` and a uvicorn access log with client IPs in `~/.omlx/logs/launchd-stdout.log` (SSH works to `mac-m3` and `Desktop`); llama-swap exposes `GET http://10.0.0.3/logs` (client IP + user agent per request). The keyless `GET /v1/models` every 2 minutes on `mac-m3` is another client's health check, not model-discovery.
  - **Never delete and re-add providers to "retry" auth** — it wipes hand-built `modelProfiles`/`modelProfileRouting`/`modelOverrides`. On 2026-10-25 all three were deleted this way and restored from an Oct-11 config dump found in a session JSONL; Desktop's `qwen3.8-27b@adaptive` profile set was lost and recreated by copying local-mac's `Qwen3.8-27B` set. Set a key from the source screen's API-key row instead. Backups: `~/.pi/agent/model-discovery.json.bak-*`.
  - **Add-flow gate:** Register refuses until the fallback context/max-tokens rows are set whenever ANY model lacks reported values — local oMLX `MarkItDown` reports none; Desktop via llama-swap `:80` reports none at all (`:8081` direct reports them through `/props`).
  - **Scripted config surgery:** import the source tree's `extensions/storage.ts`/`extensions/providers.ts`/`extensions/profiles.ts` with `node --experimental-strip-types` (keep source == store version) and use `fetchModels`, `recordSuccessfulScan`, `saveModelProfile`/`saveModelProfileRouting`, `saveProviders`; dry-run the registered alias ids with `expandModelProfiles` + `expandAdaptiveProfileRouters` before asking the user to `/reload`. End-to-end check per provider: `pi -p --no-session --model <provider>/<model> "<prompt>"`, then confirm the hit in that server's log.

# Changelog

## [0.11.0]

### Added

- Model families. A family file in `families/` holds the thinking controls, the sampling values and the fallback capabilities of one model family. Nine families are bundled: Qwen 3, Qwen 3.5 small, Qwen 3.5, Qwen 3.6, Qwen 3.8, Gemma 4, Inkling, Inkling 2 Small and Inkling 2 Mini. `docs/model-families.md` gives each value and its source.
- Server thinking profile. The extension reads the thinking controls that a model accepts from the server: oMLX `/v1/models/status` (`thinking_default`, `preserve_thinking_default`, `reasoning_efforts`) and the llama.cpp `/props` chat template. The family file is the fallback. The extension sends only the values that the model accepts.
- Level map. Each of the seven pi thinking levels maps to the nearest effort that the model accepts. A tie goes to the higher effort. A model with only the on/off switch offers the levels `off` and `high`.
- `/discover preset defaults <source> <modelId> [--yes]` and the row "Customize recommended presets". The action copies the recommended presets into the config and turns on the adaptive alias.
- `/discover families update` and the row "Update model family data". The extension also reads new family data in the background, at most one time each 24 hours. `PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE=1` stops the automatic read. `PI_MODEL_DISCOVERY_FAMILIES_URL` sets a different base URL.
- Model settings `defaults on|off`, `family <family>|auto|none` and `hidden on|off`, as `/discover model` verbs and as rows of the model panel.
- The value `auto` for `/discover model <id> reasoning` and `/discover model <id> vision`. It deletes the stored value. The server value or the family value applies again.
- Hidden models. A model that is not a chat model (embedding, speech-to-text, text-to-speech, reranker, other) is not registered by default. `/discover model <id> hidden off` registers it.
- Three-state image input. The server value is yes, no or unknown. The model panel shows the value in use and its source.
- The debug switch `PI_MODEL_DISCOVERY_WIRE_LOG=<file>`. It appends one JSON line for each request, with no message text and no API key.
- `promptSnippet` on the `discover_models` tool. Each guideline names the tool.
- `/discover doctor` shows the family data in use, each rejected family file and each stored preset that is not valid.

### Changed

- The minimum pi version is 1.6.0. The extension uses `samplingParamsByThinkingLevel`, which pi merges into each request.
- One wire path. The base model, each fixed alias and each adaptive alias carry `samplingParamsByThinkingLevel`. One function (`buildLevelParams`) makes the request fields, so the three model types send the same fields for the same preset. The request hook does not change sampling or thinking fields.
- A base model with a thinking control sends the recommended thinking values and sampling values at each pi level, with no stored preset. Behaviour change: the base Qwen 3.8 model on oMLX now sends `reasoning_effort` and sampling values. In 0.10.0 it sent the on/off switch only. `/discover model <id> defaults off` gives the 0.10.0 behaviour.
- The value order of each model field is: your setting, then the server report, then the family file, then a fixed default.
- A server "no" for image input wins over the family value.
- The llama.cpp `/props` answer applies only to its model: the only model of the catalogue, or the model whose id is equal to `model_alias` or to the file name of `model_path`. A router answer applies to no model.
- The conventional routing ("Map presets by kind") follows the controls of the model. It needs exactly one preset for each kind that the level map of the model uses.
- A preset can use each effort that the model accepts: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.
- Changes of the stored format are additive. The new fields `family`, `familyDefaults` and `hidden` of a model override are optional.
- The packed file list (`files` in `package.json`) includes `families/`.

### Fixed

- A hidden preset became visible in `/model` after a save. `exposeAsModel: false` is now stored.
- `/discover preset set` saved a preset with no validation. It now refuses a preset that is not valid.
- A stored preset that was not valid was deleted on the next save. It now stays in the file, and `/discover doctor` lists it.
- The toggle "Show as fixed model in /model" of the preset editor had no effect.
- The "Adaptive routing" enabled toggle wrote the old state.
- "Clear overrides" did not save.
- The `/discover model` verbs printed nothing in print mode.

### Removed

- The developer-role override (`supportsDeveloperRole: false`). pi 1.6 sends the system role to compatible hosts.
- The `^qwen` name test for reasoning on oMLX. The server report and the family file replace it.
- `applyThinkingProfileRoute`. pi merges the per-level fields.

### Downgrade

- Version 0.10.0 accepts only the effort values `low`, `medium` and `xhigh`. It drops each stored preset that uses `none`, `minimal`, `high` or `max` on its next save. Make a copy of `model-discovery.json` before a downgrade.

## [0.10.0]

- Move the runtime code to `extensions/` and all tests to `tests/`. The pi entry is `./extensions/index.ts`.
- Import `SettingsPanel`, the panel frame, the report panel, `SecretField`, the tool cards, the formatters, `BACK_KEY` and `extensionVersion` from `@maheidem/pi-panel-kit`. The local copies are deleted.
- Build `CONFIG_PATH` (`extensions/config.ts`) from `getAgentDir()`. The file is still `<agent dir>/model-discovery.json` (normally `~/.pi/agent`). `STORAGE_PATH` is the same path. `/discover paths` prints it.
- Register `/discover` with `COMMAND_NAME` from `extensions/metadata.ts`.
- Run the tests with the shared `tests/run.mjs` runner of the kit (Node 22.18 or newer). The live-pi test moves to `npm run test:e2e`.
- Pin the dev host packages to pi 1.6.1. Set `engines.node` to `>=18`. Point `repository` at `Maheidem/model-discovery`.
- Delete `.npmignore`. `files` is the list of packed files.

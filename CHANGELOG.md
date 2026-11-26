# Changelog

## [0.10.0]

- Move the runtime code to `extensions/` and all tests to `tests/`. The pi entry is `./extensions/index.ts`.
- Import `SettingsPanel`, the panel frame, the report panel, `SecretField`, the tool cards, the formatters, `BACK_KEY` and `extensionVersion` from `@maheidem/pi-panel-kit`. The local copies are deleted.
- Build `CONFIG_PATH` (`extensions/config.ts`) from `getAgentDir()`. The file is still `<agent dir>/model-discovery.json` (normally `~/.pi/agent`). `STORAGE_PATH` is the same path. `/discover paths` prints it.
- Register `/discover` with `COMMAND_NAME` from `extensions/metadata.ts`.
- Run the tests with the shared `tests/run.mjs` runner of the kit (Node 22.18 or newer). The live-pi test moves to `npm run test:e2e`.
- Pin the dev host packages to pi 1.6.1. Set `engines.node` to `>=18`. Point `repository` at `Maheidem/model-discovery`.
- Delete `.npmignore`. `files` is the list of packed files.

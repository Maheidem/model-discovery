---
name: live-matrix
description: Run the live test matrix of model-discovery in the real pi TUI (tmux) against the real servers, and build the evidence page. Use it before a release that changes thinking controls, presets, routing, model families or image input.
---

# Live test matrix

One command runs all rows, validates them and builds the evidence page. The harness is in `tests/live/`.

```bash
npm run test:live                                  # all rows (about 40 minutes)
npm run test:live -- --only gemma-local,flash-m3   # some rows; the other cases run too
npm run test:live -- --list                        # print the rows and the preflight result, run nothing
```

- Exit code 0: each check passes. Exit code 1: a check fails, a check has no data, or a row did not run.
- Output folder: `.live-matrix/<date-time>/` (not in git). It holds `evidence.html`, `result.json`, `run.log`, `run.json` and `ev/`.
- The last line shows the totals and the full path of `evidence.html`.

## What the terminal shows

- On a terminal, one status line shows the progress: `[row 1/7] <tag> <source>/<model> [####----] case 3/7 tool call  1m12s`. The line changes in place one time each second. The bar shows the complete cases of all rows.
- When a row ends, one line stays on the screen: `[row 1/7] <tag>  ✓ panel  ✓ auto  ✓ customize  ✓ edit  ✓ fixed  ✓ image  ✓ tool  2m49s`. A `✗` shows a case that did not pass.
- After that line, one indented line shows each check that failed or has no data, with the expected value and the actual value. A value longer than 160 characters is cut. The page shows the full value.
- The other cases get one line at the end: `[other cases]  ✓ list  ✓ listonly  ✓ hidden  ✓ realconfig  ✓ families`.
- Not on a terminal (a pipe, CI): no status line and no escape code. One plain line shows each case start: `[row 1/7] <tag> <source>/<model> case 3/7 tool call`. The row lines are the same.
- To see the live pi session, run `tmux attach -r -t md-live` in a second terminal. The name is the same for the full run. The view is a copy of the screen, one second late. No key reaches pi. Press `Ctrl-b d` to leave it.
- To get the verdict of one row from a run folder: `python3 tests/live/build_evidence.py --row <tag> .live-matrix/<date-time>` (`--row other` for the other cases). It prints one JSON line and writes no file.
- First run: 2026-11-27, release 0.11.0, with hand-run scripts. The harness replaced them on the same day.

## Hard rules

- pi runs with a temporary agent folder (`<run>/agent`, `PI_CODING_AGENT_DIR`). The harness never writes `~/.pi/agent`. Do not change that.
- pi starts with `--no-extensions -e <repo>/extensions/index.ts`. Only this extension is loaded.
- Do not send a key to a panel unless the cursor row is checked. Use `open_model` and `goto_row` of `lib.sh`. On 2026-11-27 an unchecked Down/Enter loop changed stored model settings.
- Do not delete and add a source again. Change the config copy only through `/discover` verbs or checked panel rows.
- A source with `oneModelAtATime` (`mac-m3`): one model loaded at a time. `omlx.mjs unload` refuses when the server has active or waiting requests. The harness loads the first models again at the end.
- A source with `listOnly` (`Desktop`): `--list-models` only. Load no model there.
- Never print an API key. `expected.mjs` and `omlx.mjs` read the key from the config copy and do not print it.
- Do not start two runs at the same time. The lock file `.live-matrix/lock` prevents it.
- The temporary agent folder holds API keys. The cleanup deletes it. Do not copy it.

## Known facts

- oMLX 0.8.4 at log level `info` writes one `Chat completion: model=…` line for each chat request. It does not log `chat_template_kwargs`. The wire log of pi is the source for those values.
- The footer of pi hides the thinking level when the terminal is narrow. The sessions use 200 columns.
- The footer of pi with no other extension ends with `<model> • thinking off` or `<model> • <level>`. `level` of `lib.sh` reads that text.
- The first Enter after a typed slash command can accept a completion. `cmd` sends a second Enter when the text is still in the editor.
- A switch-only model offers `off` and `high`. pi changes any other level to `high`.
- `md-live` is a tmux session that draws the screen of the newest pi session one time each second (`live_view` of `lib.sh`; `<run>/live-target` holds the session name). It reads the screen with `capture-pane`. It is not a client of the pi session.
- Do not attach a tmux client to a pi session of a run. On 2026-11-27 an attached read-only client changed the pi window from 46 to 45 rows. A session group or a linked window is not possible: `kill-session` then leaves the window, and pi stays alive.
- The case number of the status line is the number of marker lines in `ev/<tag>.log`. `build_evidence.py` splits the log at each `## <n>` line. Case 2 has a `#> 2` line, because its lines must stay in section 1.
- Gemma 4 E4B reads the test word wrong when a long text is before the image. On 2026-11-27 the run folder was inside the repo, so pi added `AGENTS.md` (about 10k tokens) to each prompt, and the answer was `ZEBRAFRA42` in 4 of 4 tries. The harness starts pi with `--no-context-files`, and `word.png` has spaced letters (`Z E B R A 4 2`); that image gave `ZEBRA42` in 8 of 8 tries.
- The image step runs one more time when the answer has no `ZEBRA42`. The first answer goes to `ev-first-try/` and the page shows it. The server can answer the second try from its prompt cache, so the second answer is frequently the same.
- pi downloads `fd` and `rg` into a new agent folder at start. A slow download made `/discover source open` fail with `Unknown source`. `run.sh` copies the two tools from the real agent folder.
- An easy prompt gives no thinking on Gemma 4. The level prompt asks for the n-th prime function.
- The oMLX load state uses server ids. `omlx.mjs` changes them to the ids that pi shows (the alias).
- The expected values come from the code of the extension (`expected.mjs` calls `fetchModels`, `extractModelConfig` and `resolveModel` with the bundled family files). A logic error of the level map shows in `npm test`, not here.
- These checks do not use the code of the extension: reasoning absent at `off` and present at the other levels, the image word, the tool call line, no error text in the server log or on the screen, adaptive wire lines equal base wire lines.
- A full run evicts models on `local-mac` (seen on 2026-11-27 with `Inkling-2-Mini`).

## What the command does

1. Preflight: tools, pi, the config, the matrix, the lock.
2. It records the SHA-256 of the real `model-discovery.json` and the real pi `settings.json`.
3. It makes `<run>/agent/` with a 0600 copy of the config, a pristine copy for `restore_cfg`, and a minimal `settings.json`.
4. Reach check: `pi --list-models <source>` for each source. A row whose model is absent is "not run".
5. For each row: `expected.mjs`, then `run_model.sh` (7 cases) as a child process, then the server log lines, then the verdict line of the row (`build_evidence.py --row <tag>`).
6. Other cases: the model lists, the list-only sources, the hidden model row, `/discover families update` with a compare of the cache and `families/` on `origin/main`.
7. It loads the first models of each one-model-at-a-time source again.
8. Real config proof: the two SHA-256 values are the same as in step 2.
9. `build_evidence.py` writes `evidence.html` and `result.json`.
10. Cleanup (also on Ctrl-C): stop the `run_model.sh` child, stop the `md-*` tmux sessions of the run (also `md-live`), load the models again, delete `<run>/agent`, remove the lock.

## Verify

- The last line shows `0 fail, 0 partial, 0 not run` and `Exit code 0`.
- `jq '.ok, .problems' .live-matrix/<date-time>/result.json` shows `true` and `[]`.
- `cat .live-matrix/<date-time>/ev/other/real-config.txt` shows two lines that end with `same: true`.
- To see that the harness can fail: change one value in `ev/<tag>.expected.json`, run `python3 tests/live/build_evidence.py .live-matrix/<date-time>`, and expect exit code 1 with that check named.
- Publish `evidence.html` as a private artifact when the owner asks for the page.

## Cleanup

- `tmux ls | grep md-` shows no session.
- `ls .live-matrix/<date-time>/agent` shows no folder. If a run was killed with `kill -9`, delete that folder by hand.
- `node tests/live/omlx.mjs ~/.pi/agent/model-discovery.json mac-m3 status` shows the models that were loaded before the run.
- Delete old run folders in `.live-matrix/` when you do not need them.

## Add a model

1. Add one row to `tests/live/matrix.json`: `{ "tag": "<short name>", "source": "<source name in the config>", "model": "<model id that pi shows>" }`.
2. Optional: `"imageFlags": "--no-tools"` gives more pi arguments to the image step.
3. A new source needs an entry in `sources`. Rules: `oneModelAtATime`, `listOnly`, and `sshHost` (the SSH host for the oMLX log; the default is the host of the base URL).
4. Run `npm run test:live -- --only <tag>`.
5. No expected value is written by hand. `expected.mjs` computes it.

## Add a case

- A case for each model: add the steps to `tests/live/run_model.sh` under a new `echo "## <number> <name>"` line. The status line counts these lines and shows the name. Add a `case_<name>` function to `tests/live/build_evidence.py` and put it in `CASES` and `CASE_FN`.
- A case for all sources: add the steps to the "other cases" part of `tests/live/run.sh`. Write the evidence to `ev/other/`. Add the check to `other_cases()` and the name to `OTHER_CASES`.
- A check must compare a value in an evidence file with a value from `expected.json` or with a fixed fact. Do not make a check weaker to make it pass.
- After a run, put each new lesson in this file.

---
name: live-matrix
description: Run the live test matrix of model-discovery in the real pi TUI (tmux) against the real servers, and build the evidence page. Use it before a release that changes thinking controls, presets, routing, model families or image input.
---

# Live test matrix

First run: 2026-11-27, release 0.11.0. Result: 54 of 54 cases showed expected = actual.

## Hard rules

- The tests use the REAL pi config. Make a snapshot first and restore it after each model (`restore_cfg`).
- Do not send a key to a panel unless the cursor row is checked. Use `open_model` and `goto_row`. On 2026-11-27 an unchecked Down/Enter loop changed stored model settings.
- Do not delete and add a source again. Change the config only through `/discover` verbs or checked panel rows.
- Do not run another `pi` command while a model run is active. Each pi start writes scan state to the config file.
- `mac-m3`: one model loaded at a time. Unload only when `m3.mjs status` shows `active: 0 waiting: 0`. Load the first model again at the end.
- `Desktop`: `--list-models` only. Load no model there.
- Never print an API key. `m3.mjs` reads the key from the config and does not print it.

## Known facts

- oMLX 0.8.4 at log level `info` writes one `Chat completion: model=…` line for each chat request. It does not log `chat_template_kwargs`. The wire log of pi is the source for those values.
- The status line of pi hides the thinking level when the terminal is narrow. The scripts use 200 columns.
- The first Enter after a typed slash command can accept a completion. `cmd` sends a second Enter when the text is still in the editor.
- A switch-only model offers `off` and `high`. pi changes any other level to `high`.
- The `pi-ocr` extension can answer an image prompt with its tool, and it leaves a `*.ocr.json` file next to the image. The image step deletes that file. Use `IMGFLAGS=--no-tools` where the tool must not load a second model.
- Gemma 4 E4B can read one or two letters wrong in the test image. Run the image step one more time and keep the first answer in `ev-first-try/`.
- An easy prompt gives no thinking on Gemma 4. The level prompt asks for the n-th prime function.

## Steps

1. Set the environment and make the snapshot:

   ```bash
   export LIVE_MATRIX_DIR=<empty work folder>
   export LIVE_MATRIX_SNAPSHOT=model-discovery.json.bak-pre-live-matrix-<date>
   export LIVE_MATRIX_M3_HOST=<address of mac-m3>
   export LIVE_MATRIX_VERSION=<x.y.z>
   cp -p ~/.pi/agent/model-discovery.json ~/.pi/agent/$LIVE_MATRIX_SNAPSHOT
   mkdir -p $LIVE_MATRIX_DIR/work $LIVE_MATRIX_DIR/ev
   ```

2. Put two files in `$LIVE_MATRIX_DIR/work`: `notes.txt` with the first line `PINEAPPLE-7781 is the first line.` and `word.png`, a white picture with the black word `ZEBRA42`.
3. Point pi at the local repo (the package list of the pi settings file) and check the version line of `/discover doctor`.
4. Run one model at a time: `./run_model.sh <tag> <source> <model> > $LIVE_MATRIX_DIR/ev/<tag>.log 2>&1`. Tags of the first run: `gemma-local`, `inkling-local`, `qwen38-local`, `qwen36-local`, `qwen35-local`, `flash-m3`, `gemma-m3`.
5. Collect the server lines: `source lib.sh; server_lines <tag>` for the local server, `server_lines <tag> $LIVE_MATRIX_M3_HOST` for `mac-m3` (SSH).
6. Other cases, into `ev/other/`: `list-models.txt`, the hidden model pictures (`hidden-row`, `hidden-model`), `config-readback.txt`, `families-update.txt`, `families-verbs.txt`. `build_evidence.py` says what each check reads.
7. Build the page: `python3 build_evidence.py`. It prints the summary table and each failing check.
8. Publish `evidence.html` as a private artifact.

## Verify

- `python3 build_evidence.py` ends with `Failing checks:` and `- none`, and the totals line shows `0 fail, 0 partial, 0 not run`.
- The config read-back shows `presets same: true routing same: true` for each source.
- `node m3.mjs status` shows the model that was loaded before the run.

## Cleanup

- `tmux ls | grep md-` shows no session.
- Restore the config from the snapshot if a run stopped in the middle.

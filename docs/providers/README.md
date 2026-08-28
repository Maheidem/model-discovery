# Local Inference Provider API Reference

Research reference for the `/discover` extension: how each major local inference server
exposes its API, what metadata it reports, and where the plugin's current detection logic
has gaps. Researched 2026-08-28 from official docs, upstream READMEs, and (for oMLX /
mlx-lm / MTPLX) the server source code.

> **Not for the npm tarball** — this directory is excluded via `.npmignore`. It lives in the
> git repo so future plugin-tuning sessions have the reference co-located with the code.

## Providers covered

| Provider | Default port | Doc | Plugin status today |
| --- | --- | --- | --- |
| llama.cpp (`llama-server`) | 8080 | [llama-cpp.md](llama-cpp.md) | ✅ detected + `/props` enrichment |
| vLLM | 8000 | [vllm.md](vllm.md) | ✅ detected, metadata gap |
| Ollama | 11434 | [ollama.md](ollama.md) | ✅ detected + `/api/tags` enrichment, sampling gap |
| LM Studio | 1234 | [lm-studio.md](lm-studio.md) | ✅ detected, metadata gap |
| oMLX | 8000 | [omlx.md](omlx.md) | ✅ best-supported (own server + status enrichment) |
| MTPLX | 8000 | [mtplx.md](mtplx.md) | ✅ detected via `capability` field (0.7.0) |
| SGLang | 30000 | [sglang.md](sglang.md) | ✅ detected, thinking gap |
| mlx-lm (official MLX) | 8080 | [mlx-lm.md](mlx-lm.md) | ⚠️ undetected, no metadata |
| LocalAI / KoboldCpp / Jan / TGI / mlx-openai-server | — | [other.md](other.md) | ⚠️ generic only |

## How the plugin works today (baseline for tuning)

1. **Probe** `GET {baseUrl}/v1/models` with optional `Authorization: Bearer` — hard failure
   on anything but a 200 with a `data: [{ id, ... }]` array.
2. **Detect server type** (`detectServerType`):
   - `Server` header containing `llama-cpp`/`llama.cpp`, `ollama`, `vllm`, `sglang`,
     `lm-studio`/`lmstudio`, `omlx`; `X-Powered-By: omlx`
   - `owned_by` fallbacks: `omlx`, `vllm`, `llamacpp`
   - **`capability` field on `/v1/models` entries → MTPLX** (0.7.0)
   - model ids containing `:` → Ollama
   - else `OpenAI-compatible`
3. **Native-endpoint enrichment** (`enrichModels`, 0.7.0) — one best-effort pass, fills
   only what `/v1/models` omitted, never fails the scan (1s timeout per endpoint):
   - llama.cpp `GET /props` → runtime `n_ctx` + `modalities.vision`
   - oMLX `GET /v1/models/status` → effective `max_context_window`, `max_tokens`,
     `loaded`, `thinking_default` (matched by physical id *and* user alias)
   - Ollama `GET /api/tags` + `GET /api/ps` → default `context_length`, loaded set
4. **Extract per-model config** (first value found wins):
   - context window: `context_length` → `context_window` → `max_model_len` →
     `max_context_len` → `max_context_length` → `status.args --ctx-size` →
     `status.preset ctx-size` → `meta.n_ctx` → source default → 128000
   - max output: `max_tokens` → `max_output_tokens` → `max_completion_tokens` →
     `status.args --n-predict` → source default → 16384
   - reasoning: `capabilities` incl. `reasoning` → `reasoning` field →
     `--reasoning-budget` ≠ 0 → (oMLX only) Qwen-name heuristic → oMLX status `thinking_default`
   - vision: `architecture.input_modalities` → vision architecture keys
     (`vision_config`, `vision_model`, `mm_proj`, `multi_modal_projector`) →
     `--mmproj`/`--vision` args or preset name → oMLX `capabilities` → enrichment `vision`
   - the context/max-token chains end with **enrichment** before the source default
5. **Register with Pi** with per-model `compat`:
   - llama.cpp / oMLX / Ollama: `supportsDeveloperRole: false`
   - oMLX: `thinkingFormat: "qwen-chat-template"`, `supportsReasoningEffort: true`
6. **Profiles** (0.6.0): named thinking/sampling bundles; wire key for repetition penalty
   is chosen by server type (`repeat_penalty` for llama.cpp/LM Studio,
   `repetition_penalty` for oMLX/vLLM/SGLang, best-effort for Ollama/generic).

## Done in 0.7.0 (native-endpoint enrichment)

| # | Provider | What changed |
| --- | --- | --- |
| 1 | llama.cpp | `/props` probed: real runtime `n_ctx` (no more 128000 fallback on single-model servers) + authoritative `modalities.vision` VLM flag |
| 3 | oMLX | `/v1/models/status` probed: effective per-model context + max tokens, `[loaded]` flag, `thinking_default` → reasoning detection (alias-aware matching) |
| 4 | Ollama | `/api/tags` + `/api/ps` probed: default context from model cards + `[loaded]` flag |
| 6 | MTPLX | Detected via the `capability` field on `/v1/models` entries (still generic if a build omits it on chat entries) |

All enrichment is silent best-effort (404/connection refusal/timeout leaves the
catalogue untouched) and is covered by `enrichment.test.ts` (local HTTP fixtures).

## Remaining gaps (next tuning candidates, ranked)

| # | Provider | Gap | What's available but unused |
| --- | --- | --- | --- |
| 2 | vLLM | `/v1/models` has no context info → 128000 fallback | server was started with `--max-model-len`; some builds expose `/get_model_info` (verify at runtime); top-level `reasoning_effort` + `--reasoning-parser` thinking could be detected/advertised |
| 5 | LM Studio | `/v1/models` has no context info → 128000 fallback | native REST API (`/api/v0/...`) lists loaded models with context; chat completions explicitly accept `top_k` + `repeat_penalty` |
| 7 | mlx-lm | No detection signal, zero metadata | needs a **manual server-type field** in the TUI (would also help Jan/LocalAI/KoboldCpp/TGI) |
| 8 | SGLang | thinking via `chat_template_kwargs` + `--reasoning-parser` not advertised | map `reasoning_content` support per parser like oMLX's Qwen special-case (TUI toggle) |
| 9 | Ollama | OpenAI layer still blocks `top_k`/`min_p`/repeat penalty (documented) | **native `/api/chat`** accepts all of them in `options` — a backend migration, not a config flip |
| 10 | llama.cpp | multi-model router: `GET /models` (unloaded models, per-model `status.args`) not probed | the shapes are already parsed when a router forwards them through `/v1/models` |

## Conventions used in the per-provider docs

- **Detection** — how the plugin identifies the server today and what to add
- **Model discovery** — every endpoint that reports models/metadata, with the exact JSON
  shapes the plugin can consume
- **Inference** — supported request fields for chat completions, with the plugin-relevant
  subset called out (sampling, thinking, vision, tools)
- **Gaps** — concrete, verifiable tuning work items

Raw research material (full upstream READMEs, API docs) is in
`.planning/providers-research/` in this repo's working tree.

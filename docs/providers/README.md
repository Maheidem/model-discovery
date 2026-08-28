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
| llama.cpp (`llama-server`) | 8080 | [llama-cpp.md](llama-cpp.md) | ✅ detected, partially exploited |
| vLLM | 8000 | [vllm.md](vllm.md) | ✅ detected, metadata gap |
| Ollama | 11434 | [ollama.md](ollama.md) | ✅ detected, sampling gap |
| LM Studio | 1234 | [lm-studio.md](lm-studio.md) | ✅ detected, metadata gap |
| oMLX | 8000 | [omlx.md](omlx.md) | ✅ best-supported (own server) |
| MTPLX | 8000 | [mtplx.md](mtplx.md) | ⚠️ undetected (falls back to generic) |
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
   - model ids containing `:` → Ollama
   - else `OpenAI-compatible`
3. **Extract per-model config** (first value found wins):
   - context window: `context_length` → `context_window` → `max_model_len` →
     `max_context_len` → `max_context_length` → `status.args --ctx-size` →
     `status.preset ctx-size` → `meta.n_ctx` → source default → 128000
   - max output: `max_tokens` → `max_output_tokens` → `max_completion_tokens` →
     `status.args --n-predict` → source default → 16384
   - reasoning: `capabilities` incl. `reasoning` → `reasoning` field →
     `--reasoning-budget` ≠ 0 → (oMLX only) Qwen-name heuristic
   - vision: `architecture.input_modalities` → vision architecture keys
     (`vision_config`, `vision_model`, `mm_proj`, `multi_modal_projector`) →
     `--mmproj`/`--vision` args or preset name → oMLX `capabilities`
4. **Register with Pi** with per-model `compat`:
   - llama.cpp / oMLX / Ollama: `supportsDeveloperRole: false`
   - oMLX: `thinkingFormat: "qwen-chat-template"`, `supportsReasoningEffort: true`
5. **Profiles** (0.6.0): named thinking/sampling bundles; wire key for repetition penalty
   is chosen by server type (`repeat_penalty` for llama.cpp/LM Studio,
   `repetition_penalty` for oMLX/vLLM/SGLang, best-effort for Ollama/generic).

## Gap summary (tuning opportunities, ranked)

| # | Provider | Gap | What's available but unused |
| --- | --- | --- | --- |
| 1 | llama.cpp | Single-model `/v1/models` carries **no context info** — plugin silently falls back to 128000 | `GET /props` exposes `default_generation_settings.n_ctx`, full sampling params, `modalities.vision`, `chat_template`; multi-model router exposes `GET /models` (the `status.args` / `architecture` shapes the plugin already parses!) |
| 2 | vLLM | `/v1/models` has no context info → 128000 fallback | server was started with `--max-model-len`; some builds expose `/get_model_info` (verify at runtime); top-level `reasoning_effort` + `--reasoning-parser` thinking could be detected/advertised |
| 3 | oMLX | `/v1/models/status` gives per-model `max_context_window`, `max_tokens`, load status — unused | also `/v1/models/{id}/load\|unload`, `/api/status`, model downloader; per-model `capabilities` already used |
| 4 | Ollama | OpenAI layer supports only `top_p`, `frequency/presence penalty`, no `top_k`/`min_p`/repeat penalty (known, documented in README) | **native API** (`/api/show`, `/api/tags`, `/api/ps`) reports context length, parameter defaults, loaded models — far richer discovery surface |
| 5 | LM Studio | `/v1/models` has no context info → 128000 fallback | native REST API (`/api/v0/...`) lists loaded models with context; chat completions explicitly accept `top_k` + `repeat_penalty` |
| 6 | MTPLX | No detection signal → "OpenAI-compatible" | `/v1/models?capability=...` returns `capability` field; `/health`, `/metrics` exist; sampler surface = `temperature`, `top_p`, `top_k`, penalties |
| 7 | mlx-lm | No detection signal, zero metadata in `/v1/models` | only `--model` CLI arg; would need heuristic (e.g. single model + `created` epoch + no other signals) or a user-supplied type hint |
| 8 | SGLang | thinking via `chat_template_kwargs` + `--reasoning-parser` not advertised | could map `reasoning_content` support per parser like oMLX's Qwen special-case |
| 9 | all | `discover_models` tool and scan share `fetchModels`; a richer probe (props/status/native endpoints) would need to be optional per detected type | — |

## Conventions used in the per-provider docs

- **Detection** — how the plugin identifies the server today and what to add
- **Model discovery** — every endpoint that reports models/metadata, with the exact JSON
  shapes the plugin can consume
- **Inference** — supported request fields for chat completions, with the plugin-relevant
  subset called out (sampling, thinking, vision, tools)
- **Gaps** — concrete, verifiable tuning work items

Raw research material (full upstream READMEs, API docs) is in
`.planning/providers-research/` in this repo's working tree.

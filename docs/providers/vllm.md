# vLLM

- **Source:** docs.vllm.ai — "OpenAI-Compatible Server" (latest, researched 2026-08-28)
- **Default port:** 8000 (`vllm serve <model>`) · GPU-first (CUDA/ROCm/XPU), datacenter scale
- **The most OpenAI-faithful local server** — also the one local users run for big models

## Detection

- `Server` header contains `vllm` → `"vLLM"` (works today)
- `owned_by: "vllm"` fallback on `/v1/models` (works today)

## Model discovery

### `GET /v1/models`

Standard OpenAI shape — `id` (served model name), `object`, `created`, `owned_by`.
**No context window, no modality info.** The plugin falls back to the 128000 default.

- Context is a **server-startup** value (`--max-model-len`), not per-model metadata.
- Some builds expose a non-OpenAI `/get_model_info` endpoint (legacy; reports
  `max_model_len`, etc.) — **verify at runtime before relying on it.**
- **Gap #2.**

### Other discovery/ops endpoints (OpenAI-compat layer)

`/v1/completions`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/audio/...` (TTS on
supported builds), `/v1/score`, `/v1/tokenize`, `/v1/detokenize`. The exact supported set
varies by version — the docs list them under "Supported APIs".

## Inference

### `POST /v1/chat/completions`

- Full OpenAI parameter set **except** `user` (ignored) and `image_url.detail` (unsupported)
- Vision **and audio** input supported (multimodal models)
- `parallel_tool_calls: false` → at most one tool call per response (default `true`)
- Extra sampling parameters (all accepted at top level):

| Field | Notes |
| --- | --- |
| `top_k` | int |
| `min_p` | float — **plugin's minP maps directly** |
| `repetition_penalty` | float — **plugin's wire key for vLLM is correct** |
| `seed`, `stop`, `ignore_eos` | |
| `logprobs`, `top_logprobs`, `logprob_token_ids` | |
| `bad_words` | `[]` default |
| `vllm_xargs` | free-form dict passthrough |
| `structured_outputs` | schema-constrained generation |
| `guided_decoding` | legacy name for the above |

### `POST /v1/completions`

Same extras; **`suffix` not supported** (llama.cpp and Ollama support it).

### Reasoning models

- Server flag: `--reasoning-parser <name>` (e.g. `qwen3`, `deepseek_r1`, …) → the response
  gets `message.reasoning_content` / `delta.reasoning_content`
- Top-level **`reasoning_effort`** is supported (maps to the template)
- The parser must match the model family — mismatched parser = garbled reasoning split

## Gaps / tuning work

1. **Context window**: try `GET /get_model_info` (if present) for `max_model_len`;
   otherwise keep 128000 fallback + TUI override. vLLM users typically know their
   `--max-model-len`, so the existing per-model override covers it.
2. **Thinking**: when the probe detects `reasoning_content` support (or the user toggles it),
   set `supportsReasoningEffort: true` like oMLX — but only *after* verifying the parser is
   configured (an unconfigured parser returns raw text).
3. Sampling surface is the richest of the bunch (`min_p`, `top_k`, `repetition_penalty`,
   `bad_words`) — the plugin's profile fields map 1:1, no work needed.

# mlx-lm (official MLX server)

- **Source:** ml-explore/mlx-lm — `mlx_lm/server.py` source, main branch (researched 2026-08-28)
- **Command:** `mlx_lm.server --model <hf-repo-or-path> [--port 8080]`
- Apple's **official** MLX inference CLI + minimal HTTP server — stdlib `http.server`,
  no FastAPI, no dependencies beyond mlx-lm itself
- The reference point for the whole MLX ecosystem (oMLX and MTPLX are both "mlx-lm, but
  faster / more features")

## Detection

- **No reliable signal.** No documented `Server` header, no `owned_by` in `/v1/models`
  entries, no extra endpoints that identify it. → classified `OpenAI-compatible`.
  **Gap #7.**
- Possible (unreliable) heuristics: single model entry whose `id` is an HF repo id or a
  local path **and** the response has a `created` field but no `owned_by`, no
  `max_model_len`. Fragile — better: let the user pick the type in the TUI if
  auto-detection says generic.

## Model discovery

### `GET /v1/models`

```json
{ "object": "list", "data": [
  { "id": "<hf repo id>", "object": "model", "created": <epoch> },        // each downloaded MLX model in the HF cache
  { "id": "<absolute path of --model>", "object": "model", "created": <epoch> }
] }
```

- Built by scanning the HF cache for repos containing `config.json`,
  `model.safetensors.index.json`, `tokenizer_config.json` (+ the `--model` target)
- **That's all the metadata** — no `owned_by`, no context, no capabilities, no modality
- `GET /health` → `{"status": "ok"}` (also usable as a liveness probe)

## Inference

### `POST /v1/chat/completions` and `POST /v1/completions`

Request fields (from the `GenerationArguments` / `CompletionRequest` dataclasses in
`server.py`):

| Group | Fields |
| --- | --- |
| message | `prompt` (text) or `messages` (chat) + `tools` + `role_mapping` |
| sampling | `temperature`, `top_p`, `top_k`, `min_p`, `xtc_probability`, `xtc_threshold` |
| logits | `logit_bias`, `repetition_penalty` (+ `repetition_context_size`), `presence_penalty` (+ `presence_context_size`), `frequency_penalty` (+ `frequency_context_size`) |
| control | `stop_words`, `max_tokens`, `num_draft_tokens` (speculative), `logprobs`, `top_logprobs`, `seed` |
| template | **`chat_template_kwargs`** — jinja vars (same mechanism as llama.cpp/SGLang) |

Notes:
- **`min_p` is first-class** here (rare among local servers — matches the plugin's
  `minP` field)
- **No `max_output_tokens` alias** — use `max_tokens`
- No image input (text-only), no embeddings, no Anthropic layer
- Streaming supported; tool calling via jinja template + `tools`

## Gaps / tuning work

1. **Detection**: none possible reliably — document in the TUI that mlx-lm servers appear
   as "OpenAI-compatible" and the user can set type manually (a feature that would also
   help other generic servers).
2. **Sampling surface is actually good**: `top_k`, `min_p`, `repetition_penalty` (use the
   generic best-effort key), `seed`, `xtc_*` — the existing profile fields all map.
3. **Context window**: never reported → 128000 fallback; MLX context is whatever the
   model was started with (mlx-lm has no `--ctx` flag in the server; context is the
   model's max or set in the chat call's KV budget — verify at runtime).
4. `num_draft_tokens` (speculative decoding with a draft model) is an interesting future
   profile field but out of scope now.

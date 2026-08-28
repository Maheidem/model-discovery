# Ollama

- **Source:** docs.ollama.com (OpenAI compatibility + API reference; ollama/ollama `docs/api.md` from main)
- **Default port:** 11434 · the most-installed local LLM manager; models as `name:tag`

## Detection

- `Server` header contains `ollama` → `"Ollama"` (works today)
- Model ids containing `:` (e.g. `llama3.2:8b`) → Ollama fallback (works today — this is
  also why MTPLX's `?capability=` entries with `capability` fields won't false-positive:
  they have no `:` in the id unless the repo id does)

## Model discovery

### OpenAI layer: `GET /v1/models` and `GET /v1/models/{model}`

- `created` = when the model was **last modified** (not created)
- `owned_by` = the ollama username that created it, defaulting to `"library"`
- **No context window, no modality info** in the OpenAI layer

### Native API (the richer surface — currently unused by the plugin)

Base `http://localhost:11434` (no `/v1`):

| Endpoint | Value for discovery |
| --- | --- |
| `GET /api/tags` | all local models: `name`, `size`, `modified_at`, **`details`** (`family`, `parameter_size`, `quantization_level`, `context_length`, `embedding_length`) |
| `GET /api/show` (POST, `{model}`) | full model card: Modelfile params incl. **`num_ctx` default**, template, adapters |
| `GET /api/ps` | **currently loaded** models with VRAM size, context, expiry |
| `GET /api/version` | client/server version |
| `POST /api/generate`, `POST /api/chat` | per-request `options` (any sampler incl. `num_ctx`, `top_k`, `min_p`, `repeat_penalty`) |
| `POST /api/create` | build models from Modelfiles (the documented way to change context size) |

`/api/tags` → `details.context_length` is a clean context signal, and `details.family`
doubles as a reasoning/VLM hint (e.g. `qwen3` families are thinking models). **Gap #4.**

## Inference — OpenAI layer

### `POST /v1/chat/completions` (documented support matrix)

| | |
| --- | --- |
| ✅ | chat, streaming, JSON mode (`response_format`), reproducible outputs (`seed`), **vision** (base64 images + `content` parts array; **image URLs not supported**), tools, **thinking control** |
| ❌ | logprobs, `tool_choice`, `logit_bias`, `user`, `n` |

Supported request fields: `model`, `messages` (text + base64 image + parts),
`frequency_penalty`, `presence_penalty`, `response_format`, `seed`, `stop`, `stream`,
`stream_options.include_usage`, `temperature`, `top_p`, `max_tokens`, `tools`,
`reasoning_effort` (`"high"|"medium"|"low"|"max"|"none"`), `reasoning.effort` (same values).

### ⚠️ Sampling — the known gap (already documented in the README)

The OpenAI-compat layer **does not accept** `top_k`, `min_p`, or a repetition-penalty field.
The plugin must therefore **omit** those profile keys on Ollama (it does this via the
`repetitionPenaltyKeyForServer` + omission logic). The *native* `/api/chat` does accept all
of them in `options` — switching Ollama inference from the OpenAI layer to the native API
would unlock the full sampler, but changes the request/response contract (native returns
`message.content`, different usage shape) — a real migration, not a config flip.

### `POST /v1/completions`

`prompt` (string only) + `frequency_penalty`, `presence_penalty`, `seed`, `stop`, `stream`,
`stream_options`, `temperature`, `top_p`, `max_tokens`, `suffix`.

### `POST /v1/embeddings`

`input` (string | string[]), `encoding_format`, `dimensions`. (No token-array inputs.)

### `POST /v1/responses` (v0.13.3+)

Non-stateful only (no `previous_response_id`/`conversation`). Supports streaming, tools,
reasoning summaries.

## Context size — the special case

The OpenAI API has no context parameter; Ollama's documented approach is a **Modelfile**:

```dockerfile
FROM <some model>
PARAMETER num_ctx <context size>
```

then `ollama create mymodel -f Modelfile`. The plugin can't do this — but `/api/show` /
`/api/tags` *can read* the effective `num_ctx` for display, and the TUI override covers
per-request max-tokens (Ollama clamps generation to its `num_predict` param).

## Thinking models

- `gpt-oss` (120B/20B) and Qwen3 families: the OpenAI layer exposes `reasoning_effort`
  (`none` disables; `high/medium/low/max`)
- Native layer: `think` bool + `/no_think` template suffix (template-level)
- Reasoning tokens appear in `reasoning` / `reasoning_content` depending on layer;
  usage gets `reasoning_tokens`

## Gaps / tuning work

> **Status 0.7.0:** `/api/tags` + `/api/ps` are now probed (enrichment) — default context
> from model cards and the `[loaded]` flag.

1. If `reasoning_effort` is probed working (or family indicates a thinking model), set
   `reasoning: true` + `supportsReasoningEffort: true`.
2. Optional future: native `/api/chat` backend for full-sampler profiles (large change).

# LM Studio

- **Source:** lmstudio.ai/docs — "OpenAI Compatibility Endpoints" (developer/openai-compat/*, researched 2026-08-28)
- **Default port:** 1234 (`lms server start` / Developer tab) · macOS/Windows/Linux desktop app
- GGUF + MLX models, Just-In-Time loading, no install step for users

## Detection

- `Server` header contains `lm-studio` / `lm studio` / `lmstudio` → `"LM Studio"` (works today)

## Model discovery

### `GET /v1/models`

- Returns **models visible to the server** — with Just-In-Time loading enabled this is
  *all downloaded models*, not just the loaded one (unlike llama.cpp's single entry)
- Standard OpenAI shape — **no context window, no modality info.** 128000 fallback.
- **Gap #5.**

### Native REST API (unused by the plugin)

LM Studio's newer `lms` native API (docs: `lmstudio.ai/docs/developer/rest`) has
`/api/v0/models` etc. and is the recommended interface for stateful chats and MCP. It can
report loaded models with context — a candidate probe for this server type.

## Inference

### `POST /v1/chat/completions`

Prompt template is applied automatically for chat-tuned models. **Documented supported
payload parameters** (this list is authoritative for LM Studio, not the generic OpenAI set):

```text
model, top_p, top_k, messages, temperature, max_tokens, stream, stop,
presence_penalty, frequency_penalty, logit_bias, repeat_penalty, seed
```

Notes:
- **`top_k` and `repeat_penalty` are explicitly supported** — the plugin's
  `repetitionPenaltyKeyForServer` already picks `repeat_penalty` for LM Studio. ✅
- No documented `min_p` → profiles should omit it (currently the plugin sends it;
  LM Studio likely ignores unknown fields, but the docs list is the safe contract).
- **Text and images** in chat (images documented under the endpoint group)
- `lms log stream` shows the model's actual input — useful when debugging profile payloads

### Other OpenAI-compatible endpoints

`POST /v1/completions` (legacy), `POST /v1/embeddings`, `POST /v1/responses`
(stateful responses — this is what Codex uses; supports prior-response state and remote
MCP tools), structured outputs, tool use (`tools` array).

## Gaps / tuning work

1. **Context window**: probe the native `lms` API (e.g. `GET /api/v0/models`) when the
   header identifies LM Studio; otherwise keep the TUI override path.
2. Trim the profile sampler for LM Studio to the documented list (drop `min_p` if we want
   a strict contract — verify whether it is silently ignored first).
3. `supportedDeveloperRole: false` is already set (correct: LM Studio's llama.cpp/MLX
   backends don't implement the `developer` role).
4. No thinking-format special-casing exists for LM Studio today; GGUF Qwen models loaded
   there accept the same `chat_template_kwargs` as llama.cpp — a natural extension if
   `/api/v0` exposes the chat template.

# SGLang

- **Source:** docs.sglang.io — "OpenAI APIs: Completions" + "Reasoning Parser" (researched 2026-08-28)
- **Default port:** 30000 (`python -m sglang.srt.entrypoints.openai`) · GPU-first, prefix
  caching, speculative decoding, multimodal
- High-performance serving framework (LMSYS); also runnable inside LocalAI

## Detection

- `Server` header contains `sglang` → `"SGLang"` (works today)

## Model discovery

- Standard OpenAI `/v1/models` shape — **no context metadata** (context is set at server
  start via `--context-length` / `max_model_len`). 128000 fallback + TUI override.
- Vision models are served the same way (Llava, Qwen2.5-VL, Gemma3, Llama 3.2-VL per the
  vision docs) — no modality metadata in `/v1/models`, so VLM status needs a TUI toggle
  or a user override (same situation as vLLM).

## Inference

### `POST /v1/chat/completions`

Accepts the standard OpenAI Chat Completions parameters, extended via **`extra_body`**
(top-level fields work too; `extra_body` is the OpenAI-client idiom):

| Field | Notes |
| --- | --- |
| `chat_template_kwargs` | **the main reasoning knob** — args passed to the chat-template processor, e.g. `{"enable_thinking": false}` for Qwen3 |
| `separate_reasoning` | `true` (default when a parser is set) → `reasoning_content` / `content` split; `false` → raw output |
| `stream_reasoning` | `false` to buffer reasoning in streaming mode |
| `return_meta_info`, `return_logprob`, `top_logprobs` | |
| `top_k`, `min_p`, `max_new_tokens`, `repetition_penalty`, `presence_penalty`, `frequency_penalty` | native sampling params (all accept top-level or `extra_body`) |
| `logit_bias` | `-100…100`, token-id keys — **supported** (vLLM/oMLX omit it) |
| `structured_outputs` | JSON / regex / **EBNF** |
| `min_new_tokens` | |
| LoRA | `model: "base-model:adapter-name"` syntax |

### `POST /v1/completions`

Same extension surface (logit bias documented for both).

### Other endpoints

`/v1/embeddings` (embedding models), vision chat (same `/v1/chat/completions` with image
parts), tool calling via native function-call parsers.

## Reasoning — the parser model

Server flag **`--reasoning-parser <name>`** selects the tag parser; then the API splits
reasoning into `message.reasoning_content` (non-stream) / `delta.reasoning_content`
(streaming). Supported models & parsers (from the docs table):

| Model family | Parser | Thinking toggle |
| --- | --- | --- |
| DeepSeek-R1 (R1, R1-0528, R1-Distill, V3.1, …) | `deepseek_r1` | — |
| Qwen3 / Qwen3-Thinking | `qwen3` | `chat_template_kwargs.enable_thinking` (`false` off) |
| Gemma 4 | `gemma4` | — |
| Apertus 2509 | `apertus2509` | `enable_thinking` param |
| …more in the upstream table | | |

**Thinking is on/off via `chat_template_kwargs`** — exactly the mechanism the plugin's
profile `chatTemplateKwargs` already stores. The oMLX Qwen special-case
(`thinkingFormat: "qwen-chat-template"`) has a direct SGLang analogue.

## Gaps / tuning work

1. **Thinking detection**: SGLang models with a configured parser are reasoning-capable —
   but the plugin can't see the parser config from `/v1/models`. Options: (a) user toggle
   in the TUI (like the oMLX Qwen heuristic), (b) probe a tiny completion and inspect for
   `reasoning_content`. Both are cheap; (a) is safer.
2. When toggled on, set `supportsReasoningEffort: true` + the Qwen-style
   `chat_template_kwargs` profile support (the storage already exists; only the
   server-type special-case is missing, mirroring `omlx.md`).
3. **`logit_bias`** is supported — could unlock a future "token bias" profile field.
4. Sampling: `min_p`, `top_k`, `repetition_penalty` all first-class — plugin mapping is
   already correct for SGLang. ✅
5. Context window: no runtime metadata — keep fallback + override.

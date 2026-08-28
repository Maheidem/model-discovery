# MTPLX

- **Source:** youssofal/MTPLX — README (main, researched 2026-08-28) + project site mtplx.com
- **Default port:** 8000 (`mtplx serve --port 8000`, binds `127.0.0.1`) · macOS 14+, Apple
  Silicon (M1+) · Python (MLX-native) + native Mac app
- **The differentiator: native MTP speculative decoding** — uses the model's own built-in
  Multi-Token-Prediction heads (Qwen 3.5/3.6/3.8, Gemma 4) with *exact* rejection sampling
  (Leviathan–Chen + residual correction), so `temperature=0.6, top_p=0.95` produces the
  same distribution as plain decoding — just ~1.6×–2.2× faster. No second draft model.

## What it is (and isn't)

- Not an external-drafter system (the drafter is the target model's own MTP heads)
- Not a greedy-argmax trick (exact rejection sampling, correct at any temperature)
- Not CUDA — MLX-native, Apple Silicon first (for Linux: vLLM)
- App + CLI share one server; `mtplx start` attaches to the app's running model
- Warm-prefix session bank + default-on SSD session cache (disable with
  `--ssd-session-cache off`) → multi-turn chats stay fast across restarts

## Detection

- **No known `Server` header / `owned_by` signal documented** → the plugin currently
  classifies it as generic `OpenAI-compatible`. **Gap #6.**
- Candidate signals to verify at runtime:
  - `GET /health` response shape
  - `GET /v1/models?capability=embedding|rerank` — entries carry a **`capability` field**
    (chat entries presumably `chat` or absent) — a distinctive, low-cost probe
  - `GET /metrics` presence

## Model discovery

### `GET /v1/models`

- **Chat models only by default** (so chat clients never offer an embedder as a
  conversation target). Retrieval models are listed via
  `?capability=embedding` / `?capability=rerank`; every entry carries `capability`.
- A chat completion that requests a retrieval model id gets a **clear 400**, not a
  silent answer from the chat model
- Served model ids: the served model name (the README's curl example uses `"model":"mtplx"`)
- No context-window metadata documented → 128000 fallback + TUI override

### Other endpoints

| Endpoint | Notes |
| --- | --- |
| `GET /health` | liveness |
| `GET /metrics` | Prometheus-style metrics (acceptance rate by draft depth, verify waterfall, cache state, system pressure — surfaced in the app dashboard) |
| `POST /v1/embeddings` | optional; only when `--embedding-model` configured |
| `POST /v1/rerank` | optional; jina-style `{query, documents}`; only when `--reranker-model` configured |
| `POST /v1/messages` | **Anthropic-compatible** (streaming, tool calls in both styles) |

Multiple retrieval models can be served at once (flags repeat); listing the same ref as
both embedder and reranker loads one copy. Retrieval models load on first request, capped
by `--retrieval-max-resident` (default 2, LRU). Checkpoints bundling Python code (some jina
MLX releases) are refused with 403 until `--retrieval-trust-remote-code`.

## Inference

### `POST /v1/chat/completions` + `POST /v1/completions`

- Streaming, tool calls (OpenAI + Anthropic styles)
- **Sampler controls (documented surface):** `temperature`, `top_p`, `top_k`,
  `presence_penalty`, `frequency_penalty`
  - per request, **or** as server defaults (`--default-presence-penalty` /
    `--default-frequency-penalty`), **or** live via `mtplx settings set` + the app's
    Presence-Penalty dial
  - penalties default to **0** — an exact no-op that preserves MTP exactness
  - Qwen guidance from the project: leave at 0 for coding/agent work; ~0.5–1.5 presence
    penalty for creative writing or self-looping
- **Not documented** (→ omit in profiles, or verify at runtime): `min_p`,
  `repetition_penalty`, `top_k` bounds, `seed`, thinking parameters
- Thinking: the app's chat shows "thinking cards", but the README documents **no
  API-level thinking/reasoning control** — verify whether `chat_template_kwargs` or
  `reasoning_effort` pass through before enabling profiles

## Gaps / tuning work

1. **Detection**: probe `GET /v1/models?capability=chat` (or plain `/v1/models`) and
   treat a `capability` field on entries as an MTPLX signal; optionally confirm with
   `/metrics`. Adds a proper `serverType` so the right wire keys/compat apply.
2. **Wire keys**: with type known, decide the repetition-penalty key (currently
   "best-effort" for generic) — test whether MTPLX accepts `repetition_penalty`.
3. **Sampler profile**: the documented surface is narrow (`temperature`, `top_p`, `top_k`,
   two penalties). The TUI's profile editor could dim `min_p`/`repetitionPenalty` for
   MTPLX sources (like the Ollama case) once detection lands.
4. **No context metadata** — keep the 128000 fallback; MTPLX's own context handling is
   internal (Sustained mode does chunked prefill up to 16K–200K).
5. Embeddings/rerank are out of scope for this plugin (it manages chat models) but the
   `capability` probe is a free byproduct.

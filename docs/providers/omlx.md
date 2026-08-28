# oMLX

- **Source:** jundot/omlx (omlx.ai) — README + `omlx/server.py` source, main branch (researched 2026-08-28)
- **Default port:** 8000 · macOS 15+, Apple Silicon · native (Rust/Swift) MLX server
- **The server this plugin was built around** — the most feature-complete local server

## Detection

- `Server` header contains `omlx`, or `X-Powered-By: omlx` (works today)
- `owned_by: "omlx"` fallback on `/v1/models` (works today)

## Architecture (why it differs from the others)

- **Multi-model serving** with LRU memory management; a model's "id" can be a *display
  alias* (`model_alias`) that differs from the physical repo/path id
- **Continuous batching**, paged KV cache, prefix sharing, **tiered KV cache** (hot RAM +
  cold SSD) — past context survives unloads
- Per-model settings (sampling, context policy, visibility, favorites) in a settings
  manager; an admin dashboard (web UI) manages them
- Supports LLMs, **VLMs**, embeddings, and rerankers; MCP tool support; built-in chat UI
- API key: optional (server-wide `verify_api_key` dependency)

## Model discovery

### `GET /v1/models` (what the plugin probes)

```json
{ "object": "list", "data": [{
  "id": "<display alias or physical id>",
  "object": "model",
  "owned_by": "omlx",
  "max_model_len": 131072        // ← the plugin already reads this for context
}]}
```

- Includes **exposed profile models** (oMLX's own per-model variants) and the `markitdown`
  helper model when enabled
- Favorites are sorted first; hidden models and (optionally) helper drafters are omitted
- `max_model_len` comes from `get_max_context_window()` — see below
- ⚠️ No `capabilities`/`reasoning` fields on this minimal shape — the plugin's
  capabilities-based vision/reasoning detection relies on the *detailed* model objects
  oMLX exposes elsewhere (and on the `architecture`/`capabilities` fields its full
  status payloads carry)

### `GET /v1/models/status` (detailed — **unused by the plugin**, Gap #3)

Per model:

```json
{
  "id": "...",
  "max_context_window": 131072,   // effective context (3-tier resolution, below)
  "max_tokens": 8192,             // effective max output (per-model > global default)
  "model_alias": "...",
  "is_favorite": true,
  "is_hidden": false
  // + engine-pool status fields: load state, memory usage, etc.
}
```

Context resolution in oMLX (from `get_max_context_window`, source-verified):
1. **per-model override** (admin UI / settings) — always wins
2. **model-config-discovered native context**, optionally clamped by the operator's
   `max_context_window_policy`
3. fallback default from global `SamplingSettings.max_context_window` (historical 32768)

### Management endpoints (all useful for future "Re-scan"/"Load" TUI actions)

| Endpoint | Action |
| --- | --- |
| `GET /health` | liveness |
| `GET /api/status` | server-level status (engine pool, memory tiers) |
| `POST /v1/models/{model_id}/load` | load into memory (blocks until done) |
| `POST /v1/models/{model_id}/unload` | unload from memory |
| (download flow) | model downloader with `_refresh_models_after_download` |

## Inference

### `POST /v1/chat/completions`

- OpenAI-compatible + `chat_template_kwargs` — the plugin's profile `chatTemplateKwargs`
  maps directly: `enable_thinking`, `reasoning_effort` (`low`/`medium`/`xhigh`),
  `preserve_thinking`
- **Per-model settings** apply server-side (sampling defaults, context) — profiles still
  override per request
- Tool calling + structured output (documented feature)
- VLMs: image input (see the VLM section in the main README for detection)
- **Anthropic-compatible `POST /v1/messages`** also served

### Sampling

Full set including `temperature`, `top_p`, `top_k`, `min_p`, penalties — the plugin's
`repetition_penalty` wire key is correct for oMLX. ✅

## Gaps / tuning work

1. **Read `/v1/models/status`** (this is the single highest-value change): get the
   *effective* `max_context_window` and `max_tokens` instead of only `max_model_len`,
   plus load state for the `[loaded]`-style flag and per-model `max_tokens` override.
2. **Load/unload actions** in the TUI (map to the existing "Re-scan" flow or a new
   "Manage models" section).
3. The `max_context_window_policy` concept suggests a **source-level "context policy"**
   setting in the plugin (clamp discovered contexts to N) — oMLX does this per-model;
   we could mirror it at source level.
4. Favorites: `/v1/models/status` exposes `is_favorite` — could sort or badge them in
   the TUI model list.

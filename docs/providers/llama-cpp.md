# llama.cpp (`llama-server`)

- **Source:** ggml-org/llama.cpp — `tools/server/README.md` (master, researched 2026-08-28)
- **Default port:** 8080 · single-binary, single or multi-model (router) server
- **Best local-LLM backend on every OS** — the baseline for the plugin

## Detection

- `Server` header contains `llama-cpp` / `llama.cpp` → `"llama.cpp"` (works today)
- `owned_by: "llamacpp"` fallback on `/v1/models` entries (works today)
- MTPLX/Jan are also llama.cpp-based but don't set the header (see [mtplx.md](mtplx.md), [other.md](other.md))

## Model discovery

### `GET /v1/models` (OpenAI layer — what the plugin probes)

```json
{ "object": "list", "data": [{
  "id": "../models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",   // file path unless --alias
  "object": "model", "created": 1735142223, "owned_by": "llamacpp",
  "meta": { "vocab_type": 2, "n_vocab": 128256, "n_ctx_train": 131072,
            "n_embd": 4096, "n_params": 8030261312, "size": 4912898304 }
}]}
```

- Always **one element** on a single-model server. `meta` can be `null` while loading.
- ⚠️ **No runtime context length.** `meta.n_ctx_train` is the *training* context, not the
  server's `--ctx-size` — the plugin correctly does not read it. Result: context window
  falls back to the 128000 default. **Gap #1.**

### `GET /props` (native, read-only by default)

Rich server-global state the plugin ignores today:

```json
{
  "default_generation_settings": {
    "n_ctx": 1024,
    "params": { "n_predict": -1, "temperature": 0.8, "top_k": 40, "top_p": 0.95,
                "min_p": 0.05, "typical_p": 1.0, "repeat_penalty": 1.0,
                "presence_penalty": 0.0, "frequency_penalty": 0.0,
                "mirostat": 0, "dynatemp_range": 0.0, "xtc_probability": 0.0,
                "samplers": ["dry","top_k","typ_p","top_p","min_p","xtc","temperature"] }
  },
  "model_path": "...gguf",
  "chat_template": "...",            // the model's Jinja2 template
  "chat_template_caps": {},
  "modalities": { "vision": false }, // authoritative VLM flag
  "total_slots": 1, "is_sleeping": false
}
```

- `n_ctx` here is the **real** runtime context → fixes Gap #1 for single-model servers.
- `modalities.vision` is a more reliable VLM signal than `--mmproj` sniffing.
- `chat_template_caps` can indicate thinking support (see `common/jinja/caps.h` upstream).

### `GET /models` (native, multi-model router)

```json
{ "data": [{
  "id": "ggml-org/gemma-3-4b-it-GGUF:Q4_K_M",
  "path": "/.../gemma.gguf",
  "status": { "value": "loaded|unloaded|loading|sleeping",
              "args": ["llama-server", "-ctx", "4096"], "failed": false, "exit_code": 0 },
  "architecture": { "input_modalities": ["text","image"], "output_modalities": ["text"] }
}]}
```

- **This is the shape the plugin already parses** (`status.args`, `architecture.input_modalities`,
  `status.value` → `[loaded]` flag). It only gets it when a router's `/v1/models` forwards
  these fields; a plain single-model server's `/v1/models` does not.
- `?reload=1` refreshes from sources; `POST /models/load`, `POST /models/unload`,
  `GET /models/sse` (events), `POST /models` (download from source), `DELETE /models`.

### Other native endpoints

`/health`, `/completion`, `/tokenize`, `/detokenize`, `/apply-template`, `/embedding`,
`/reranking`, `/infill`, `/embeddings`, `GET /slots` (per-slot state & metrics),
`/slots/{id}?action=save|restore|erase`, `/metrics` (Prometheus),
`/lora-adapters` (GET/POST), `POST /props` (writes; needs `--props` flag).

## Inference

### `POST /v1/chat/completions`

Standard OpenAI params **plus llama.cpp extensions**:

| Field | Notes |
| --- | --- |
| `chat_template_kwargs` | Extra jinja vars, e.g. `{"enable_thinking": false}` — **thinking on/off knob** |
| `reasoning_effort` | `"none"` disables reasoning; otherwise the value is exposed to the jinja template |
| `reasoning_format` | `"none"` → raw generated text (no parse) |
| `reasoning_control` | Arm realtime early-termination via `/v1/chat/completions/control` |
| `parse_tool_calls` / `parallel_tool_calls` | jinja-template-driven tool call parsing |
| `mirostat`, `mirostat_tau`, `mirostat_eta`, `dynatemp_*`, `typical_p`, `xtc_*` | native samplers beyond OpenAI's set |
| `image_url` | remote URL, base64 (raw or `data:` URI), or **local file path** |
| `input_audio` | `data` or `url`; mp3/wav/flac |
| `response_format` | plain JSON + **schema-constrained JSON** (`json_schema`) |

### `POST /v1/completions` — same sampler extras; `POST /v1/responses` (OpenAI Responses)
and **`POST /v1/messages` (Anthropic-compatible)** + `/v1/messages/count_tokens` also exist.

Token counting: `POST /v1/chat/completions/input_tokens`, `POST /v1/responses/input_tokens`.

## Thinking & sampling surface (for profiles)

- Sampling params available beyond the plugin's current set: `typical_p`, `xtc_probability`,
  `xtc_threshold`, `mirostat*`, `dynatemp_*` — all accepted by `/completion` and the
  OpenAI layer forwards native names.
- Thinking: `chat_template_kwargs.enable_thinking` + `reasoning_effort` (template-dependent).
  The plugin's generic `chatTemplateKwargs` storage already supports this; the opportunity is
  **auto-detecting** which templates accept it via `chat_template_caps` from `/props`.

## Gaps / tuning work

> **Status 0.7.0:** `/props` is now probed (enrichment) — runtime `n_ctx` and
> `modalities.vision` feed the context/vision detection chains.

1. **Router mode**: probe `GET /models` for the full catalogue (unloaded models visible,
   per-model `status.args` already parsed).
2. Consider `GET /health` for the re-scan "last success" UX and `/metrics` for a future
   "is it actually busy" indicator.
3. Keep the existing `repeat_penalty` wire key (llama.cpp expects `repeat_penalty`).

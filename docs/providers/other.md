# Other local providers

Secondary candidates — documented briefly for detection/compat decisions. Researched
2026-08-28 from official docs/repos.

## LocalAI (mudler/LocalAI)

- **Port:** 8080 · Docker-first, multi-backend (llama.cpp, vLLM, SGLang, transformers,
  vllm.cpp, …) behind one OpenAI-compatible facade
- **Docs:** localai.io/docs/features
- **Detection:** no documented `Server` header → generic. `/v1/models` lists *configured*
  models (name from YAML, not the backend's)
- **Endpoints:** full OpenAI set + **`POST /v1/messages` (Anthropic)** + **`POST
  /v1/responses` (OpenResponses spec)** — background processing, `reasoning: {effort,
  summary}`, `previous_response_id` chaining, cancellation. The widest endpoint surface of
  any local server.
- **Sampling:** chat accepts `top_p`, `top_k`, `max_tokens` (plus OpenAI core fields)
- **Reasoning:** reasoning models return thinking in a **`reasoning` field** (not
  `reasoning_content` — different wire name!), with interleaved thinking + tool calls
  documented separately
- **Gaps:** context from model YAML only; no runtime metadata. If we add LocalAI support,
  the `reasoning` field name is the main compat concern.

## KoboldCpp (LostRuins/koboldcpp)

- **Port:** 5001 · single-binary, GGUF, CPU/GPU; SillyTavern's engine
- **Docs:** lite.koboldai.net/koboldcpp_api (OpenAPI 3.0)
- **Detection:** no `Server` header → generic
- **OpenAI layer:** `/v1/chat/completions`, `/v1/completions`, `/v1/responses`
  (experimental — "not recommended"), `/v1/models`, `/v1/audio/*` (Whisper TTS/STT),
  `/v1/embeddings`, `/v1/messages` (Anthropic)
- **Native (rich discovery!):**
  - `GET /api/v1/model` — current model name
  - `GET /api/v1/config/max_context_length` — **effective** context length
  - `GET /api/extra/true_max_context_length` — actual context from the launcher
  - `GET /api/extra/perf` — recent performance info
  - `GET /props` — the Jinja template stored in the GGUF (same as llama.cpp)
  - `POST /api/extra/tokencount`, `/api/extra/abort`, `/api/extra/last_logprobs`
- **Gaps:** the context endpoints are a clean signal if we add a "KoboldCpp" type;
  everything else is standard.

## Jan (janhq/jan)

- **Port:** 1337 (default), host/port/prefix all configurable · llama.cpp backend,
  desktop app (macOS/Windows/Linux)
- **Docs:** jan.ai/docs/desktop/api-server
- **Detection:** no documented `Server` header → generic
- **Auth:** optional Bearer key (user-set); CORS on by default; trusted-hosts list
- **API:** standard OpenAI `/v1/*` (chat, completions, models, embeddings, audio); MCP
  tool execution can be server-side ("Execute Tools on Server" toggle)
- **Gaps:** llama.cpp under the hood — `/props` *may* exist depending on the embedded
  version (verify at runtime). Otherwise treat as generic + user type hint.

## TGI (Hugging Face text-generation-inference)

- **Port:** 3000 · Rust/Python/gRPC server; powers HF Inference Endpoints
- **Docs:** huggingface.co/docs/text-generation-inference
- **Detection:** no `Server` header → generic
- **API:** OpenAI **`/v1/chat/completions`** (since 1.4.0 — the only OpenAI endpoint) +
  the custom API (huggingface.github.io/text-generation-inference) with `/generate`,
  `/invoke`, `/tokenize`, `/health`, `/info`, etc.
- **Gaps:** `/info` may expose model/endpoint metadata (verify at runtime). Low local
  prevalence (mostly cloud) — deprioritize.

## mlx-openai-server (cubist38)

- **Port:** 8000 (default) · FastAPI, MLX; Apple Silicon
- **Docs:** github.com/cubist38/mlx-openai-server
- Serves **text, multimodal (vision), audio, image generation, embeddings, Whisper**
  through OpenAI endpoints — the most feature-spread MLX server
- **Detection:** no documented `Server` header → generic
- **Gaps:** vision is a selling point but undetectable from `/v1/models`; user toggle.

---

## Cross-provider notes for the plugin

1. **A manual "server type" field** in the TUI (default: auto-detect) would close the
   detection gaps for MTPLX, mlx-lm, Jan, LocalAI, KoboldCpp, TGI in one feature.
2. **Optional per-type probe endpoints** (props/tags/status/models) are all
   *additive* — the existing `/v1/models` hard-fail stays; richer probes run only after
   the type is known and must degrade silently.
3. **Wire-key table** (repetition penalty) currently: llama.cpp/LM Studio →
   `repeat_penalty`; oMLX/vLLM/SGLang → `repetition_penalty`; Ollama/generic →
   best-effort `repetition_penalty`. MLX (mlx-lm) and LocalAI need deciding
   (mlx-lm: `repetition_penalty`; LocalAI: backend-dependent → keep generic).
4. **Reasoning field names in the wild:** `reasoning_content` (vLLM/SGLang/oMLX),
   `reasoning` (Ollama, LocalAI), `reasoning_effort` request param (Ollama/vLLM),
   `chat_template_kwargs` (llama.cpp/SGLang/mlx-lm). The plugin's `compat.thinkingFormat`
   is the right abstraction to keep extending per type.

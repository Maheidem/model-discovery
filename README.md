# @maheidem/model-discovery

Interactive TUI for discovering and managing local AI model endpoints. Works with llama.cpp, oMLX, Ollama, vLLM, SGLang, LM Studio, and other OpenAI-compatible servers.

## Features

- **Auto-detect server type** from headers and model data
- **Read server-reported configuration** — context window, max tokens, reasoning, and vision, with per-model overrides on top
- **Auto-detect vision-capable models (VLMs)** — from architecture metadata, llama.cpp `--mmproj` args, or oMLX capabilities
- **Auto-detect reasoning capability** — from `capabilities`, explicit `reasoning` fields, `--reasoning-budget`, and Qwen model names on oMLX
- **Auto-detect reasoning format** — oMLX servers get `chat_template_kwargs` thinking support automatically
- **Per-model compatibility** — `supportsDeveloperRole: false` for llama.cpp, oMLX, and Ollama; Qwen thinking format for oMLX
- **Fine-tune per-model overrides** — context window, max output, reasoning, and vision support
- **Profile-routed native thinking levels** — Shift-Tab can select complete thinking and sampling presets
- **Named model presets** — reuse complete thinking/sampling bundles as fixed aliases or adaptive routes
- **Offline management** — retain the last successful server catalogue for configuration and startup fallback
- **Authenticated endpoints** — enroll, replace, validate, or clear bearer API keys through masked TUI input
- **Multi-endpoint management** — add, rename, scan, and remove local model sources
- **LLM-callable tool** — the `discover_models` tool can register endpoints on the agent's behalf
- **Persistent storage** in `~/.pi/agent/model-discovery.json`

## Installation

```bash
# Via npm
pi install npm:@maheidem/model-discovery

# Via git
pi install git:github.com/Maheidem/model-discovery@v0.6.1
```

## Usage

Run `/discover` in Pi to open the management TUI:

- **Add endpoint** — enter a URL, choose anonymous or API-key authentication, probe it, review models, and register
- **Re-scan** — refresh models reported by an existing endpoint
- **Edit model** — override context, max output, reasoning, or vision support
- **Manage profiles** — create, edit, rename, or delete named variants
- **Rename source** — change the provider name shown by `/model`
- **Remove** — unregister and delete an endpoint

You can jump directly into adding an endpoint:

```text
/discover http://192.168.1.100:8080
```

Enrollment explicitly asks whether the endpoint is anonymous or requires an API key. API-key input is masked and is sent as `Authorization: Bearer <key>` for both `/v1/models` discovery and inference. The key is stored unencrypted in `~/.pi/agent/model-discovery.json`; the extension writes that file atomically with owner-only (`0600`) permissions. Use **Authentication** on an existing endpoint to replace, validate, or clear its key without losing the cached catalogue.

The LLM-callable tool remains available:

```text
discover_models(url="http://192.168.1.100:8080", providerName="my-llama")
```

The tool also accepts `apiKey`, but literal tool arguments may be retained in the agent session. Prefer the masked `/discover` flow for secrets.

## How model settings are detected

Every field is read from what the server actually reports, first value found wins:

- **Context window** — `context_length` → `context_window` → `max_model_len` → `max_context_len` → `max_context_length` → llama.cpp `--ctx-size` (args or preset) → `meta.n_ctx` for loaded models → the source's default context window → `128000`
- **Max output tokens** — `max_tokens` → `max_output_tokens` → `max_completion_tokens` → llama.cpp `--n-predict` → the source's default → `16384`
- **Reasoning** — `capabilities` containing `reasoning` → an explicit `reasoning` field → llama.cpp `--reasoning-budget` ≠ 0 → Qwen model names on oMLX (when the server reports nothing)
- **Vision** — `architecture.input_modalities` (vLLM, SGLang), vision-specific architecture keys (`vision_config`, `vision_model`, `mm_proj`, `multi_modal_projector`), llama.cpp `--mmproj`/`--vision` args or a preset name mentioning mmproj/vision, and oMLX `capabilities` containing `vision`, `image`, or `multimodal`

Detected vision-capable models get `input: ["text", "image"]`, so Pi accepts image input for them. The source defaults and every detection can be corrected per model with **Edit model**.

### Compatibility settings

The extension attaches `compat` to each registered model (Pi does not merge provider-level compat into individual models):

- llama.cpp, oMLX, Ollama: `supportsDeveloperRole: false`
- oMLX: `thinkingFormat: "qwen-chat-template"` and `supportsReasoningEffort: true` for base models; fixed and adaptive profile aliases carry their own complete `chat_template_kwargs` independently

### Model list display

Each model shows `ctx <window> · max <tokens> · <source>`, where source is `server args` for a live llama.cpp process and `api` for other backends. Flags: `[vision]`, `[reasoning]`, `[reasoning?]` (undetermined and not overridden), `[loaded]` (llama.cpp, currently in memory), and `(edited)` when overrides are present.

## Native thinking levels

For reasoning-capable Qwen models on oMLX, the base model and sampling-only profiles translate Pi's native Shift-Tab level into request-scoped `chat_template_kwargs`:

| Pi level | `enable_thinking` | Qwen `reasoning_effort` |
| --- | --- | --- |
| `off` | `false` | omitted |
| `minimal`, `low` | `true` | `low` |
| `medium` | `true` | `medium` |
| `high`, `xhigh`, `max` | `true` | `xhigh` |

`preserve_thinking` remains `true`. Fixed-thinking profiles intentionally stay locked to their configured state or effort, while profiles containing only sampling values inherit native Shift-Tab behavior.

### Explicit complete-profile routing

Adaptive routing is opt-in and separate from ordinary presets. Creating presets never changes the base model or another alias. In **Thinking & presets**, configure an adaptive alias and explicitly choose a preset for every Pi level. The conventional four-preset helper expands this layout:

| Pi level | Selected preset |
| --- | --- |
| `off` | instruct/off preset |
| `minimal`, `low` | low preset |
| `medium` | medium preset |
| `high`, `xhigh`, `max` | xhigh preset |

The adaptive alias replaces all profile-controlled sampling fields and `chat_template_kwargs` on every request while retaining the same physical server model and conversation. Multiple presets may use the same reasoning effort because the mapping chooses by preset name rather than inference. The base model, sampling-only aliases, and fixed aliases retain their own behavior.

The TUI supports cloning presets, hiding preset aliases from `/model`, editing individual level mappings, previewing exact request payloads, disabling routing while preserving its map, and removing the adaptive alias without deleting presets. The footer shows `preset: <slug>` for an adaptive alias and `fixed preset: <slug>` for a fixed alias.

Example persisted routing:

```json
{
  "modelProfileRouting": {
    "Qwen3.8-27B": {
      "enabled": true,
      "aliasSlug": "thinking",
      "levels": {
        "off": "instruct",
        "minimal": "thinking-low",
        "low": "thinking-low",
        "medium": "thinking-medium",
        "high": "thinking-xhigh",
        "xhigh": "thinking-xhigh",
        "max": "thinking-xhigh"
      }
    }
  }
}
```

## Named profiles

Presets with `exposeAsModel` omitted or `true` appear as fixed models under the same provider. Set `exposeAsModel: false` to keep a preset available to adaptive routing without cluttering `/model`. Given a server model named `Qwen3.8-27B` and a visible preset named `xhigh`, `/model` shows both:

```text
Qwen3.8-27B
Qwen3.8-27B@xhigh
```

The profile request still targets the real server model. For example:

```json
{
  "modelProfiles": {
    "Qwen3.8-27B": [
      {
        "slug": "xhigh",
        "chatTemplateKwargs": {
          "enable_thinking": true,
          "reasoning_effort": "xhigh",
          "preserve_thinking": false
        },
        "exposeAsModel": false,
        "sampling": {
          "temperature": 0.7,
          "topP": 0.9,
          "topK": 20,
          "minP": 0.05,
          "repetitionPenalty": 1.05,
          "presencePenalty": 0,
          "frequencyPenalty": 0
        }
      }
    ]
  }
}
```

Supported thinking values are:

- `enable_thinking`: `true` or `false`
- `reasoning_effort`: `"low"`, `"medium"`, or `"xhigh"`
- `preserve_thinking`: `true` or `false`

Supported sampling values are:

- `temperature`: `0–2`; `0` is greedy
- `topP`: `0–1`; `1` disables top-p filtering
- `topK`: integer `>= 0`; omit it to keep the backend-specific default
- `minP`: `0–1`; `0` disables min-p filtering
- `repetitionPenalty`: `> 0`; `1` disables it
- `presencePenalty`: `-2–2`; `0` disables it
- `frequencyPenalty`: `-2–2`; `0` disables it

The extension translates these backend-neutral storage names to top-level request fields such as `top_p`, `top_k`, `min_p`, `presence_penalty`, and `frequency_penalty`. Repetition penalty is sent as:

- `repeat_penalty` for llama.cpp and LM Studio
- `repetition_penalty` for oMLX, vLLM, and SGLang
- `repetition_penalty` as a best-effort fallback for Ollama and unknown OpenAI-compatible servers

A configured value is sent exactly. Fixed thinking values take precedence over Pi's current `/think` level, while fixed sampling values take precedence over Pi/request defaults. When every thinking value is omitted, the profile inherits the base model's native Shift-Tab behavior; when any thinking value is configured, only that profile's configured thinking keys are sent. Omitted sampling keys are not sent, leaving them to the server/model default. Profiles may contain thinking values, sampling values, or both. The base model remains independently selectable.

Sampling support still depends on the target server. In particular, Ollama's current OpenAI-compatible chat endpoint does not expose `top_k`, `min_p`, or a dedicated repetition-penalty field and may ignore those fallback keys. Omit unsupported controls to retain that backend's defaults.

If Pi has an `enabledModels` scope, press **Tab** in `/model` to switch from scoped models to all models, or add the profile alias to `enabledModels`.

Profiles are retained if a model temporarily disappears during a re-scan.

## Offline resilience

Every successful live scan atomically persists the raw model catalogue as the source's last known-good cache. Saved sources are scanned independently and concurrently at startup. If one source is offline, times out, rejects its credentials, or returns a malformed response:

- its cached base models, fixed aliases, and adaptive aliases remain registered;
- its overrides, presets, and routing remain editable through `/discover`;
- a failed or empty response never replaces the last known-good cache;
- the TUI shows the latest failure and time of the last successful scan; and
- other healthy sources continue loading normally.

`Re-scan all` does not unregister a provider before a replacement catalogue has been validated. A source with no previous successful scan is reported as unavailable without affecting any other source. The cache preserves discovery and configuration during an outage; actual inference still requires the model source to become reachable again.

Legacy implicit routing created by early v0.6 development builds is migrated once: its sampling-only adaptive alias becomes an explicit router with the same model ID, and its concrete presets are retained. Future presets never activate routing implicitly.

## Storage

Discovered providers, cached catalogues, model overrides, presets, and explicit routing maps are persisted in:

```text
~/.pi/agent/model-discovery.json
```

## Requirements

- Pi coding agent **0.84.0 or newer** (`samplingParams` support is required for model aliases)
- TUI support
- Network access to an OpenAI-compatible model server

## Development

```bash
npm test
```

## License

MIT

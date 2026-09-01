# @maheidem/model-discovery

A responsive, hierarchical Pi wizard for discovering and managing local AI model sources. It works with llama.cpp, oMLX, Ollama, vLLM, SGLang, LM Studio, and other OpenAI-compatible servers, with useful status and diagnostics in TUI, RPC, JSON, and print modes.

## Features

- **Auto-detect server type** from headers and model data (incl. MTPLX's `capability` field)
- **Read server-reported configuration** — context window, max tokens, reasoning, and vision, with per-model overrides on top
- **Native-endpoint enrichment** — llama.cpp `/props`, oMLX `/v1/models/status`, and Ollama `/api/tags` + `/api/ps` fill in what the OpenAI layer omits (real context windows, load state, VLM flags), silently best-effort
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
- **Shared Pi UX** — responsive bordered wizard steps, searchable lists, injected keybindings, scrolling previews, cancellable loaders, and masked secrets
- **Headless command surface** — stable status, diagnostics, paths, source listing, and explicit add/remove actions for RPC and scripts
- **Persistent storage** in `~/.pi/agent/model-discovery.json`

## Installation

```bash
# Via npm
pi install npm:@maheidem/model-discovery

# Via git
pi install git:github.com/Maheidem/model-discovery
```

## Usage

Run bare `/discover` in TUI mode to open the source wizard:

```text
Sources → source details → model details → presets and adaptive routing
        ↘ add / scan / authentication / diagnostics
```

The home screen shows source and cached-model health before offering the primary actions. Every list supports Pi's configured navigation/confirm/cancel bindings and type-to-filter. Escape returns to the logical parent. Long diagnostics and exact-request previews use a scrolling secondary view rather than clipping the footer.

From the wizard you can:

- **Add source** — enter a URL, choose anonymous or API-key authentication, probe it, review models, and register
- **Re-scan** — refresh one source or every source while retaining last known-good catalogues on failure
- **Edit model** — override context, max output, reasoning, or vision support
- **Manage presets** — create, clone, edit, rename, preview, route, or delete named variants
- **Rename source** — change the provider name shown by `/model`
- **Authentication** — add, replace, validate, or clear a bearer credential through masked input
- **Diagnostics** — inspect storage, source health, authentication state, and cached catalogue state without exposing secrets
- **Remove source** — unregister it and delete its saved configuration after confirmation

The same root command has a scriptable surface. Bare `/discover` prints status outside TUI instead of silently doing nothing:

```text
/discover
/discover status
/discover doctor
/discover paths
/discover source list
/discover source add http://192.168.1.100:8080
/discover source add http://192.168.1.100:8080 --name my-llama
/discover source remove my-llama --yes
/discover help
```

The original direct-add shorthand remains compatible:

```text
/discover http://192.168.1.100:8080
```

In TUI mode, add commands enter the full enrollment wizard. Outside TUI, source add probes and registers an anonymous source using server-reported/default values. Configure credentials through the masked TUI rather than command arguments. Source removal requires confirmation in TUI and requires explicit `--yes` outside TUI.

Enrollment explicitly asks whether the source is anonymous or requires an API key. API-key input is masked and is sent as `Authorization: Bearer <key>` for both `/v1/models` discovery and inference. The key is stored unencrypted in `~/.pi/agent/model-discovery.json`; the extension writes that file atomically with owner-only (`0600`) permissions. Use **Authentication** on an existing source to replace, validate, or clear its key without losing the cached catalogue.

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

### Native-endpoint enrichment

For server types that expose richer *native* (non-OpenAI) endpoints, the probe runs one best-effort enrichment pass after the catalogue fetch, filling only what `/v1/models` omitted — explicit values always win:

- **llama.cpp** — `GET /props`: the real runtime context window (`default_generation_settings.n_ctx`) and the authoritative VLM flag (`modalities.vision`)
- **oMLX** — `GET /v1/models/status`: the effective per-model context window, max output tokens, load state (drives the `[loaded]` flag), and a thinking-capable default
- **Ollama** — `GET /api/tags` + `GET /api/ps`: the model card's default context length and which models are currently loaded

Enrichment is silent best-effort: a missing or failing native endpoint (or a connection refusal) leaves the catalogue exactly as the OpenAI layer reported it, and the cached catalogue retains the last known-good enrichment for offline fallback.

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

## Tool-schema repair (local endpoints)

llama.cpp's JSON-schema→grammar converter — the one behind llama.cpp, llama-swap, LM
Studio, and LiteLLM routes that forward to them — resolves `$ref` pointers **only
against the root of a tool schema document**. MCP servers that build schemas by nesting
Pydantic `model_json_schema()` output inside a hand-written parent routinely leave
`$defs` on an inner node while the `$ref`s inside it stay root-relative:

```jsonc
{ "properties": { "patch": {
    "$defs": { "GuidelineMetricInput": { /* ... */ } },        // defs live here
    "properties": { "metrics": { "items": { "$ref": "#/$defs/GuidelineMetricInput" } } }
}}}
```

The pointer resolves against the document root, where `$defs` is not — so the server
rejects the **entire request**:

```text
HTTP 400 {"code":400,"message":"JSON schema conversion failed:
          Error resolving ref #/$defs/GuidelineMetricInput: $defs not in {...}"}
```

Because the offending tool rides along in every tool list, *every* message in the
session fails, which looks like a broken endpoint, proxy, or model discovery rather
than a bad upstream schema.

A second llama.cpp b10612 bug was verified independently: `maxLength: 2000` below
an array's `items` schema produces `Failed to initialize samplers: failed to parse
grammar`, while 1999, 2001, and even 65536 all compile. This affected the
`okto_pulse_move_card` tool even before any `$ref` repair.

For self-hosted endpoints (private/loopback URL, or a detected local engine) the
extension normalises outgoing tool schemas in `before_provider_request`:

- `$defs` / `definitions` found at any depth are hoisted to a root registry, with
collisions de-duplicated and local refs rewritten to match;
- every `$ref` is inlined iteratively, so refs-to-refs collapse;
- unresolvable or recursive `$ref`s become permissive nodes instead of a hard 400;
- `$ref` / `$defs` never reach the wire, and annotation siblings (`description`,
`title`) are preserved;
- the exact nested-array `maxLength: 2000` failure is sent as 2001. This is the
least-permissive working neighbour; the MCP server still validates its real 2000 limit.

Cloud APIs and clean payloads are left byte-identical (the payload object's identity is
returned, no cloning). Repairing a 521-tool catalogue costs ~1.5 ms. Opt out per
provider with `"repairToolSchemas": false` in `~/.pi/agent/model-discovery.json`, or
globally with `PI_MODEL_DISCOVERY_NO_SCHEMA_REPAIR=1`. Each distinct repair is logged
once as `[model-discovery] <provider>: repaired N local tool schema(s): …`.

Live verification against llama-swap v251 → llama.cpp b10612: the raw 521-tool MCP
catalogue returned HTTP 400; all 16 affected schemas were repaired in flight; the same
request then returned HTTP 200 with no residual `$ref`/`$defs` on the wire.

Verification:

```bash
npm test                                              # includes schema-repair.test.ts
node --experimental-strip-types scripts/live-schema-repair-check.ts http://HOST
node --experimental-strip-types scripts/bisect-grammar.ts http://HOST MODEL FILTER
```

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

Discovered providers, cached catalogues, model overrides, presets, credentials, and explicit routing maps are persisted atomically with owner-only (`0600`) permissions in:

```text
~/.pi/agent/model-discovery.json
```

If this JSON is corrupt, startup falls back to an empty source list and preserves the unreadable file beside it as `model-discovery.json.corrupt-<timestamp>` instead of overwriting the evidence. Existing profile-routing schema migrations remain automatic.

## Requirements

- Pi coding agent **0.84.0 or newer** (`samplingParams` support is required for model aliases)
- TUI mode for interactive enrollment, masked credentials, and profile editing
- Network access to an OpenAI-compatible model server for live discovery (cached status/configuration remains available offline)

## Development

All suites run with isolated temporary `HOME` directories:

```bash
npm run typecheck
npm test
npm pack --dry-run
```

`prepack` runs strict typechecking and the complete offline suite automatically. Provider detection, enrichment, profile semantics, routing, schema repair, storage, application actions, responsive wizard components, command modes, and adapter registration all have regression coverage.

## License

MIT

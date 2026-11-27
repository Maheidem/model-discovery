# @maheidem/model-discovery

A panel-based Pi control surface for discovering and managing local AI model sources. It works with llama.cpp, oMLX, Ollama, vLLM, SGLang, LM Studio, and other OpenAI-compatible servers, with useful status and diagnostics in TUI, RPC, JSON, and print modes.

## Install

```bash
# Via npm
pi install npm:@maheidem/model-discovery

# Via git
pi install git:github.com/Maheidem/model-discovery
```

## Features

- **Auto-detect server type** from headers and model data (incl. MTPLX's `capability` field)
- **Read server-reported configuration** — context window, max tokens, reasoning, and vision, with per-model overrides on top
- **Native-endpoint enrichment** — llama.cpp `/props`, oMLX `/v1/models/status`, and Ollama `/api/tags` + `/api/ps` fill in what the OpenAI layer omits (real context windows, load state, VLM flags, thinking controls), silently best-effort
- **Auto-detect vision-capable models (VLMs)** — from architecture metadata, llama.cpp `--mmproj` args, oMLX `model_type` or capabilities, then the family file
- **Thinking profile of each model** — the server report or the family file says which thinking values a model accepts. The extension sends only those values
- **Model families** — nine bundled families give the recommended thinking values and sampling values. The family data gets updates with no new package version
- **Recommended defaults** — a base model of a known family sends the recommended values at each pi thinking level, with no stored preset
- **Fine-tune per-model overrides** — context window, max output, reasoning, vision, family, recommended defaults and hidden state
- **Named model presets** — reuse complete thinking/sampling bundles as fixed aliases or as an adaptive alias that follows Shift-Tab
- **Hidden non-chat models** — embedding, speech and reranker models stay out of `/model` by default
- **Offline management** — retain the last successful server catalogue for configuration and startup fallback
- **Authenticated endpoints** — enroll, replace, validate, or clear bearer API keys through masked TUI input
- **Multi-endpoint management** — add, rename, scan, and remove local model sources
- **LLM-callable tool** — the `discover_models` tool can register endpoints on the agent's behalf
- **Shared Pi UX** — one centralized home dashboard plus fixed-height secondary panels (`SettingsPanel` from `@maheidem/pi-panel-kit`), fixed-frame rendering that can never smear the composer, injected keybindings, searchable windows, cancellable loaders, and masked secrets
- **Headless command surface** — every panel mutation has a nested `/discover` verb with identical semantics (panel ≡ command ≡ headless); stable status, diagnostics, paths, and explicit add/remove actions for RPC and scripts
- **Persistent storage** in `~/.pi/agent/model-discovery.json`

## Terminal UI

`/discover` opens one centralized home dashboard (`SettingsPanel` from `@maheidem/pi-panel-kit`) with a live health summary, fixed 23-row frames everywhere, and one surface at a time — the composer/input bar never moves or smears.

| Surface | Open | Contents |
| --- | --- | --- |
| Home dashboard | `/discover` | version header, per-source health rows, scan status, actions (add, presets, routing, rescan, doctor, configure advanced…) |
| Source panel | pick a source | live scan header, rename, masked API key entry (validate-and-revalidate), fallback ctx/max, per-model overrides, arm-then-confirm remove |
| Model panel | model row | the value in use and its source for each field; reasoning, vision, recommended defaults, family and hidden rows; presets and routing entries |
| Presets / routing | presets · routing rows | draft-until-save editor; "Customize recommended presets"; "Map presets by kind" across the seven Pi thinking levels |
| Advanced hub | `Configure advanced…` | re-scan all, family data update, diagnostics, storage path, command reference, per-source config entries |
| Tool cards | `discover_models` | neutral per-state cards: `✓ registered`, `⊘ online · no models`, `✗ failed` — plus the next action |

Parity rules (enforced by `tests/ui-parity.test.ts`): every panel row key maps to a nested `/discover` verb and an application method; secrets are accepted **only** through the masked field or `--key-from-env`, never inline; destructive rows require two presses in TUI and `--yes` headless; failure severity is read from authoritative `isError` flags, never from message text.

## Usage

Run bare `/discover` in TUI mode to open the home dashboard:

```text
Sources → source details → model details → presets and adaptive routing
        ↘ add / scan / authentication / diagnostics
```

The home screen shows source and cached-model health before offering the primary actions. Every list supports Pi's configured navigation/confirm/cancel bindings and type-to-filter. Escape returns to the logical parent. Long diagnostics use a scrolling secondary view rather than clipping the footer.

From the dashboard you can:

- **Add source** — enter a URL, choose anonymous or API-key authentication, probe it, review models, and register
- **Re-scan** — refresh one source or every source while retaining last known-good catalogues on failure
- **Edit model** — override context, max output, reasoning, vision, family, recommended defaults or hidden state
- **Manage presets** — create, clone, edit, rename, route, or delete named variants, or copy the recommended presets
- **Rename source** — change the provider name shown by `/model`
- **Authentication** — add, replace, validate, or clear a bearer credential through masked input
- **Diagnostics** — inspect storage, source health, authentication state, and cached catalogue state without exposing secrets
- **Remove source** — unregister it and delete its saved configuration after confirmation

The same root command has a scriptable surface. Bare `/discover` prints status outside TUI instead of silently doing nothing:

```text
/discover                          open the home dashboard (status outside TUI)
/discover <url>                    add a source (shorthand for source add)
/discover status                   show source and catalogue health
/discover doctor                   show actionable diagnostics
/discover rescan-all               refetch + re-register every source
/discover families update          get new model family data and register every source again
/discover paths                    show the configuration path
/discover help                     show the command reference

/discover source list
/discover source add <url> [--name <name>]
/discover source open <name>
/discover source rename <old> <new>
/discover source auth <name> --key-from-env ENV
/discover source auth <name>
/discover source defaults <name> ctx <n> [max <n>]
/discover source rescan <name>
/discover source remove <name> [--yes]

/discover model <id> vision on|off|auto
/discover model <id> reasoning on|off|auto
/discover model <id> ctx <n>
/discover model <id> max <n>
/discover model <id> defaults on|off
/discover model <id> family <family>|auto|none
/discover model <id> hidden on|off

/discover preset set <source> <modelId> <slug> <field> <value>
/discover preset remove <source> <modelId> <slug> [--yes]
/discover preset defaults <source> <modelId> [--yes]
/discover routing set <source> <modelId> <level> <slug>
/discover routing conventional <source> <modelId>
/discover routing remove <source> <modelId> [--yes]
```

Notes:

- Add `--source <name>` to a `model` verb when the model id is on more than one source.
- `auto` deletes the stored value of `vision` or `reasoning`. The server value or the family value applies again.
- `source open` and `source auth <name>` with no flag need the TUI.
- `source defaults` also accepts `max <n>` alone.
- `preset set` accepts these fields: `enable_thinking`, `reasoning_effort`, `preserve_thinking`, `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`, `presence_penalty`, `frequency_penalty`. A new preset is hidden from `/model`.
- `preset defaults` needs `--yes` outside the TUI when it replaces a stored preset.
- `routing conventional` is the verb of the row "Map presets by kind". `/discover help` does not list it.

Examples:

```text
/discover source add http://localhost:8080 --name my-llama
/discover source auth my-llama --key-from-env LLAMA_API_KEY
/discover source defaults my-llama ctx 131072 max 16384
/discover model qwen3.8-27b vision auto
/discover model qwen3.8-27b defaults off --source my-llama
/discover model my-finetune family qwen3.8
/discover model embeddinggemma-2 hidden off
/discover preset defaults my-llama qwen3.8-27b
/discover preset set my-llama qwen3.8-27b focused temperature 0.3
/discover routing set my-llama qwen3.8-27b medium focused
```

The direct-add shorthand takes a URL only:

```text
/discover http://localhost:8080
```

In TUI mode, add commands enter the full enrollment flow (form → probe → review → register). Outside TUI, source add probes and registers an anonymous source using server-reported/default values. Credentials are configured through the masked panel field or `--key-from-env` — never as inline arguments. Destructive commands require confirmation in TUI and explicit `--yes` outside TUI.

Enrollment explicitly asks whether the source is anonymous or requires an API key. API-key input is masked and is sent as `Authorization: Bearer <key>` for both `/v1/models` discovery and inference. The key is stored unencrypted in `~/.pi/agent/model-discovery.json`; the extension writes that file atomically with owner-only (`0600`) permissions. Use **Authentication** on an existing source to replace, validate, or clear its key without losing the cached catalogue.

The LLM-callable tool remains available:

```text
discover_models(url="http://localhost:8080", providerName="my-llama")
```

The tool also accepts `apiKey`, but literal tool arguments may be retained in the agent session. Prefer the masked `/discover` flow for secrets.

## How model settings are decided

### Value order

The extension decides each model field in this order. The first value that exists wins.

| Field | Order |
| --- | --- |
| Context window | your setting → server report → source default → family file → `128000` |
| Max output tokens | your setting → server report → source default → `16384` |
| Reasoning | your setting → server thinking report → server reasoning field → family file → off |
| Image input | your setting → server report (yes or no) → family file → no |
| Thinking controls | server status report → chat template text → family file |

"Your setting" is a model override from **Edit model** or from a `/discover model` verb. The model panel shows the value in use and its source for each field.

### What the server report contains

The extension reads these fields from `/v1/models`. The first field that exists wins.

- **Context window** — `context_length` → `context_window` → `max_model_len` → `max_context_len` → `max_context_length` → llama.cpp `--ctx-size` (args or preset) → `meta.n_ctx` for loaded models → the native endpoint value
- **Max output tokens** — `max_tokens` → `max_output_tokens` → `max_completion_tokens` → llama.cpp `--n-predict` → the native endpoint value
- **Reasoning** — `capabilities` containing `reasoning` → an explicit `reasoning` field → llama.cpp `--reasoning-budget` ≠ 0 → oMLX `thinking_default: true`
- **Image input** — `architecture.input_modalities` (vLLM, SGLang), vision-specific architecture keys (`vision_config`, `vision_model`, `mm_proj`, `multi_modal_projector`), llama.cpp `--mmproj`/`--vision` args or a preset name mentioning mmproj/vision, `capabilities` containing `vision`, `image`, or `multimodal`, llama.cpp `/props` `modalities.vision`, and oMLX `model_type`

A model with image input gets `input: ["text", "image"]`, so Pi accepts image input for it.

### Native-endpoint enrichment

Some server types have native endpoints with more data. The probe reads them one time after the catalogue fetch. A value from `/v1/models` always wins.

- **llama.cpp** — `GET /props`: the runtime context window (`default_generation_settings.n_ctx`), the image input flag (`modalities.vision`) and the chat template text (`chat_template`)
- **oMLX** — `GET /v1/models/status`: the context window, the max output tokens, the load state, the model type (`model_type`) and the thinking report (`thinking_default`, `preserve_thinking_default`, `reasoning_efforts`)
- **Ollama** — `GET /api/tags` + `GET /api/ps`: the default context length of the model card and the loaded models

The llama.cpp `/props` answer is for one model. The extension applies it when the catalogue has one model, or when a model id is equal to `model_alias` or to the file name of `model_path`. A router answer (`role: "router"`) applies to no model.

A native endpoint that is missing or fails changes nothing. The cached catalogue keeps the last known-good enrichment for offline use.

### Capabilities

- Image input from the server has three states: yes, no and unknown. A server "no" wins over the family file. The family file decides only when the server says nothing.
- oMLX reports image input through `model_type`: `vlm` is yes and `llm` is no.
- The **Vision** and **Reasoning** rows and the `vision` and `reasoning` verbs accept `on`, `off` and `auto`. `auto` deletes your setting.
- A model that is not a chat model is hidden by default. Its kind is embedding, speech-to-text, text-to-speech, reranker or other. Pi does not register a hidden model.
- The server model type decides the kind. With no server value, the model name decides (for example `embed`, `rerank`, `asr`, `tts`).
- `/discover model <id> hidden off` or the row **Hidden from /model** registers a hidden model. `hidden on` hides a chat model.
- The **Family** row and `/discover model <id> family <family>` set the family of a model with an unclear name. `auto` finds the family from the name again. `none` gives the model no family.

### Compatibility settings

The extension attaches `compat` to each registered model, because Pi does not merge provider-level `compat` into models.

A model whose thinking values come from this extension gets `thinkingFormat: "chat-template"`, `chatTemplateKwargs: {}` and `supportsReasoningEffort: false`. Thus Pi adds no thinking field of its own, and the extension controls each thinking field of the request.

### Model list display

Each model row shows `ctx <window> · max <tokens> · <source>`. The source is `server args` for a live llama.cpp process and `api` for other servers. `(edited)` shows that the model has a setting of yours.

The flags are in one bracket after the model id, for example `[vision, reasoning, loaded]`:

- `vision`: the model accepts image input.
- `reasoning`: reasoning is on for the model.
- `loaded`: the server has the model in memory.

A hidden model shows `hidden (<kind>)`, for example `hidden (embedding)`. Hidden models are at the end of the list.

## Thinking levels

### Thinking profile

The thinking profile of a model is the set of thinking controls that its chat template accepts:

- the on/off switch `enable_thinking`;
- the effort names that the template reads from `reasoning_effort`;
- `preserve_thinking`.

The profile comes from the first source that has it:

1. The oMLX status report: `thinking_default`, `preserve_thinking_default` and `reasoning_efforts`.
2. The text of the chat template from llama.cpp `/props.chat_template`.
3. The family file.

The extension sends only the values that the model accepts. It does not send an effort name that the template does not know.

### Level map

Pi has seven thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. The effort scale is `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

| Model type | Level `off` | Each other level | Levels that Pi offers |
| --- | --- | --- | --- |
| Switch and efforts | `enable_thinking: false` | The effort with the same name if the model accepts it. If not, the nearest accepted effort. A tie goes to the higher effort. | all seven |
| Efforts, no switch | the lowest accepted effort | the same rule | all seven |
| Switch only | `enable_thinking: false` | `enable_thinking: true` | `off` and `high` |

`enable_thinking` is always sent when the template has the switch. `preserve_thinking: true` is sent only when the template reads it and the family permits it.

Worked examples:

| Pi level | Qwen 3.8 (switch; low, medium, xhigh) | Qwen 3.8 Flash (switch; low, medium, high, xhigh) | Inkling v1 (no switch; 6 efforts) | Inkling 2 (no switch; 7 efforts) | Switch only (Qwen 3.6, Gemma 4) |
| --- | --- | --- | --- | --- | --- |
| `off` | thinking off | thinking off | `none` | `none` | thinking off |
| `minimal` | `low` | `low` | `minimal` | `minimal` | thinking on (not offered) |
| `low` | `low` | `low` | `low` | `low` | thinking on (not offered) |
| `medium` | `medium` | `medium` | `medium` | `medium` | thinking on (not offered) |
| `high` | `xhigh` | `high` | `high` | `high` | thinking on |
| `xhigh` | `xhigh` | `xhigh` | `max` | `xhigh` | thinking on (not offered) |
| `max` | `xhigh` | `xhigh` | `max` | `max` | thinking on (not offered) |

### Model families

A family file holds the facts that a server does not always report: the thinking controls, the recommended sampling values and the fallback capabilities. The first family whose pattern matches the model id or the model name wins.

Nine families are bundled:

| Family id | Models |
| --- | --- |
| `qwen3.8` | Qwen 3.8 |
| `qwen3.6` | Qwen 3.6 |
| `qwen3.5-small` | Qwen 3.5 small (0.8B, 2B) |
| `qwen3.5` | Qwen 3.5 (4B and larger) |
| `qwen3` | Qwen 3 |
| `gemma4` | Gemma 4 |
| `inkling2-small` | Inkling 2 Small |
| `inkling2-mini` | Inkling 2 Mini |
| `inkling` | Inkling |

[docs/model-families.md](docs/model-families.md) gives the values of each family and the source of each value.

### Recommended defaults

A base model of a known family sends the recommended thinking values and sampling values at each Pi level. No stored preset is necessary. A model with a server thinking report and no family sends the thinking values only.

- The footer shows `defaults: <family> · <preset>`, for example `defaults: Qwen 3.8 · thinking-medium`.
- The row **Recommended defaults** or `/discover model <id> defaults off` turns the defaults off. The base model then sends the on/off switch only, with no effort and no sampling. A model with no switch then sends no thinking field.
- `/discover model <id> defaults on` turns the defaults on again.

Behaviour change from 0.10.0: the base Qwen 3.8 model on oMLX now sends `reasoning_effort` and sampling values. In 0.10.0 it sent the on/off switch only. Set `defaults off` to get the 0.10.0 behaviour.

### Customize the recommended presets

The recommended presets are not in your config. To edit them, copy them first:

- Use the row **Customize recommended presets** in **Thinking & presets**, or
- run `/discover preset defaults <source> <modelId>`.

The action does this:

1. It copies the recommended presets into the config. There is one preset for each different control of the level map: `instruct` (thinking off), `thinking-<effort>` and `thinking` (thinking on, no effort). Some families add `thinking-general`.
2. It hides the copied presets from `/model`.
3. It turns on the adaptive alias `<model>@adaptive`. A stored alias name stays.

A stored preset with the same name is replaced. The TUI asks for a second press. Outside the TUI, add `--yes`. Other stored presets stay.

## Presets and aliases

A preset is a named set of thinking values, sampling values, or both. Presets are stored for each base model. A preset never changes the base model or a different alias.

| Model type | Model id | What it sends |
| --- | --- | --- |
| Base model | `<model>` | The recommended defaults of each Pi level, or the switch only |
| Fixed alias | `<model>@<slug>` | The values of one visible preset |
| Adaptive alias | `<model>@<alias>` | At each Pi level, the values of the preset that you mapped to that level |

All three model types use one function to make the request fields. Thus the three send the same fields for the same preset. Pi merges the fields of the current thinking level into each request. Each alias request goes to the real server model.

- A fixed alias with thinking values offers one Pi level only, because its thinking state does not change.
- A fixed alias with only sampling values keeps the thinking behaviour of the base model at each level.
- The footer shows `preset: <slug>` for an adaptive alias and `fixed preset: <slug>` for a fixed alias.

### Adaptive routing

Adaptive routing is opt-in. In **Thinking & presets**, open **Adaptive routing** and select a preset for each of the seven Pi levels. `/discover routing set <source> <modelId> <level> <slug>` sets one level.

The row **Map presets by kind** (`/discover routing conventional`) fills all seven levels from the level map of the model. It needs exactly one preset for each kind that the level map uses. A preset kind is `off`, `on` or an effort name. For Qwen 3.8, the kinds are `off`, `low`, `medium` and `xhigh`:

| Pi level | Selected preset |
| --- | --- |
| `off` | the `off` preset |
| `minimal`, `low` | the `low` preset |
| `medium` | the `medium` preset |
| `high`, `xhigh`, `max` | the `xhigh` preset |

A model with only the switch needs one `off` preset and one `on` preset. If a kind has no preset or more than one preset, map the levels manually.

More than one preset can use the same effort when you map the levels manually, because the map selects a preset by name.

The TUI can also clone a preset, hide a fixed alias from `/model`, turn the routing off and keep its map, and remove the adaptive alias with no change to the presets.

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

### Fixed aliases

Presets with `exposeAsModel` omitted or `true` appear as fixed models under the same provider. Set `exposeAsModel: false` to keep a preset for the adaptive routing only. Given a server model named `Qwen3.8-27B` and a visible preset named `xhigh`, `/model` shows both:

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
- `reasoning_effort`: `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` or `"max"`
- `preserve_thinking`: `true` or `false`

The preset editor and `/discover preset set` accept only the values that the model accepts. For example, Qwen 3.8 accepts the efforts `low`, `medium` and `xhigh`.

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

A sampling value of a preset is sent as it is. A sampling key that the preset does not have is not sent, so the server default applies. A thinking value is sent only when the model accepts it.

- A preset with a thinking value sends only its own thinking keys. The Pi thinking level does not change them.
- A preset with no thinking value sends the thinking values of the base model for the current Pi level.
- A stored preset that is not valid stays in the file. It is not registered, and `/discover doctor` lists it.

### Servers

oMLX, llama.cpp, vLLM, SGLang and other OpenAI-compatible servers get the thinking values in `chat_template_kwargs`.

Ollama and LM Studio get a top-level `reasoning_effort` and no `chat_template_kwargs`. Thinking off is `reasoning_effort: "none"`. This path is not tested on a live Ollama server or a live LM Studio server.

Sampling support depends on the server. The OpenAI-compatible chat endpoint of Ollama does not have `top_k`, `min_p` or a repetition-penalty field, and can ignore those keys. Do not set a control that the server does not support.

If Pi has an `enabledModels` scope, press **Tab** in `/model` to switch from scoped models to all models, or add the profile alias to `enabledModels`.

Profiles are retained if a model temporarily disappears during a re-scan.

## Family data updates

The family data has two layers:

- The bundled files in `families/` of the package.
- The cache file `model-discovery-families.json` in the Pi agent directory, next to `model-discovery.json`.

The extension uses the cache only when it is valid and its `revision` is higher than the bundled `revision`.

- At each start, the extension reads new family data in the background. It does this at most one time each 24 hours. The start does not wait for it. New data applies at the next start or reload.
- The data comes from `https://raw.githubusercontent.com/Maheidem/model-discovery/main/families/`.
- `/discover families update` or the row **Update model family data** reads the data now. It then registers every source again from its cached catalogue.
- `PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE=1` turns the automatic read off. `/discover families update` still works.
- `PI_MODEL_DISCOVERY_FAMILIES_URL` sets a different base URL.
- A downloaded family file that fails validation is ignored. The bundled file with the same name replaces it. `/discover doctor` lists each rejected file.
- A failed download changes nothing.
- An index with an unknown `schemaVersion` is refused. A family file with an unknown key is rejected. Thus a new control type needs a new package release.

## Debug

Set `PI_MODEL_DISCOVERY_WIRE_LOG=<file>` to record what the extension sends. The extension appends one JSON line to the file for each request.

- The line has the time, the provider, the Pi model id, the thinking level, and the number of messages, images and tools.
- The field `request` holds the request body with no `messages` and no `tools`. It shows the server model, the sampling fields and the thinking fields.
- The line has no message text and no API key.

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

## Configuration

Discovered providers, cached catalogues, model overrides, presets, credentials, and explicit routing maps are persisted atomically with owner-only (`0600`) permissions in:

```text
~/.pi/agent/model-discovery.json
```

The extension builds this path from the pi agent dir (`getAgentDir()`), so the file moves with `PI_CODING_AGENT_DIR` when that variable is set. `/discover paths` prints the path in use. The code exports it as `CONFIG_PATH` from `extensions/config.ts`.

If this JSON is corrupt, startup falls back to an empty source list and preserves the unreadable file beside it as `model-discovery.json.corrupt-<timestamp>` instead of overwriting the evidence. Existing profile-routing schema migrations remain automatic.

## Requirements

- Pi coding agent **1.6.0 or newer**. The extension uses `samplingParamsByThinkingLevel`, which Pi merges into each request.
- TUI mode for interactive enrollment, masked credentials, and profile editing
- Network access to an OpenAI-compatible model server for live discovery (cached status/configuration remains available offline)

## Development

The code is in `extensions/` (pi entry `extensions/index.ts`). All tests are in `tests/`. `npm test` runs `tests/run.mjs`, the shared runner of `@maheidem/pi-panel-kit`. It needs Node 22.18 or newer. Each test file runs in its own child with an isolated temporary `HOME`.

```bash
npm run typecheck
npm test
npm run test:e2e   # live pi against fake local servers (tests/offline.e2e.ts)
npm pack --dry-run
```

`prepack` runs strict typechecking and the complete offline suite automatically. Provider detection, enrichment, family files, the level map, profile semantics, routing, schema repair, storage, application actions, panel builders, command modes, and adapter registration all have regression coverage.

## License

MIT

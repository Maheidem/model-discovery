# Model families

A family file holds the facts that a server does not always report: the thinking controls of the chat template, the sampling values and the fallback capabilities.
The files are in `families/`. `families/index.json` lists them in match order. The first family that matches a model wins.

The order of trust for the thinking controls is:

1. The server report (oMLX `/v1/models/status`).
2. The chat template text (llama.cpp `/props`).
3. The family file.

## 1. Live server profiles (read 2026-11-27)

The host names are neutral names: `local-mac` and `mac-m3` are oMLX servers, and `Desktop` is a llama-swap server.

### oMLX: `/v1/models/status`

| Model | `model_type` | `thinking_default` | `preserve_thinking_default` | `reasoning_efforts` |
| --- | --- | --- | --- | --- |
| `Qwen3.8-27B` (alias) | `vlm` | `true` | `true` | `["low","medium","xhigh"]` |
| `qwen3.8-flash` (local GGUF template) | `vlm` | `true` | `true` | `["low","medium","high","xhigh"]` |
| `gemma-4-e4b` | `vlm` | `false` | `true` | `null` |
| `Inkling-2-Mini` | `vlm` | `null` | `null` | `[]` |
| `Qwen3-ASR` | `audio_stt` | not applicable | not applicable | not applicable |
| `Qwen3-Reranker` | `reranker` | not applicable | not applicable | not applicable |
| `embeddinggemma-2` | `embedding` | not applicable | not applicable | not applicable |
| `MarkItDown` | `markitdown` | not applicable | not applicable | not applicable |
| `clef-flash` | `decision` | not applicable | not applicable | not applicable |

Meaning of the fields (from the oMLX source):

- `thinking_default` is a boolean: the template has the `enable_thinking` toggle, and the value is its default. `null`: the template has no toggle.
- `preserve_thinking_default` is a boolean: the template reads `preserve_thinking`. `null`: the template does not read it.
- `reasoning_efforts` is `null`: the template does not read `reasoning_effort`.
- `reasoning_efforts` is `[]`: the template reads `reasoning_effort`, but it names none of the standard levels. The local Inkling 2 Mini template maps `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max` to numbers. It also takes a number from 0.0 to 0.99.
- oMLX reports image input through `model_type`: `vlm` is yes, `llm` is no. The `/v1/models` entries have `model_type` too.
- Each status entry has `id` (the real name) and an optional `model_alias` (the id that `/v1/models` shows). The extension matches the two.
- `engine_type` can be `batched` when `model_type` is `llm`. Thus `model_type` is read first.

### llama-swap (`Desktop`)

- The server type is `OpenAI-compatible`.
- `/props` gives 404. No chat template is available.
- Thus the family file is the fallback for each model on this server.
- Model ids: `embed-gemma2`, `embeddinggemma-2`, `gemma4-12b`, `gemma4-26b`, `gemma4-31b`, `gemma4-e2b`, `gemma4-e4b`, `llamacpp`, `qwen3-asr-1.7b`, `qwen3-tts-1.7b-customvoice`, `qwen3.5-0.8b`, `qwen3.5-2b`, `qwen3.5-4b`, `qwen3.5-9b`, `qwen3.6-35b`, `qwen3.8-27b`, `stt-qwen3-asr`, `vllm-omni-tts`.

### llama.cpp

- `/props` is the answer for one model. The extension applies it when the catalogue has one model, or when a model id is equal to `model_alias` or to the file name of `model_path` (with or without `.gguf`).
- A `/props` answer with `role: "router"` is applied to no model.

### Model kind

The model kind decides before the family. A model that is not a chat model gets no chat family behaviour.

| Server `model_type` | Kind |
| --- | --- |
| `llm`, `vlm` | chat |
| `audio_stt` | speech-to-text |
| `audio_tts`, `tts` | text-to-speech |
| `embedding` | embedding |
| `reranker` | reranker |
| other values | other |

With no server value, the name decides: `asr`, `stt`, `whisper` or `aligner` is speech-to-text, `tts` is text-to-speech, `embed` is embedding, `rerank` is reranker. All other names are chat.

## 2. Thinking controls of each family

"Toggle" is `enable_thinking`. "Efforts" are the names that the template reads from `reasoning_effort`.

| Family id | Toggle | Efforts | Reads `preserve_thinking` | Default on | Send preserve | Template source |
| --- | --- | --- | --- | --- | --- | --- |
| `qwen3` | yes | none | no | yes | no | <https://huggingface.co/Qwen/Qwen3-8B/raw/main/tokenizer_config.json> |
| `qwen3.5-small` (0.8B, 2B) | yes | none | no | no | no | <https://huggingface.co/Qwen/Qwen3.5-0.8B/raw/main/chat_template.jinja> |
| `qwen3.5` (4B and larger) | yes | none | no | yes | no | <https://huggingface.co/Qwen/Qwen3.5-9B/raw/main/chat_template.jinja> |
| `qwen3.6` | yes | none | yes | yes | yes | <https://huggingface.co/Qwen/Qwen3.6-35B-A3B/raw/main/chat_template.jinja> |
| `qwen3.8` (27B, Flash) | yes | low, medium, xhigh | yes | yes | yes | <https://huggingface.co/Qwen/Qwen3.8-27B/raw/main/chat_template.jinja> |
| `gemma4` | yes | none | yes | no | no | <https://huggingface.co/google/gemma-4-31B-it/raw/main/chat_template.jinja> |
| `inkling` (v1) | no | none, minimal, low, medium, high, max | no | yes | no | <https://huggingface.co/thinkingmachines/Inkling/raw/main/chat_template.jinja> |
| `inkling2-small` | no | none, minimal, low, medium, high, xhigh, max | no | yes | no | Model card (no template URL in the source list): <https://huggingface.co/thinkingmachines/Inkling-2-Small> |
| `inkling2-mini` | no | none, minimal, low, medium, high, xhigh, max | no | yes | no | <https://huggingface.co/thinkingmachines/Inkling-2-Mini/raw/main/chat_template.jinja> |

Notes:

- `gemma4`: the template reads `preserve_thinking`, but the extension does not send it. Google guidance is to drop old thinking: <https://gemma.ai/get-started/capabilities/thinking/>.
- A Qwen name with no known generation (for example `qwen-max` or `Qwen2.5-7B`) matches no family.
- `qwen3` does not match speech, embedding, reranker or Coder models.

### Fallback capabilities

Each context value is a fallback only. The server value wins.

| Family id | Image | Audio | Tools | Fallback context |
| --- | --- | --- | --- | --- |
| `qwen3` | no | no | yes | 32768 |
| `qwen3.5-small` | yes | no | yes | 262144 |
| `qwen3.5` | yes | no | yes | 262144 |
| `qwen3.6` | yes | no | yes | 262144 |
| `qwen3.8` | yes | no | yes | 262144 |
| `gemma4` | yes | E2B and E4B: yes. Other sizes: no | yes | E2B and E4B: 131072. 12B, 26B and 31B: 262144 |
| `inkling` | no (not known) | not set | yes | 131072 |
| `inkling2-small` | yes | not set | yes | 1000000 |
| `inkling2-mini` | yes | not set | yes | 1000000 |

## 3. Bundled sampling

The Unsloth value wins when the Unsloth guide and the model card are different.
"Off" is the set for the preset with thinking off. "On" is the set for each preset with thinking on.

### `qwen3.8`

Sources: <https://unsloth.ai/docs/models/qwen3.8>, <https://huggingface.co/Qwen/Qwen3.8-27B>.

| Value | Off | On |
| --- | --- | --- |
| temperature | 0.7 | 1.0 |
| topP | 0.80 | 0.95 |
| topK | 20 | 20 |
| minP | 0 | 0 |
| presencePenalty | 1.5 | 0 |

### `qwen3.6`

Source of the template: <https://huggingface.co/Qwen/Qwen3.6-35B-A3B/raw/main/chat_template.jinja>. The sampling values come from the Unsloth guide and the model card of Qwen 3.6.

| Value | Off | On | `thinking-general` (thinking on) |
| --- | --- | --- | --- |
| temperature | 0.7 | 0.6 | 1.0 |
| topP | 0.80 | 0.95 | 0.95 |
| topK | 20 | 20 | 20 |
| presencePenalty | 1.5 | 0 | 0.0 (Unsloth). The card value is 1.5 |

### `qwen3.5`

Source: <https://unsloth.ai/docs/models/qwen3.5.md>.

| Value | Off | On | `thinking-general` (thinking on) |
| --- | --- | --- | --- |
| temperature | 0.7 | 0.6 | 1.0 |
| topP | 0.80 | 0.95 | 0.95 |
| topK | 20 | 20 | 20 |
| presencePenalty | 1.5 | 0 | 1.5 |

### `qwen3.5-small`

Source: <https://unsloth.ai/docs/models/qwen3.5.md>.

| Value | Off | On | `thinking-general` (thinking on) |
| --- | --- | --- | --- |
| temperature | 1.0 | 0.6 | 1.0 |
| topP | 1.0 | 0.95 | 0.95 |
| topK | 20 | 20 | 20 |
| presencePenalty | 2.0 | 0 | 1.5 |

### `qwen3`

Source: <https://unsloth.ai/docs/models/qwen3.md>.

| Value | Off | On |
| --- | --- | --- |
| temperature | 0.7 | 0.6 |
| topP | 0.8 | 0.95 |
| topK | 20 | 20 |
| minP | 0 | 0 |

### `gemma4`

Sources: <https://unsloth.ai/docs/models/gemma-4>, <https://huggingface.co/google/gemma-4-31B-it>.

| Value | Off and on |
| --- | --- |
| temperature | 1.0 |
| topP | 0.95 |
| topK | 64 |

### `inkling`

Sources: <https://unsloth.ai/docs/models/inkling>, <https://huggingface.co/thinkingmachines/Inkling>.

| Value | Off and on |
| --- | --- |
| temperature | 1.0 |
| topP | 1.0 |
| minP | 0 |

### `inkling2-small`

Sources: <https://unsloth.ai/docs/models/inkling-2>, <https://huggingface.co/thinkingmachines/Inkling-2-Small>.

| Value | Off and on |
| --- | --- |
| temperature | 1.0 |
| topP | 1.0 |
| topK | 0 |
| minP | 0 |

### `inkling2-mini`

Source: <https://unsloth.ai/docs/models/inkling-2>.

| Value | Off and on |
| --- | --- |
| temperature | 1.0 |

## 4. Level map

pi has seven thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
The effort scale is `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

Rules:

- A model with efforts: each pi level that is not `off` uses the nearest effort on the scale. A tie goes to the higher effort. All seven levels are offered.
- `off` with a toggle sends `enable_thinking: false`.
- `off` with no toggle sends the lowest effort.
- A model with a toggle only: `off` sends `enable_thinking: false`. Each other level sends `enable_thinking: true`. pi offers `off` and `high` only.
- `enable_thinking` is always sent when the template has the toggle.
- `preserve_thinking: true` is sent only when the template reads it and the family permits it.

Worked examples:

| pi level | Qwen 3.8 (toggle; low, medium, xhigh) | Qwen 3.8 Flash (toggle; low, medium, high, xhigh) | Inkling v1 (no toggle; 6 efforts) | Inkling 2 (no toggle; 7 efforts) | Toggle only (Qwen 3.6, Gemma 4) |
| --- | --- | --- | --- | --- | --- |
| `off` | thinking off | thinking off | `none` | `none` | thinking off |
| `minimal` | `low` | `low` | `minimal` | `minimal` | thinking on (not offered) |
| `low` | `low` | `low` | `low` | `low` | thinking on (not offered) |
| `medium` | `medium` | `medium` | `medium` | `medium` | thinking on (not offered) |
| `high` | `xhigh` | `high` | `high` | `high` | thinking on |
| `xhigh` | `xhigh` | `xhigh` | `max` | `xhigh` | thinking on (not offered) |
| `max` | `xhigh` | `xhigh` | `max` | `max` | thinking on (not offered) |

Bundled presets: there is one preset for each different control in the map.
The preset names are `instruct` (thinking off), `thinking-<effort>` and `thinking` (thinking on, no effort).
Qwen 3.8 gets `instruct`, `thinking-low`, `thinking-medium` and `thinking-xhigh`. The adaptive alias sends each pi level to the preset of its control.

## 5. How to change a value

1. Edit the JSON file of the family in `families/`.
2. Increase `revision` in `families/index.json` by 1. Set `updated` to the date of the change.
3. Run `npm test`. The tests refuse a data file that is not valid.
4. Push to `main`.

Each install reads the new data in 24 hours or less. A new package version is not necessary.

- An install uses the downloaded data only when its `revision` is higher than the `revision` of the package.
- A downloaded family file that is not valid is rejected. The family file of the package replaces it.
- An index with an unknown `schemaVersion` is refused. The install keeps its data.
- Set `PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE=1` to stop the download.
- Set `PI_MODEL_DISCOVERY_FAMILIES_URL` to read the data from a different base URL.
- A new family file must be in the `files` list of `index.json`. Put a specific family before a general family, because the first match wins.

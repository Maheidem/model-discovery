# @maheidem/model-discovery

Interactive TUI for discovering and managing local AI model endpoints. Works with llama.cpp, oMLX, Ollama, vLLM, SGLang, LM Studio, and any OpenAI-compatible server.

## Features

- **Auto-detect** server type from headers and model data (no manual config)
- **Read real server-reported configs** — context window, max tokens, reasoning flags, input modalities
- **Fine-tune per-model overrides** — set context window, max tokens, reasoning toggles
- **Multi-endpoint management** — add, scan, and register multiple local servers
- **LLM-callable tool** — the `discover_models` tool lets the agent discover endpoints on your behalf
- **Persistent storage** — providers saved across sessions in `~/.pi/agent/model-discovery.json`

## Installation

```bash
# Via npm
pi install npm:@maheidem/model-discovery

# Via git
pi install git:github.com/maheidem/model-discovery@v0.1.0
```

## Usage

### Interactive UI

Run `/discover` in pi to open the management TUI:

- **Add endpoint** — enter a URL, probe it, review models, register
- **Scan existing** — re-scan registered endpoints for fresh model lists
- **Edit per-model** — override context window, max tokens, reasoning flags
- **Remove** — unregister and delete saved endpoints

### With arguments

```
/discover http://192.168.1.100:8080    # jump straight to adding this endpoint
```

### LLM Tool

The `discover_models` tool can be called by the agent:

```
discover_models(url="http://localhost:8080", providerName="my-llama", apiKey="optional-key")
```

## Storage

Discovered providers are persisted in `~/.pi/agent/model-discovery.json`.

## Requirements

- pi coding agent with TUI support
- Access to OpenAI-compatible model servers on your network

## License

MIT

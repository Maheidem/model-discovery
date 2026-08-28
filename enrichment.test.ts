/**
 * Tests for provider detection + native-endpoint enrichment (providers.ts).
 * Runs a local HTTP fixture server per test — no network access needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo, type IncomingMessage, type Server } from "node:http";
import {
	detectServerType,
	enrichModels,
	extractModelConfig,
	fetchModels,
} from "./providers.ts";

// ---------------------------------------------------------------------------
// Fixture server
// ---------------------------------------------------------------------------

type Route = unknown | ((req: IncomingMessage) => unknown);

async function jsonServer(routes: Record<string, Route>): Promise<{ url: string; close: () => Promise<void> }> {
	const server: Server = createServer((req, res) => {
		const route = routes[req.url ?? ""];
		if (route === undefined) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}
		const body = typeof route === "function" ? route(req) : route;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body ?? null));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

// ---------------------------------------------------------------------------
// detectServerType
// ---------------------------------------------------------------------------

test("detects servers from headers first", () => {
	const headers: [string, Record<string, string>, string][] = [
		["llama.cpp", { server: "llama.cpp/b9999" }, "llama.cpp"],
		["Ollama", { server: "Ollama v0.13.0" }, "Ollama"],
		["vLLM", { server: "vllm/0.10.0" }, "vLLM"],
		["SGLang", { server: "sglang/0.4.0" }, "SGLang"],
		["LM Studio", { server: "LM-Studio/0.3.20" }, "LM Studio"],
		["oMLX (powered-by)", { "x-powered-by": "omlx" }, "oMLX"],
	];
	for (const [label, map, expected] of headers) {
		assert.equal(detectServerType(new Headers(map), []), expected, label);
	}
});

test("detects oMLX and llama.cpp from owned_by fallback", () => {
	assert.equal(detectServerType(new Headers({}), [{ id: "m", owned_by: "omlx" }]), "oMLX");
	assert.equal(detectServerType(new Headers({}), [{ id: "m.gguf", owned_by: "llamacpp" }]), "llama.cpp");
});

test("detects MTPLX from the capability field on /v1/models entries", () => {
	assert.equal(
		detectServerType(new Headers({}), [{ id: "qwen3.8-27b", capability: "chat" }]),
		"MTPLX",
	);
});

test("Ollama name:tag ids still detect after the MTPLX check", () => {
	assert.equal(detectServerType(new Headers({}), [{ id: "llama3.2:8b" }]), "Ollama");
});

test("unknown servers stay generic", () => {
	assert.equal(detectServerType(new Headers({}), [{ id: "some-model" }]), "OpenAI-compatible");
});

// ---------------------------------------------------------------------------
// enrichModels — llama.cpp /props
// ---------------------------------------------------------------------------

test("llama.cpp: /props supplies runtime context and the VLM flag", async () => {
	const { url, close } = await jsonServer({
		"/props": {
			default_generation_settings: { n_ctx: 32768, params: { temperature: 0.8 } },
			modalities: { vision: true },
		},
	});
	const models = [{ id: "/models/gemma-3-4b.gguf" }];
	await enrichModels(url, undefined, "llama.cpp", models);
	const cfg = extractModelConfig(models[0]);
	assert.equal(cfg.contextWindow, 32768);
	assert.deepEqual(cfg.input, ["text", "image"]);
	await close();
});

test("llama.cpp: a missing /props leaves the catalogue untouched", async () => {
	const { url, close } = await jsonServer({});
	const models = [{ id: "/models/gemma.gguf" }];
	await enrichModels(url, undefined, "llama.cpp", models);
	assert.equal(extractModelConfig(models[0]).contextWindow, null);
	await close();
});

test("llama.cpp: a zero n_ctx (still loading) is ignored", async () => {
	const { url, close } = await jsonServer({
		"/props": { default_generation_settings: { n_ctx: 0 }, modalities: { vision: false } },
	});
	const models = [{ id: "m" }];
	await enrichModels(url, undefined, "llama.cpp", models);
	assert.equal(extractModelConfig(models[0]).contextWindow, null);
	await close();
});

// ---------------------------------------------------------------------------
// enrichModels — oMLX /v1/models/status
// ---------------------------------------------------------------------------

test("oMLX: status supplies effective context, max tokens, load state, thinking", async () => {
	const { url, close } = await jsonServer({
		"/v1/models/status": {
			models: [
				{
					id: "/data/models/Qwen3.8-27B",
					model_alias: "qwen27",
					max_context_window: 262144,
					max_tokens: 16384,
					loaded: true,
					thinking_default: true,
				},
				{ id: "/data/models/other", max_context_window: 4096, max_tokens: 512, loaded: false },
			],
		},
	});
	const models = [{ id: "qwen27" }, { id: "/data/models/other" }];
	await enrichModels(url, undefined, "oMLX", models);

	const aliased = extractModelConfig(models[0]);
	assert.equal(aliased.contextWindow, 262144);
	assert.equal(aliased.maxTokens, 16384);
	assert.equal(aliased.loaded, true);
	assert.equal(aliased.reasoning, true);

	const other = extractModelConfig(models[1]);
	assert.equal(other.contextWindow, 4096);
	assert.equal(other.maxTokens, 512);
	assert.notEqual(other.loaded, true);
	assert.equal(other.reasoning, null);
	await close();
});

test("oMLX: /v1/models values still win over enrichment", async () => {
	const { url, close } = await jsonServer({
		"/v1/models/status": {
			models: [{ id: "m", max_context_window: 262144, max_tokens: 8192 }],
		},
	});
	const models = [{ id: "m", max_model_len: 999 }];
	await enrichModels(url, undefined, "oMLX", models);
	assert.equal(extractModelConfig(models[0]).contextWindow, 999);
	assert.equal(extractModelConfig(models[0]).maxTokens, 8192);
	await close();
});

test("oMLX: the API key header is forwarded to the native endpoint", async () => {
	const { url, close } = await jsonServer({
		"/v1/models/status": (req) =>
			req.headers.authorization === "Bearer sekret"
				? { models: [{ id: "m", max_context_window: 4096 }] }
				: { models: [] },
	});
	const models = [{ id: "m" }];
	await enrichModels(url, "sekret", "oMLX", models);
	assert.equal(extractModelConfig(models[0]).contextWindow, 4096);
	await close();
});

// ---------------------------------------------------------------------------
// enrichModels — Ollama /api/tags + /api/ps
// ---------------------------------------------------------------------------

test("Ollama: model cards supply default context; /api/ps marks loaded", async () => {
	const { url, close } = await jsonServer({
		"/api/tags": {
			models: [
				{ name: "llama3.2:8b", details: { family: "llama", context_length: 131072 } },
				{ name: "qwen3:8b", details: { family: "qwen3", context_length: 40960 } },
			],
		},
		"/api/ps": { models: [{ name: "llama3.2:8b" }] },
	});
	const models = [{ id: "llama3.2:8b" }, { id: "qwen3:8b" }];
	await enrichModels(url, undefined, "Ollama", models);

	const loaded = extractModelConfig(models[0]);
	assert.equal(loaded.contextWindow, 131072);
	assert.equal(loaded.loaded, true);

	const idle = extractModelConfig(models[1]);
	assert.equal(idle.contextWindow, 40960);
	assert.notEqual(idle.loaded, true);
	await close();
});

// ---------------------------------------------------------------------------
// enrichModels — resilience
// ---------------------------------------------------------------------------

test("enrichment never throws on connection refusal", async () => {
	const models = [{ id: "m" }];
	await enrichModels("http://127.0.0.1:1", undefined, "oMLX", models);
	assert.equal(extractModelConfig(models[0]).contextWindow, null);
});

test("unknown server types skip enrichment entirely", async () => {
	const models = [{ id: "m" }];
	await enrichModels("http://127.0.0.1:1", undefined, "MTPLX", models);
	assert.equal(models[0]["__md"], undefined);
});

// ---------------------------------------------------------------------------
// fetchModels — end-to-end probe (catalogue + enrichment)
// ---------------------------------------------------------------------------

test("fetchModels: Ollama-style server gets tags enrichment end-to-end", async () => {
	const { url, close } = await jsonServer({
		"/v1/models": {
			object: "list",
			data: [{ id: "llama3.2:8b", object: "model", created: 1, owned_by: "library" }],
		},
		"/api/tags": { models: [{ name: "llama3.2:8b", details: { context_length: 131072 } }] },
		"/api/ps": { models: [] },
	});
	const { models, serverType } = await fetchModels(url);
	assert.equal(serverType, "Ollama");
	assert.equal(extractModelConfig(models[0]).contextWindow, 131072);
	await close();
});

test("fetchModels: a 404 on the native endpoint never fails the scan", async () => {
	const { url, close } = await jsonServer({
		"/v1/models": {
			object: "list",
			data: [{ id: "llama3.2:8b", object: "model", created: 1, owned_by: "library" }],
		},
		// no /api/tags, no /api/ps
	});
	const { models, serverType } = await fetchModels(url);
	assert.equal(serverType, "Ollama");
	assert.equal(extractModelConfig(models[0]).contextWindow, null);
	await close();
});

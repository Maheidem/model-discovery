import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const model = { id: "Qwen3.8-27B", owned_by: "omlx", context_window: 262144, max_tokens: 32768 };

type ProviderFixture = Record<string, unknown>;

function piEnvironment(home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
	delete env.NODE_TEST_CONTEXT;
	return env;
}

function makeHome(providers: ProviderFixture[]): { home: string; configPath: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "model-discovery-offline-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	const configPath = join(agentDir, "model-discovery.json");
	writeFileSync(configPath, JSON.stringify(providers, null, 2));
	return { home, configPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runPi(home: string, provider: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			"pi",
			["--no-extensions", "-e", extensionPath, "--list-models", provider],
			{ env: piEnvironment(home), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`pi failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
					return;
				}
				resolve({ stdout, stderr });
			},
		);
	});
}

function runInference(
	home: string,
	provider: string,
	modelId: string,
	thinking: "off" | "max" = "off",
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"pi",
			[
				"--no-approve",
				"--no-extensions",
				"-e",
				extensionPath,
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-tools",
				"--no-session",
				"--provider",
				provider,
				"--model",
				modelId,
				"--thinking",
				thinking,
				"--print",
				"Reply briefly.",
			],
			{ env: piEnvironment(home), encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`pi inference failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
					return;
				}
				resolve({ stdout, stderr });
			},
		);
		child.stdin?.end();
	});
}

function startServer(handler: RequestListener): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
	const server = createServer(handler);
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Mock server did not expose a TCP port."));
				return;
			}
			resolve({
				server,
				baseUrl: `http://127.0.0.1:${address.port}`,
				close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
			});
		});
	});
}

async function unusedLocalUrl(): Promise<string> {
	const fixture = await startServer((_request, response) => response.end());
	const url = fixture.baseUrl;
	await fixture.close();
	return url;
}

test("uses a configured API key for discovery and inference without printing the secret", { concurrency: false }, async () => {
	const secret = "test-provider-key-9x7";
	const authenticatedModel = { id: model.id, context_window: 262144, max_tokens: 32768 };
	const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
	const mock = await startServer(async (request, response) => {
		requests.push({ url: request.url, authorization: request.headers.authorization });
		if (request.headers.authorization !== `Bearer ${secret}`) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		if (request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [authenticatedModel] }));
			return;
		}
		if (request.url === "/v1/chat/completions") {
			for await (const _chunk of request) {
				// Drain the complete request before returning the mock stream.
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
				response.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-auth-test",
						object: "chat.completion.chunk",
						created: 1,
						model: model.id,
						choices: [{ index: 0, delta, finish_reason: finishReason }],
					})}\n\n`,
				);
			chunk({ role: "assistant", content: "authenticated-ok" }, null);
			chunk({}, "stop");
			response.end("data: [DONE]\n\n");
			return;
		}
		response.writeHead(404);
		response.end();
	});
	const fixture = makeHome([
		{
			name: "authenticated",
			baseUrl: mock.baseUrl,
			apiKey: secret,
			modelOverrides: { [model.id]: { reasoning: false } },
		},
	]);
	try {
		let result: { stdout: string; stderr: string };
		try {
			result = await runInference(fixture.home, "authenticated", model.id);
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}\nrequests: ${JSON.stringify(requests)}`);
		}
		assert.match(result.stdout, /authenticated-ok/);
		assert.deepEqual(
			requests.map((request) => request.url),
			["/v1/models", "/v1/chat/completions"],
		);
		assert.ok(requests.every((request) => request.authorization === `Bearer ${secret}`));
		assert.doesNotMatch(result.stdout, new RegExp(secret));
		assert.doesNotMatch(result.stderr, new RegExp(secret));
		const providers = JSON.parse(readFileSync(fixture.configPath, "utf8")) as ProviderFixture[];
		assert.equal(providers[0].apiKey, secret);
		assert.deepEqual(providers[0].cachedModels, [authenticatedModel]);
	} finally {
		await mock.close();
		fixture.cleanup();
	}
});

test("preserves the pre-profile oMLX thinking request on base models", { concurrency: false }, async () => {
	let capturedPayload: Record<string, unknown> | undefined;
	const mock = await startServer(async (request, response) => {
		if (request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json", "x-powered-by": "oMLX" });
			response.end(JSON.stringify({ data: [model] }));
			return;
		}
		if (request.url === "/v1/chat/completions") {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			capturedPayload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-base-compat-test",
					object: "chat.completion.chunk",
					created: 1,
					model: model.id,
					choices: [{ index: 0, delta: { role: "assistant", content: "base-compatible" }, finish_reason: null }],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-base-compat-test",
					object: "chat.completion.chunk",
					created: 1,
					model: model.id,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
			return;
		}
		response.writeHead(404);
		response.end();
	});
	const fixture = makeHome([
		{
			name: "base-compat",
			baseUrl: mock.baseUrl,
			modelOverrides: { [model.id]: { reasoning: true, input: ["text"] } },
		},
	]);
	try {
		const result = await runInference(fixture.home, "base-compat", model.id, "max");
		assert.match(result.stdout, /base-compatible/);
		const payload = capturedPayload;
		assert.ok(payload);
		assert.deepEqual(payload.chat_template_kwargs, {
			enable_thinking: true,
			preserve_thinking: true,
		});
		assert.equal(payload.reasoning_effort, undefined);
		for (const key of ["temperature", "top_p", "top_k", "min_p", "repetition_penalty", "presence_penalty"]) {
			assert.equal(payload[key], undefined, `base request unexpectedly set ${key}`);
		}
	} finally {
		await mock.close();
		fixture.cleanup();
	}
});

test("redacts an API key echoed by an authentication failure while retaining cache", { concurrency: false }, async () => {
	const secret = "rejected-provider-key-4z2";
	const mock = await startServer((_request, response) => {
		response.writeHead(401, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: `credential ${secret} rejected` }));
	});
	const fixture = makeHome([
		{
			name: "rejected-auth",
			baseUrl: mock.baseUrl,
			apiKey: secret,
			serverType: "oMLX",
			cachedModels: [model],
			lastScanned: 12345,
		},
	]);
	try {
		const result = await runPi(fixture.home, "rejected-auth");
		assert.match(result.stdout, /Qwen3\.8-27B/);
		assert.doesNotMatch(result.stderr, new RegExp(secret));
		assert.match(result.stderr, /\[redacted\]/);
		const providers = JSON.parse(readFileSync(fixture.configPath, "utf8")) as ProviderFixture[];
		assert.doesNotMatch(String(providers[0].lastScanError), new RegExp(secret));
		assert.match(String(providers[0].lastScanError), /\[redacted\]/);
		assert.deepEqual(providers[0].cachedModels, [model]);
	} finally {
		await mock.close();
		fixture.cleanup();
	}
});

test("persists a live catalogue and registers it unchanged after the source goes offline", { concurrency: false }, async () => {
	const mock = await startServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json", "x-powered-by": "oMLX" });
		response.end(JSON.stringify({ data: [model] }));
	});
	const fixture = makeHome([{ name: "resilient", baseUrl: mock.baseUrl }]);
	try {
		const live = await runPi(fixture.home, "resilient");
		assert.match(live.stdout, /Qwen3\.8-27B/);
		const afterLive = JSON.parse(readFileSync(fixture.configPath, "utf8")) as ProviderFixture[];
		const successfulAt = afterLive[0].lastScanned;
		assert.deepEqual(afterLive[0].cachedModels, [model]);
		assert.equal(typeof successfulAt, "number");
		assert.equal(afterLive[0].lastScanAttempt, successfulAt);
		assert.equal(afterLive[0].lastScanError, undefined);
		assert.equal(statSync(fixture.configPath).mode & 0o777, 0o600);

		await mock.close();
		const offline = await runPi(fixture.home, "resilient");
		assert.match(offline.stdout, /Qwen3\.8-27B/);
		assert.match(offline.stderr, /registered last known-good cached catalogue/);
		const afterOffline = JSON.parse(readFileSync(fixture.configPath, "utf8")) as ProviderFixture[];
		assert.deepEqual(afterOffline[0].cachedModels, [model]);
		assert.equal(afterOffline[0].lastScanned, successfulAt);
		assert.equal(typeof afterOffline[0].lastScanError, "string");
		assert.ok((afterOffline[0].lastScanAttempt as number) >= (successfulAt as number));
	} finally {
		if (mock.server.listening) await mock.close();
		fixture.cleanup();
	}
});

test("does not poison the last known-good cache with a malformed successful response", { concurrency: false }, async () => {
	const mock = await startServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: { malformed: true } }));
	});
	const fixture = makeHome([
		{
			name: "malformed",
			baseUrl: mock.baseUrl,
			serverType: "oMLX",
			cachedModels: [model],
			lastScanned: 12345,
		},
	]);
	try {
		const result = await runPi(fixture.home, "malformed");
		assert.match(result.stdout, /Qwen3\.8-27B/);
		assert.match(result.stderr, /expected a data array/);
		const providers = JSON.parse(readFileSync(fixture.configPath, "utf8")) as ProviderFixture[];
		assert.deepEqual(providers[0].cachedModels, [model]);
		assert.equal(providers[0].lastScanned, 12345);
		assert.match(String(providers[0].lastScanError), /expected a data array/);
	} finally {
		await mock.close();
		fixture.cleanup();
	}
});

test("does not replace a populated cache with an empty live catalogue", { concurrency: false }, async () => {
	const mock = await startServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: [] }));
	});
	const fixture = makeHome([
		{
			name: "empty",
			baseUrl: mock.baseUrl,
			serverType: "oMLX",
			cachedModels: [model],
			lastScanned: 12345,
		},
	]);
	try {
		const result = await runPi(fixture.home, "empty");
		assert.match(result.stdout, /Qwen3\.8-27B/);
		assert.match(result.stderr, /No models found/);
		const providers = JSON.parse(readFileSync(fixture.configPath, "utf8")) as ProviderFixture[];
		assert.deepEqual(providers[0].cachedModels, [model]);
		assert.equal(providers[0].lastScanned, 12345);
	} finally {
		await mock.close();
		fixture.cleanup();
	}
});

test("an uncached offline source cannot prevent an independent healthy source from loading", { concurrency: false }, async () => {
	const mock = await startServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: [model] }));
	});
	const fixture = makeHome([
		{ name: "down", baseUrl: await unusedLocalUrl() },
		{ name: "up", baseUrl: mock.baseUrl },
	]);
	try {
		const result = await runPi(fixture.home, "up");
		assert.match(result.stdout, /up\s+Qwen3\.8-27B/);
		assert.match(result.stderr, /down: unavailable with no usable cache.*other sources remain available/);
		const providers = JSON.parse(readFileSync(fixture.configPath, "utf8")) as ProviderFixture[];
		assert.deepEqual(providers.find((provider) => provider.name === "up")?.cachedModels, [model]);
		assert.equal(typeof providers.find((provider) => provider.name === "down")?.lastScanError, "string");
	} finally {
		await mock.close();
		fixture.cleanup();
	}
});

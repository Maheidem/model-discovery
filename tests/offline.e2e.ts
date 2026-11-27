import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const extensionPath = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const model = { id: "Qwen3.8-27B", owned_by: "omlx", context_window: 262144, max_tokens: 32768 };

type ProviderFixture = Record<string, unknown>;

type Env = Record<string, string>;

/**
 * The environment of one pi run. `PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE=1` stops
 * the family data check at start, so no test calls GitHub. The forced update
 * of `/discover families update` still runs, against `PI_MODEL_DISCOVERY_FAMILIES_URL`.
 */
function piEnvironment(home: string, extra: Env = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE: "1", ...extra };
	delete env.NODE_TEST_CONTEXT;
	if (!("PI_MODEL_DISCOVERY_FAMILIES_URL" in extra)) delete env.PI_MODEL_DISCOVERY_FAMILIES_URL;
	if (!("PI_MODEL_DISCOVERY_WIRE_LOG" in extra)) delete env.PI_MODEL_DISCOVERY_WIRE_LOG;
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

type Level = "off" | "low" | "medium" | "max";
const LEVELS: readonly Level[] = ["off", "low", "medium", "max"];

/** Run pi in print mode with only this extension. */
function runPrint(home: string, args: string[], env: Env = {}): Promise<{ stdout: string; stderr: string }> {
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
				...args,
			],
			{ env: piEnvironment(home, env), encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`pi ${args.join(" ")} failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
					return;
				}
				resolve({ stdout, stderr });
			},
		);
		child.stdin?.end();
	});
}

function runInference(
	home: string,
	provider: string,
	modelId: string,
	thinking: Level = "off",
	env: Env = {},
): Promise<{ stdout: string; stderr: string }> {
	return runPrint(home, ["--provider", provider, "--model", modelId, "--thinking", thinking, "--print", "Reply briefly."], env);
}

/** Run one `/discover` command in print mode. No request goes to a model. */
async function runDiscover(home: string, args: string, env: Env = {}): Promise<string> {
	const result = await runPrint(home, ["--print", `/discover ${args}`], env);
	return `${result.stdout}\n${result.stderr}`;
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

// ---------------------------------------------------------------------------
// One fake server for the request tests
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

interface FakeServerOptions {
	/** The `/v1/models` entries. */
	models: Body[];
	/** The `/v1/models/status` entries of an oMLX server. Not set = 404, as an older server. */
	status?: Body[];
	/** The `/props` answer of a llama.cpp server. Not set = 404. */
	props?: Body;
	/** Response headers of `/v1/models`, for example `{ server: "llama.cpp" }`. */
	headers?: Record<string, string>;
}

interface FakeServer {
	baseUrl: string;
	/** Each chat request body, in the order of arrival. */
	chats: Body[];
	lastChat(): Body;
	close(): Promise<void>;
}

/** A fake OpenAI-compatible server. It keeps each chat request body and answers "fake-server-ok". */
async function startFakeServer(options: FakeServerOptions): Promise<FakeServer> {
	const chats: Body[] = [];
	const json = (response: Parameters<RequestListener>[1], value: unknown, headers: Record<string, string> = {}) => {
		response.writeHead(200, { "content-type": "application/json", ...headers });
		response.end(JSON.stringify(value));
	};
	const mock = await startServer(async (request, response) => {
		if (request.url === "/v1/models") return json(response, { data: options.models }, options.headers);
		if (request.url === "/v1/models/status" && options.status) return json(response, { models: options.status });
		if (request.url === "/props" && options.props) return json(response, options.props);
		if (request.url === "/v1/chat/completions") {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
			chats.push(body);
			response.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: Body, finishReason: string | null) =>
				response.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-fake",
						object: "chat.completion.chunk",
						created: 1,
						model: body.model,
						choices: [{ index: 0, delta, finish_reason: finishReason }],
					})}\n\n`,
				);
			chunk({ role: "assistant", content: "fake-server-ok" }, null);
			chunk({}, "stop");
			response.end("data: [DONE]\n\n");
			return;
		}
		response.writeHead(404);
		response.end();
	});
	return {
		baseUrl: mock.baseUrl,
		chats,
		lastChat: () => {
			const body = chats.at(-1);
			assert.ok(body, "the fake server got no chat request");
			return body;
		},
		close: mock.close,
	};
}

/** A request body with no message text. */
function withoutMessages(body: Body): Body {
	const { messages: _messages, ...rest } = body;
	return rest;
}

const CONTROLLED_KEYS = [
	"chat_template_kwargs",
	"reasoning_effort",
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"repetition_penalty",
	"repeat_penalty",
	"presence_penalty",
	"frequency_penalty",
];

/** The request fields that this extension controls: the thinking values and the sampling values. */
function controlled(body: Body): Body {
	return Object.fromEntries(CONTROLLED_KEYS.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
}

function readConfig(configPath: string): ProviderFixture[] {
	return JSON.parse(readFileSync(configPath, "utf8")) as ProviderFixture[];
}

const wire010 = JSON.parse(
	readFileSync(new URL("./fixtures/qwen38-wire-0.10.0.json", import.meta.url), "utf8"),
) as Record<string, Body>;

const QWEN38_OFF = { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5 };
const QWEN38_ON = { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0 };

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

test("the base model sends the recommended defaults of the family when the server reports no profile", { concurrency: false }, async () => {
	// This case was "preserves the pre-profile oMLX thinking request on base models" in 0.10.0.
	// Then the base model sent the switch only. Now it sends the Qwen 3.8 family values.
	const mock = await startFakeServer({ models: [model] });
	const overrides = { reasoning: true, input: ["text"] };
	const fixture = makeHome([
		{ name: "base-defaults", baseUrl: mock.baseUrl, modelOverrides: { [model.id]: overrides } },
		// Recommended defaults off gives the request of 0.10.0: the switch only, no effort, no sampling.
		{ name: "base-switch", baseUrl: mock.baseUrl, modelOverrides: { [model.id]: { ...overrides, familyDefaults: false } } },
	]);
	try {
		const result = await runInference(fixture.home, "base-defaults", model.id, "max");
		assert.match(result.stdout, /fake-server-ok/);
		assert.deepEqual(controlled(mock.lastChat()), {
			chat_template_kwargs: { enable_thinking: true, reasoning_effort: "xhigh", preserve_thinking: true },
			...QWEN38_ON,
		});

		for (const level of LEVELS) {
			await runInference(fixture.home, "base-switch", model.id, level);
			assert.deepEqual(withoutMessages(mock.lastChat()), wire010[`${model.id}|${level}`], `0.10.0 request at ${level}`);
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

// ---------------------------------------------------------------------------
// Model families: what the server gets from the base model and from the aliases
// ---------------------------------------------------------------------------

interface FamilyCase {
	family: string;
	id: string;
	modelType: "vlm" | "llm";
	/** The thinking fields of `/v1/models/status`. */
	status: { thinking_default: boolean | null; preserve_thinking_default: boolean | null; reasoning_efforts: string[] | null };
	/** The thinking values and the sampling values that the server must get at each level. */
	expected: Record<Level, Body>;
}

const QWEN36_OFF = { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 };
const QWEN36_ON = { temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 0 };
const GEMMA4 = { temperature: 1, top_p: 0.95, top_k: 64 };

/** The same request at low, medium and max: the model has one thinking state only. */
function offAndOn(off: Body, on: Body): Record<Level, Body> {
	return { off, low: on, medium: on, max: on };
}

const FAMILY_CASES: FamilyCase[] = [
	{
		family: "Qwen 3.8",
		id: "Qwen3.8-27B",
		modelType: "vlm",
		status: { thinking_default: true, preserve_thinking_default: true, reasoning_efforts: ["low", "medium", "xhigh"] },
		expected: {
			off: { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true }, ...QWEN38_OFF },
			low: { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "low", preserve_thinking: true }, ...QWEN38_ON },
			medium: { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "medium", preserve_thinking: true }, ...QWEN38_ON },
			max: { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "xhigh", preserve_thinking: true }, ...QWEN38_ON },
		},
	},
	{
		// A switch and no effort. The model offers the pi levels off and high only.
		// pi changes `--thinking low`, `medium` and `max` to the level high.
		family: "Qwen 3.6",
		id: "Qwen3.6-35B-A3B",
		modelType: "vlm",
		status: { thinking_default: true, preserve_thinking_default: true, reasoning_efforts: null },
		expected: offAndOn(
			{ chat_template_kwargs: { enable_thinking: false, preserve_thinking: true }, ...QWEN36_OFF },
			{ chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }, ...QWEN36_ON },
		),
	},
	{
		// A switch only, and the template does not read `preserve_thinking`. pi uses the level high for low, medium and max.
		family: "Qwen 3.5",
		id: "Qwen3.5-9B",
		modelType: "vlm",
		status: { thinking_default: true, preserve_thinking_default: null, reasoning_efforts: null },
		expected: offAndOn(
			{ chat_template_kwargs: { enable_thinking: false }, ...QWEN36_OFF },
			{ chat_template_kwargs: { enable_thinking: true }, ...QWEN36_ON },
		),
	},
	{
		// The template reads `preserve_thinking`, but the family file says: do not send it.
		// pi uses the level high for low, medium and max.
		family: "Gemma 4",
		id: "gemma-4-e4b",
		modelType: "vlm",
		status: { thinking_default: false, preserve_thinking_default: true, reasoning_efforts: null },
		expected: offAndOn(
			{ chat_template_kwargs: { enable_thinking: false }, ...GEMMA4 },
			{ chat_template_kwargs: { enable_thinking: true }, ...GEMMA4 },
		),
	},
	{
		// No switch. Each pi level sends its effort name. The level off sends the effort "none".
		family: "Inkling 2 Mini",
		id: "Inkling-2-Mini",
		modelType: "vlm",
		status: { thinking_default: null, preserve_thinking_default: null, reasoning_efforts: [] },
		expected: {
			off: { chat_template_kwargs: { reasoning_effort: "none" }, temperature: 1 },
			low: { chat_template_kwargs: { reasoning_effort: "low" }, temperature: 1 },
			medium: { chat_template_kwargs: { reasoning_effort: "medium" }, temperature: 1 },
			max: { chat_template_kwargs: { reasoning_effort: "max" }, temperature: 1 },
		},
	},
];

function omlxServer(entries: Array<{ id: string; modelType: string; status?: Body }>): Promise<FakeServer> {
	return startFakeServer({
		models: entries.map((entry) => ({ id: entry.id, owned_by: "omlx", model_type: entry.modelType })),
		status: entries.map((entry) => ({
			id: entry.id,
			model_type: entry.modelType,
			max_context_window: 262144,
			max_tokens: 32768,
			...entry.status,
		})),
	});
}

for (const item of FAMILY_CASES) {
	test(`${item.family}: the base model, the adaptive alias and a fixed alias send the family values`, { concurrency: false }, async () => {
		const mock = await omlxServer([item]);
		const fixture = makeHome([{ name: "family", baseUrl: mock.baseUrl }]);
		try {
			// 1. The base model, with no stored preset.
			const baseBodies = {} as Record<Level, Body>;
			for (const level of LEVELS) {
				await runInference(fixture.home, "family", item.id, level);
				assert.equal(mock.lastChat().model, item.id);
				assert.deepEqual(controlled(mock.lastChat()), item.expected[level], `base model at ${level}`);
				baseBodies[level] = withoutMessages(mock.lastChat());
			}

			// 2. Copy the recommended presets into the config.
			assert.match(await runDiscover(fixture.home, `preset defaults family ${item.id}`), /Copied \d+ recommended preset\(s\)/);
			const providers = readConfig(fixture.configPath);
			const routing = (providers[0].modelProfileRouting as Record<string, { aliasSlug: string; levels: Record<string, string> }>)[item.id];
			const presets = (providers[0].modelProfiles as Record<string, Array<{ slug: string; exposeAsModel?: boolean }>>)[item.id];
			assert.equal(routing.aliasSlug, "adaptive");
			// Show the preset of the level "off" as a fixed model.
			const offSlug = routing.levels.off;
			const offPreset = presets.find((preset) => preset.slug === offSlug);
			assert.ok(offPreset);
			offPreset.exposeAsModel = true;
			writeFileSync(fixture.configPath, JSON.stringify(providers, null, 2));

			// 3. The adaptive alias sends the same body as the base model at the same level.
			for (const level of LEVELS) {
				await runInference(fixture.home, "family", `${item.id}@adaptive`, level);
				assert.deepEqual(withoutMessages(mock.lastChat()), baseBodies[level], `adaptive alias at ${level}`);
			}
			// 4. The fixed alias sends the values of its preset at each level.
			for (const level of LEVELS) {
				await runInference(fixture.home, "family", `${item.id}@${offSlug}`, level);
				assert.deepEqual(withoutMessages(mock.lastChat()), baseBodies.off, `fixed alias ${offSlug} at ${level}`);
			}
			assert.equal(mock.chats.length, 3 * LEVELS.length);
		} finally {
			await mock.close();
			fixture.cleanup();
		}
	});
}

test("golden: the aliases of the 0.10.0 Qwen 3.8 config send the same requests as 0.10.0", { concurrency: false }, async () => {
	// An oMLX server with no `/v1/models/status`: the thinking profile comes from the family file.
	const mock = await startFakeServer({ models: [model] });
	const thinking = (effort: string, exposeAsModel: boolean) => ({
		slug: `thinking-${effort}`,
		chatTemplateKwargs: { enable_thinking: true, reasoning_effort: effort, preserve_thinking: false },
		sampling: { temperature: 1, topP: 0.95, topK: 20, minP: 0, repetitionPenalty: 1, presencePenalty: 0 },
		exposeAsModel,
	});
	const fixture = makeHome([
		{
			name: "golden",
			baseUrl: mock.baseUrl,
			profileSchemaVersion: 2,
			modelOverrides: { [model.id]: { reasoning: true, input: ["text"] } },
			modelProfiles: {
				[model.id]: [
					{
						slug: "instruct",
						chatTemplateKwargs: { enable_thinking: false, preserve_thinking: false },
						sampling: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, repetitionPenalty: 1, presencePenalty: 1.5 },
						exposeAsModel: false,
					},
					thinking("low", true),
					thinking("medium", false),
					thinking("xhigh", false),
				],
			},
			modelProfileRouting: {
				[model.id]: {
					enabled: true,
					aliasSlug: "adaptive",
					levels: {
						off: "instruct",
						minimal: "thinking-low",
						low: "thinking-low",
						medium: "thinking-medium",
						high: "thinking-xhigh",
						xhigh: "thinking-xhigh",
						max: "thinking-xhigh",
					},
				},
			},
		},
	]);
	try {
		for (const alias of [`${model.id}@adaptive`, `${model.id}@thinking-low`]) {
			for (const level of LEVELS) {
				await runInference(fixture.home, "golden", alias, level);
				assert.deepEqual(withoutMessages(mock.lastChat()), wire010[`${alias}|${level}`], `${alias} at ${level}`);
			}
		}
	} finally {
		await mock.close();
		fixture.cleanup();
	}
});

test("reduced profile: no request has an effort that the server does not report", { concurrency: false }, async () => {
	const mock = await omlxServer([
		{ id: model.id, modelType: "vlm", status: { thinking_default: true, preserve_thinking_default: true, reasoning_efforts: ["low"] } },
	]);
	const fixture = makeHome([
		{
			name: "reduced",
			baseUrl: mock.baseUrl,
			profileSchemaVersion: 2,
			modelProfiles: {
				[model.id]: [
					{ slug: "deep", chatTemplateKwargs: { enable_thinking: true, reasoning_effort: "xhigh" }, sampling: { temperature: 1 }, exposeAsModel: true },
				],
			},
		},
	]);
	try {
		const efforts: unknown[] = [];
		for (const level of LEVELS) {
			await runInference(fixture.home, "reduced", model.id, level);
			efforts.push((mock.lastChat().chat_template_kwargs as Body).reasoning_effort);
			assert.equal(mock.lastChat().reasoning_effort, undefined);
		}
		assert.deepEqual(efforts, [undefined, "low", "low", "low"]);

		// The stored preset has the effort "xhigh". The model does not accept it, so the alias does not send it.
		for (const level of LEVELS) {
			await runInference(fixture.home, "reduced", `${model.id}@deep`, level);
			assert.deepEqual(controlled(mock.lastChat()), { chat_template_kwargs: { enable_thinking: true }, temperature: 1 }, `fixed alias at ${level}`);
		}
	} finally {
		await mock.close();
		fixture.cleanup();
	}
});

test("vision: a llama.cpp server that reports no vision part wins over the family", { concurrency: false }, async () => {
	const gemma = { id: "gemma-4-e4b-it", owned_by: "llamacpp" };
	const noVision = await startFakeServer({ models: [gemma], headers: { server: "llama.cpp" }, props: { modalities: { vision: false } } });
	const silent = await startFakeServer({ models: [gemma], headers: { server: "llama.cpp" } });
	const fixture = makeHome([
		{ name: "text-only", baseUrl: noVision.baseUrl },
		{ name: "family-vision", baseUrl: silent.baseUrl },
	]);
	try {
		// `--list-models` prints the column "images": yes or no.
		const row = async (provider: string) => {
			const { stdout } = await runPi(fixture.home, provider);
			const header = stdout.split("\n").find((line) => /\bimages\b/.test(line));
			const line = stdout.split("\n").find((entry) => entry.includes(gemma.id));
			assert.ok(header && line, `no model row in:\n${stdout}`);
			return line.slice(header.indexOf("images")).trim().split(/\s+/)[0];
		};
		assert.equal(await row("text-only"), "no");
		// The same model id with no server fact: the Gemma 4 family says that the model reads images.
		assert.equal(await row("family-vision"), "yes");
	} finally {
		await noVision.close();
		await silent.close();
		fixture.cleanup();
	}
});

test("hidden kinds: only the chat model of a catalogue is registered", { concurrency: false }, async () => {
	const mixed = await omlxServer([
		{ id: "Qwen3-ASR", modelType: "audio_stt" },
		{ id: "embeddinggemma-2", modelType: "embedding" },
		{ id: "Qwen3.6-35B-A3B", modelType: "vlm" },
	]);
	const noChat = await omlxServer([{ id: "embeddinggemma-2", modelType: "embedding" }]);
	const fixture = makeHome([
		{ name: "mixed", baseUrl: mixed.baseUrl },
		{ name: "no-chat", baseUrl: noChat.baseUrl },
	]);
	try {
		const listed = await runPi(fixture.home, "mixed");
		assert.match(listed.stdout, /mixed\s+Qwen3\.6-35B-A3B/);
		assert.doesNotMatch(listed.stdout, /Qwen3-ASR|embeddinggemma/);
		// The hidden models stay in the saved catalogue.
		assert.equal((readConfig(fixture.configPath)[0].cachedModels as unknown[]).length, 3);

		// A catalogue with hidden models only is not an error, and it registers no model.
		const empty = await runPi(fixture.home, "no-chat");
		assert.doesNotMatch(empty.stdout, /embeddinggemma/);
		assert.doesNotMatch(`${listed.stderr}${empty.stderr}`, /No models found|unavailable/);
		assert.equal(readConfig(fixture.configPath)[1].lastScanError, undefined);

		// The user can show a hidden model.
		assert.match(await runDiscover(fixture.home, "model embeddinggemma-2 hidden off --source no-chat"), /Model shown/);
		assert.match((await runPi(fixture.home, "no-chat")).stdout, /no-chat\s+embeddinggemma-2/);
	} finally {
		await mixed.close();
		await noChat.close();
		fixture.cleanup();
	}
});

test("family update: new data changes the request, and an invalid file falls back to the bundled file", { concurrency: false }, async () => {
	const familiesDir = fileURLToPath(new URL("../families/", import.meta.url));
	const bundled = Object.fromEntries(
		readdirSync(familiesDir).map((file) => [file, JSON.parse(readFileSync(join(familiesDir, file), "utf8")) as Body]),
	);
	// The family data server. `served` is the data of the current step.
	let served: Record<string, unknown> = {};
	const data = await startServer((request, response) => {
		const file = (request.url ?? "").split("/").pop() ?? "";
		if (!(file in served)) {
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(served[file]));
	});
	const mock = await omlxServer([{ id: model.id, modelType: "vlm", status: FAMILY_CASES[0].status }]);
	const fixture = makeHome([{ name: "updated", baseUrl: mock.baseUrl }]);
	const env = { PI_MODEL_DISCOVERY_FAMILIES_URL: `${data.baseUrl}/families/` };
	const offTemperature = async () => {
		await runInference(fixture.home, "updated", model.id, "off");
		return mock.lastChat().temperature;
	};
	try {
		assert.equal(await offTemperature(), 0.7);

		// Step 1: revision 99 has one changed sampling value for Qwen 3.8.
		const qwen = structuredClone(bundled["qwen3.8.json"]) as { sampling: { off: { temperature: number } } };
		qwen.sampling.off.temperature = 0.55;
		served = { ...bundled, "index.json": { ...bundled["index.json"], revision: 99 }, "qwen3.8.json": qwen };
		const updated = await runDiscover(fixture.home, "families update", env);
		assert.match(updated, /Family data update: updated/);
		assert.match(updated, /Family data layer: cache/);
		assert.match(updated, /Revision: 99/);
		assert.equal(await offTemperature(), 0.55);
		// The other values of the request did not change.
		assert.deepEqual(controlled(mock.lastChat()), { ...FAMILY_CASES[0].expected.off, temperature: 0.55 });

		// Step 2: a higher revision has an invalid Qwen 3.8 file. The bundled file is used again.
		served = { ...bundled, "index.json": { ...bundled["index.json"], revision: 100 }, "qwen3.8.json": { id: "qwen3.8", label: 7 } };
		const rejected = await runDiscover(fixture.home, "families update", env);
		assert.match(rejected, /Revision: 100/);
		assert.match(rejected, /Rejected qwen3\.8\.json: label must be a non-empty string\./);
		assert.equal(await offTemperature(), 0.7);
		assert.deepEqual(controlled(mock.lastChat()), FAMILY_CASES[0].expected.off);
		assert.match(await runDiscover(fixture.home, "doctor"), /Family data layer: cache[\s\S]*Rejected qwen3\.8\.json/);
	} finally {
		await data.close();
		await mock.close();
		fixture.cleanup();
	}
});

test("wire log: one JSON line for a request, with the thinking values and no message text", { concurrency: false }, async () => {
	const mock = await omlxServer([{ id: model.id, modelType: "vlm", status: FAMILY_CASES[0].status }]);
	const fixture = makeHome([{ name: "logged", baseUrl: mock.baseUrl }]);
	const logPath = join(fixture.home, "wire.jsonl");
	try {
		await runInference(fixture.home, "logged", model.id, "medium", { PI_MODEL_DISCOVERY_WIRE_LOG: logPath });
		const lines = readFileSync(logPath, "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		const entry = JSON.parse(lines[0]) as { provider: string; piModel: string; thinkingLevel: string; messageCount: number; request: Body };
		assert.equal(entry.provider, "logged");
		assert.equal(entry.piModel, model.id);
		assert.equal(entry.thinkingLevel, "medium");
		assert.ok(entry.messageCount >= 1);
		assert.deepEqual(entry.request.chat_template_kwargs, { enable_thinking: true, reasoning_effort: "medium", preserve_thinking: true });
		assert.equal("messages" in entry.request, false);
		assert.doesNotMatch(lines[0], /Reply briefly/);
		assert.deepEqual(entry.request, withoutMessages(mock.lastChat()));
	} finally {
		await mock.close();
		fixture.cleanup();
	}
});

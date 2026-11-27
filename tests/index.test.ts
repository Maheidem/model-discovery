import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";
import { saveProviders, STORAGE_PATH, type DiscoveredProvider } from "../extensions/storage.ts";
import { CONFIG_PATH } from "../extensions/config.ts";
import { HOME_PANEL_ROWS } from "../extensions/ui/home.ts";
import { modelDiscoveryVersion } from "../extensions/version.ts";

// The extension looks for new family data at each start. A test must not call the network.
process.env.PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE = "1";

type CommandRegistration = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
	handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
};

type ToolRegistration = {
	name: string;
	parameters?: unknown;
	execute(toolCallId: string, params: { url: string; providerName?: string; apiKey?: string }): Promise<{
		content: Array<{ type: string; text: string }>;
		details: { providerName?: string; serverType?: string; modelCount?: number; profileCount?: number };
		isError?: boolean;
	}>;
};

function harness() {
	const commands = new Map<string, CommandRegistration>();
	const tools: ToolRegistration[] = [];
	const events: Array<string> = [];
	const providers: Array<string> = [];
	const unregistered: string[] = [];
	/** The last model list that the extension gave to pi for each provider. */
	const registered = new Map<string, Array<Record<string, unknown>>>();
	const api = {
		registerCommand: (name: string, command: CommandRegistration) => commands.set(name, command),
		registerTool: (tool: ToolRegistration) => tools.push(tool),
		on: (event: string) => { events.push(event); },
		registerProvider: (name: string, config?: { models?: Array<Record<string, unknown>> }) => {
			providers.push(name);
			registered.set(name, config?.models ?? []);
		},
		unregisterProvider: (name: string) => { unregistered.push(name); },
		setModel: async () => {},
	} as unknown as ExtensionAPI;
	return { api, commands, tools, events, providers, unregistered, registered };
}

function context(
	mode: "tui" | "print" | "rpc",
	customCalls: unknown[] = [],
	notifications: string[] = [],
	factories: unknown[] = [],
): ExtensionCommandContext {
	return {
		mode,
		hasUI: mode !== "print",
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: () => {},
			custom: async (factory: unknown, options: unknown) => { customCalls.push(options); factories.push(factory); return null; },
			confirm: async () => false,
			input: async () => undefined,
		},
		modelRegistry: { find: () => undefined },
	} as unknown as ExtensionCommandContext;
}

async function captureConsole(work: () => Promise<void>): Promise<string> {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...values: unknown[]) => { lines.push(values.join(" ")); };
	try {
		await work();
	} finally {
		console.log = original;
	}
	return lines.join("\n");
}

test("adapter registers one discover command and preserves the discover_models tool", async () => {
	const h = harness();
	await extension(h.api);
	assert.deepEqual([...h.commands.keys()], ["discover"]);
	assert.deepEqual(h.tools.map((tool) => (tool as unknown as { name: string }).name), ["discover_models"]);
	assert.ok(h.events.includes("session_start"));
	assert.ok(h.events.includes("before_provider_request"));
});

test("discover_models renders neutral per-state cards (slice 2)", async () => {
	const h = harness();
	await extension(h.api);
	const tool = h.tools[0] as unknown as {
		renderCall?: (args: unknown, theme: unknown) => { render(width: number): string[] };
		renderResult?: (result: unknown, options: unknown, theme: unknown) => { render(width: number): string[] };
	};
	const theme = { fg: (_c: string, s: string) => s };
	assert.equal(typeof tool.renderCall, "function");
	assert.equal(typeof tool.renderResult, "function");

	const call = tool.renderCall!({ url: "http://127.0.0.1:8123/v1", providerName: "omx" }, theme).render(80).join("\n");
	assert.match(call, /discover · http:\/\/127\.0\.0\.1:8123\/v1 as "omx"/);

	const ok = tool.renderResult!(
		{ content: [{ text: "ok" }], details: { providerName: "omx", serverType: "oMLX", modelCount: 4, profileCount: 2 } },
		{},
		theme,
	).render(120).join("\n");
	assert.match(ok, /discover ✓ registered · "omx" · oMLX · 4 model\(s\) · \+2 preset\(s\)/);
	assert.match(ok, /next: select a model via \/model/);

	const failed = tool.renderResult!(
		{ content: [{ text: "Endpoint unavailable or registration failed: connection refused" }], details: {}, isError: true },
		{},
		theme,
	).render(120).join("\n");
	assert.match(failed, /discover ✗ failed/);
	assert.match(failed, /next: check the URL/);

	const noModels = tool.renderResult!(
		{ content: [{ text: "Endpoint online but reports no models." }], details: {}, isError: true },
		{},
		theme,
	).render(120).join("\n");
	assert.match(noModels, /discover ⊘ online · no models/);
	assert.doesNotMatch(noModels, /✗/);

	// Success that merely MENTIONS error must never render the failure card (OPERATIONAL §2.9).
	const mentions = tool.renderResult!(
		{ content: [{ text: "registered; if you see error, rerun" }], details: { providerName: "x", modelCount: 1 } },
		{},
		theme,
	).render(120).join("\n");
	assert.match(mentions, /discover ✓ registered/);
	assert.doesNotMatch(mentions, /✗/);
});

test("bare TUI command opens the canonical fixed-height home panel (slice 1a)", async () => {
	const h = harness();
	await extension(h.api);
	const calls: unknown[] = [];
	const factories: unknown[] = [];
	await h.commands.get("discover")?.handler("", context("tui", calls, [], factories));
	assert.equal(calls.length, 1);
	// Home is the vendored SettingsPanel rendered INLINE (delegate pattern) — no wizard overlay.
	assert.equal(calls[0], undefined);
	const factory = factories[0] as (
		tui: unknown,
		theme: unknown,
		keybindings: unknown,
		done: (r: unknown) => void,
	) => {
		render(width: number): string[];
		handleInput?(data: string): void;
	};
	assert.equal(typeof factory, "function");
	const theme = {
		fg: (_c: string, s: string) => s,
		bold: (s: string) => s,
	};
	const keybindings = { matches: () => false, getKeys: () => [] };
	const panel = factory({ requestRender: () => {} }, theme, keybindings, () => {});
	for (const width of [80, 62, 40, 20]) {
		assert.equal(panel.render(width).length, HOME_PANEL_ROWS, `home panel height at width ${width}`);
	}
	const home = panel.render(80).join("\n");
	assert.match(home, /Model Discovery/);
	assert.match(home, new RegExp(`v${modelDiscoveryVersion()}`));
	assert.match(home, /Actions/);
	assert.match(home, /Discover now/);
	assert.match(home, /Configure advanced/);
});

test("bare and status commands emit useful text outside TUI", async () => {
	const h = harness();
	await extension(h.api);
	const command = h.commands.get("discover");
	assert.ok(command);
	const bare = await captureConsole(async () => { await command.handler("", context("print")); });
	assert.match(bare, /^Model Discovery/m);
	assert.match(bare, /No sources configured/);
	const status = await captureConsole(async () => { await command.handler("status", context("print")); });
	assert.match(status, /Cached models:/);
	assert.doesNotMatch(status, /requires interactive mode/);
	const rpcNotifications: string[] = [];
	const rpc = await captureConsole(async () => { await command.handler("status", context("rpc", [], rpcNotifications)); });
	assert.equal(rpc, "", "RPC output stays on the extension UI protocol");
	assert.match(rpcNotifications.join("\n"), /Health:/);
});

test("unknown input returns usage and completion teaches nested grammar", async () => {
	const h = harness();
	await extension(h.api);
	const command = h.commands.get("discover");
	assert.ok(command);
	const output = await captureConsole(async () => { await command.handler("nonsense", context("print")); });
	assert.match(output, /Unknown \/discover input: nonsense/);
	assert.match(output, /\/discover source add <url>/);
	const completions = command.getArgumentCompletions?.("source ") ?? [];
	assert.ok(completions.some((item) => item.value === "source list"));
	assert.ok(completions.some((item) => item.value === "source add "));
});

test("paths and help are protocol-safe outside TUI", async () => {
	const h = harness();
	await extension(h.api);
	const command = h.commands.get("discover");
	assert.ok(command);
	const paths = await captureConsole(async () => { await command.handler("paths", context("print")); });
	assert.match(paths, /\.pi\/agent\/model-discovery\.json/);
	assert.ok(paths.includes(CONFIG_PATH), "paths prints CONFIG_PATH");
	assert.equal(CONFIG_PATH, STORAGE_PATH);
	const help = await captureConsole(async () => { await command.handler("help", context("print")); });
	assert.match(help, /\/discover doctor/);
});

test("nested source actions share real registration and persistence", { concurrency: false }, async () => {
	const server = createServer((request, response) => {
		if (request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "fixture-model", owned_by: "fixture", context_window: 4096, max_tokens: 512 }] }));
			return;
		}
		response.writeHead(404);
		response.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const url = `http://127.0.0.1:${address.port}`;
		const h = harness();
		await extension(h.api);
		const command = h.commands.get("discover");
		assert.ok(command);
		const added = await captureConsole(async () => {
			await command.handler(`source add ${url} --name command-source`, context("print"));
		});
		assert.match(added, /Registered source "command-source"/);
		assert.ok(h.providers.includes("command-source"));
		assert.equal(statSync(STORAGE_PATH).mode & 0o777, 0o600);
		const saved = JSON.parse(readFileSync(STORAGE_PATH, "utf8")) as DiscoveredProvider[];
		assert.equal(saved[0]?.cachedModels?.[0]?.id, "fixture-model");

		const refused = await captureConsole(async () => {
			await command.handler("source remove command-source", context("print"));
		});
		assert.match(refused, /without --yes/);
		assert.equal((JSON.parse(readFileSync(STORAGE_PATH, "utf8")) as DiscoveredProvider[]).length, 1);

		const removed = await captureConsole(async () => {
			await command.handler("source remove command-source --yes", context("print"));
		});
		assert.match(removed, /Removed source "command-source"/);
		assert.ok(h.unregistered.includes("command-source"));
		assert.deepEqual(JSON.parse(readFileSync(STORAGE_PATH, "utf8")), []);

		const tool = h.tools[0];
		assert.ok(tool);
		const toolResult = await tool.execute("tool-call", { url, providerName: "tool-source" });
		assert.equal(toolResult.isError, undefined);
		assert.equal(toolResult.details.providerName, "tool-source");
		assert.equal(toolResult.details.modelCount, 1);
		assert.match(toolResult.content[0]?.text ?? "", /Models are now selectable via \/model/);
		assert.equal((JSON.parse(readFileSync(STORAGE_PATH, "utf8")) as DiscoveredProvider[])[0]?.name, "tool-source");
		await captureConsole(async () => {
			await command.handler("source remove tool-source --yes", context("print"));
		});
		assert.deepEqual(JSON.parse(readFileSync(STORAGE_PATH, "utf8")), []);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

// ---------------------------------------------------------------------------
// Model settings and presets on a source with a cached catalogue
// ---------------------------------------------------------------------------

const QWEN = "Qwen3.8-27B";

/** A saved source that is offline. The extension registers it from the cached catalogue. */
function offlineSource(patch: Partial<DiscoveredProvider> = {}): DiscoveredProvider {
	return {
		name: "cached-source",
		baseUrl: "http://127.0.0.1:1",
		serverType: "oMLX",
		cachedModels: [
			{ id: QWEN, owned_by: "omlx", context_window: 262144, max_tokens: 32768 },
			{ id: "embeddinggemma-2", owned_by: "omlx", model_type: "embedding" },
		],
		lastScanned: 1,
		profileSchemaVersion: 2,
		...patch,
	};
}

async function withSource(provider: DiscoveredProvider, work: (h: ReturnType<typeof harness>, run: (args: string) => Promise<string>) => Promise<void>) {
	saveProviders([provider]);
	const originalError = console.error;
	console.error = () => {};
	try {
		const h = harness();
		await extension(h.api);
		const command = h.commands.get("discover");
		assert.ok(command);
		// The result is the console text and the notifications of one command.
		await work(h, async (args) => {
			const notifications: string[] = [];
			const text = await captureConsole(async () => { await command.handler(args, context("print", [], notifications)); });
			return [text, ...notifications].filter(Boolean).join("\n");
		});
	} finally {
		console.error = originalError;
		saveProviders([]);
	}
}

const stored = () => (JSON.parse(readFileSync(STORAGE_PATH, "utf8")) as DiscoveredProvider[])[0];

test("preset set refuses an effort that the model does not accept", { concurrency: false }, async () => {
	await withSource(offlineSource(), async (_h, run) => {
		const refused = await run(`preset set cached-source ${QWEN} deep reasoning_effort high`);
		assert.match(refused, /Preset not saved: reasoning_effort must be one of: low, medium, xhigh\./);
		assert.equal(stored().modelProfiles, undefined);
		const saved = await run(`preset set cached-source ${QWEN} deep reasoning_effort xhigh`);
		assert.match(saved, /Created preset "deep"/);
		assert.deepEqual(stored().modelProfiles?.[QWEN], [
			{ slug: "deep", chatTemplateKwargs: { reasoning_effort: "xhigh" }, exposeAsModel: false },
		]);
	});
});

test("preset set keeps exposeAsModel of a stored preset", { concurrency: false }, async () => {
	const provider = offlineSource({
		modelProfiles: {
			[QWEN]: [
				{ slug: "routed", sampling: { temperature: 0.7 }, exposeAsModel: false },
				{ slug: "fixed", sampling: { temperature: 0.7 }, exposeAsModel: true },
			],
		},
	});
	await withSource(provider, async (h, run) => {
		assert.match(await run(`preset set cached-source ${QWEN} routed temperature 0.5`), /Updated preset "routed"/);
		assert.match(await run(`preset set cached-source ${QWEN} fixed temperature 0.4`), /Updated preset "fixed"/);
		assert.deepEqual(stored().modelProfiles?.[QWEN], [
			{ slug: "routed", sampling: { temperature: 0.5 }, exposeAsModel: false },
			{ slug: "fixed", sampling: { temperature: 0.4 }, exposeAsModel: true },
		]);
		// The hidden preset stays hidden and the visible preset stays visible in the model list of pi.
		const ids = h.registered.get("cached-source")?.map((model) => model.id);
		assert.deepEqual(ids, [QWEN, `${QWEN}@fixed`]);
	});
});

test("model reasoning auto and vision auto delete only that stored value", { concurrency: false }, async () => {
	const provider = offlineSource({
		modelOverrides: { [QWEN]: { reasoning: false, input: ["text"], contextWindow: 4096, family: "qwen3.8" } },
	});
	await withSource(provider, async (h, run) => {
		const base = () => h.registered.get("cached-source")?.find((model) => model.id === QWEN);
		assert.equal(base()?.reasoning, false);
		assert.deepEqual(base()?.input, ["text"]);

		assert.match(await run(`model ${QWEN} reasoning auto`), /Reasoning uses the automatic value for "Qwen3\.8-27B"/);
		assert.deepEqual(stored().modelOverrides?.[QWEN], { input: ["text"], contextWindow: 4096, family: "qwen3.8" });
		// The family value applies again: Qwen 3.8 has a thinking control.
		assert.equal(base()?.reasoning, true);

		await run(`model ${QWEN} vision auto`);
		assert.deepEqual(stored().modelOverrides?.[QWEN], { contextWindow: 4096, family: "qwen3.8" });
		assert.deepEqual(base()?.input, ["text", "image"]);
		assert.equal(base()?.contextWindow, 4096);

		await run(`model ${QWEN} vision off`);
		assert.deepEqual(stored().modelOverrides?.[QWEN], { contextWindow: 4096, family: "qwen3.8", input: ["text"] });
		await run(`model ${QWEN} vision auto`);
		await run(`model ${QWEN} family auto`);
		assert.deepEqual(stored().modelOverrides?.[QWEN], { contextWindow: 4096 });
	});

	// The last stored value goes away: no empty object stays in the file.
	await withSource(offlineSource({ modelOverrides: { [QWEN]: { reasoning: true } } }), async (_h, run) => {
		await run(`model ${QWEN} reasoning auto`);
		assert.equal(stored().modelOverrides, undefined);
	});
});

test("model settings: defaults, family and hidden change the registered models", { concurrency: false }, async () => {
	await withSource(offlineSource(), async (h, run) => {
		const models = () => h.registered.get("cached-source") ?? [];
		const base = () => models().find((model) => model.id === QWEN) as
			| { samplingParamsByThinkingLevel?: Record<string, Record<string, unknown>> }
			| undefined;
		// The embedding model is hidden by default.
		assert.deepEqual(models().map((model) => model.id), [QWEN]);
		assert.equal(base()?.samplingParamsByThinkingLevel?.off.temperature, 0.7);

		await run(`model ${QWEN} defaults off`);
		assert.deepEqual(stored().modelOverrides?.[QWEN], { familyDefaults: false });
		assert.deepEqual(base()?.samplingParamsByThinkingLevel?.off, { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } });
		await run(`model ${QWEN} defaults on`);
		assert.equal(stored().modelOverrides, undefined);

		assert.match(await run(`model ${QWEN} family nope`), /Unknown family "nope"/);
		await run(`model ${QWEN} family none`);
		assert.deepEqual(stored().modelOverrides?.[QWEN], { family: "none" });
		assert.equal(base()?.samplingParamsByThinkingLevel, undefined);
		await run(`model ${QWEN} family auto`);

		await run("model embeddinggemma-2 hidden off");
		assert.deepEqual(stored().modelOverrides, { "embeddinggemma-2": { hidden: false } });
		assert.deepEqual(models().map((model) => model.id), [QWEN, "embeddinggemma-2"]);
		await run("model embeddinggemma-2 hidden on");
		assert.equal(stored().modelOverrides, undefined);
		await run(`model ${QWEN} hidden on`);
		assert.deepEqual(stored().modelOverrides, { [QWEN]: { hidden: true } });
		// Each model is hidden now: the provider is removed from pi.
		assert.ok(h.unregistered.includes("cached-source"));
	});
});

test("preset defaults copies the recommended presets and needs --yes to replace a preset", { concurrency: false }, async () => {
	await withSource(offlineSource(), async (h, run) => {
		assert.match(await run(`preset defaults cached-source ${QWEN}`), /Copied 4 recommended preset\(s\) of Qwen 3\.8/);
		assert.deepEqual(stored().modelProfiles?.[QWEN].map((preset) => preset.slug), ["instruct", "thinking-low", "thinking-medium", "thinking-xhigh"]);
		assert.equal(stored().modelProfileRouting?.[QWEN].aliasSlug, "adaptive");
		assert.deepEqual(h.registered.get("cached-source")?.map((model) => model.id), [QWEN, `${QWEN}@adaptive`]);

		await run(`preset set cached-source ${QWEN} instruct temperature 0.1`);
		assert.match(await run(`preset defaults cached-source ${QWEN}`), /Refusing to replace the stored preset\(s\) "instruct", "thinking-low", "thinking-medium", "thinking-xhigh".*without --yes/);
		assert.equal(stored().modelProfiles?.[QWEN][0].sampling?.temperature, 0.1);
		await run(`preset defaults cached-source ${QWEN} --yes`);
		assert.equal(stored().modelProfiles?.[QWEN][0].sampling?.temperature, 0.7);

		assert.match(await run("preset defaults cached-source embeddinggemma-2"), /has no recommended presets/);
	});
});

test("routing conventional uses the preset kinds of the model", { concurrency: false }, async () => {
	// Gemma 4 has a switch and no effort: the kinds are "off" and "on".
	const provider = offlineSource({
		cachedModels: [{ id: "gemma-4-e4b", owned_by: "omlx" }],
		modelProfiles: {
			"gemma-4-e4b": [
				{ slug: "fast", chatTemplateKwargs: { enable_thinking: false }, exposeAsModel: false },
				{ slug: "think", chatTemplateKwargs: { enable_thinking: true }, exposeAsModel: false },
			],
		},
	});
	await withSource(provider, async (_h, run) => {
		assert.match(await run("routing conventional cached-source gemma-4-e4b"), /Presets mapped by kind on "gemma-4-e4b": off=fast, minimal=think/);
		assert.deepEqual(stored().modelProfileRouting?.["gemma-4-e4b"].levels, {
			off: "fast", minimal: "think", low: "think", medium: "think", high: "think", xhigh: "think", max: "think",
		});
	});
	// Qwen 3.8 needs off, low, medium and xhigh. One preset is not enough.
	await withSource(offlineSource({ modelProfiles: { [QWEN]: [{ slug: "fast", chatTemplateKwargs: { enable_thinking: false } }] } }), async (_h, run) => {
		assert.match(await run(`routing conventional cached-source ${QWEN}`), /needs one preset for each kind: off, low, medium, xhigh \(missing low; missing medium; missing xhigh\)/);
	});
});

test("doctor shows the family data in use", async () => {
	const h = harness();
	await extension(h.api);
	const command = h.commands.get("discover");
	assert.ok(command);
	const doctor = await captureConsole(async () => { await command.handler("doctor", context("print")); });
	assert.match(doctor, /Model family data\n\s+Family data layer: bundled\n\s+Revision: \d+/);
});

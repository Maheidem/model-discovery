import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { STORAGE_PATH, type DiscoveredProvider } from "./storage.ts";
import { HOME_PANEL_ROWS } from "./ui/home.ts";
import { modelDiscoveryVersion } from "./version.ts";

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
	const api = {
		registerCommand: (name: string, command: CommandRegistration) => commands.set(name, command),
		registerTool: (tool: ToolRegistration) => tools.push(tool),
		on: (event: string) => { events.push(event); },
		registerProvider: (name: string) => { providers.push(name); },
		unregisterProvider: (name: string) => { unregistered.push(name); },
		setModel: async () => {},
	} as unknown as ExtensionAPI;
	return { api, commands, tools, events, providers, unregistered };
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

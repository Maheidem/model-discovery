/**
 * Model Discovery Extension
 *
 * Single entry point: /discover — opens a full TUI to manage OpenAI-compatible
 * endpoints (llama.cpp, oMLX, Ollama, vLLM, ...). Reads the actual
 * server-reported configuration (no hardcoded model database) and asks for
 * anything the server doesn't provide.
 *
 * Usage:
 *   /discover                    # open the management UI
 *   /discover http://ip:port     # jump straight into adding that endpoint
 *
 * The LLM can also call the `discover_models` tool.
 * Discovered providers persist across sessions in ~/.pi/agent/model-discovery.json
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelOverride {
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
}

interface DiscoveredProvider {
	name: string;
	baseUrl: string;
	apiKey?: string;
	serverType?: string;
	defaultContextWindow?: number;
	defaultMaxTokens?: number;
	modelOverrides?: Record<string, ModelOverride>;
	compat?: Record<string, unknown>;
	lastScanned?: number;
}

interface ModelConfig {
	id: string;
	name: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean | null;
	input: string[] | null;
	source: string;
	loaded?: boolean;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const STORAGE_PATH = join(os.homedir(), ".pi", "agent", "model-discovery.json");

function loadProviders(): DiscoveredProvider[] {
	try {
		if (existsSync(STORAGE_PATH)) {
			return JSON.parse(readFileSync(STORAGE_PATH, "utf-8")) as DiscoveredProvider[];
		}
	} catch {
		/* ignore */
	}
	return [];
}

function saveProviders(providers: DiscoveredProvider[]): void {
	writeFileSync(STORAGE_PATH, JSON.stringify(providers, null, 2), "utf-8");
}

function upsertProvider(provider: DiscoveredProvider): void {
	const all = loadProviders();
	const idx = all.findIndex((p) => p.name === provider.name);
	if (idx >= 0) all[idx] = provider;
	else all.push(provider);
	saveProviders(all);
}

function deleteProvider(name: string): void {
	saveProviders(loadProviders().filter((p) => p.name !== name));
}

// ---------------------------------------------------------------------------
// Server detection & model config extraction (reads real server data)
// ---------------------------------------------------------------------------

function detectServerType(headers: Headers, models: Record<string, unknown>[]): string {
	const server = (headers.get("server") ?? "").toLowerCase();
	const poweredBy = (headers.get("x-powered-by") ?? "").toLowerCase();

	if (server.includes("llama-cpp") || server.includes("llama.cpp")) return "llama.cpp";
	if (server.includes("ollama")) return "Ollama";
	if (server.includes("vllm")) return "vLLM";
	if (server.includes("sglang")) return "SGLang";
	if (server.includes("lm-studio")) return "LM Studio";
	if (server.includes("omlx") || poweredBy.includes("omlx")) return "oMLX";

	for (const m of models) {
		const ownedBy = String(m.owned_by ?? "").toLowerCase();
		if (ownedBy === "omlx") return "oMLX";
		if (ownedBy === "vllm") return "vLLM";
		if (ownedBy === "llamacpp") return "llama.cpp";
	}
	for (const m of models) {
		if (String(m.id ?? "").includes(":")) return "Ollama";
	}
	return "OpenAI-compatible";
}

function tryNum(v: unknown): number | null {
	if (typeof v === "number" && !isNaN(v)) return v;
	if (typeof v === "string") {
		const n = parseInt(v, 10);
		return isNaN(n) ? null : n;
	}
	return null;
}

function parseArgValue(args: string[] | undefined, flag: string): number | null {
	if (!args) return null;
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === flag) {
			const n = parseInt(args[i + 1], 10);
			return isNaN(n) ? null : n;
		}
	}
	return null;
}

function parsePresetValue(preset: string | undefined, key: string): number | null {
	if (!preset) return null;
	const m = preset.match(new RegExp(`${key}\\s*=\\s*(\\d+)`, "i"));
	if (m) {
		const n = parseInt(m[1], 10);
		return isNaN(n) ? null : n;
	}
	return null;
}

/**
 * Extract model config from whatever the server actually reports.
 * Returns null for any field the server doesn't provide.
 */
function extractModelConfig(raw: Record<string, unknown>): ModelConfig {
	const id = String(raw.id ?? "");
	const name = String(raw.name ?? id);
	const status = (raw.status && typeof raw.status === "object" ? raw.status : undefined) as
		| Record<string, unknown>
		| undefined;
	const args = status?.args as string[] | undefined;
	const preset = status?.preset as string | undefined;

	// Context window: standard fields, then llama.cpp args/preset, then loaded meta
	let contextWindow =
		tryNum(raw.context_length) ??
		tryNum(raw.context_window) ??
		tryNum(raw.max_model_len) ??
		tryNum(raw.max_context_len) ??
		tryNum(raw.max_context_length) ??
		parseArgValue(args, "--ctx-size") ??
		parsePresetValue(preset, "ctx-size");
	if (contextWindow === null && raw.meta && typeof raw.meta === "object") {
		contextWindow = tryNum((raw.meta as Record<string, unknown>).n_ctx);
	}

	// Max output tokens
	const maxTokens =
		tryNum(raw.max_tokens) ??
		tryNum(raw.max_output_tokens) ??
		tryNum(raw.max_completion_tokens) ??
		parseArgValue(args, "--n-predict") ??
		parsePresetValue(preset, "n-predict");

	// Reasoning
	let reasoning: boolean | null = null;
	if (Array.isArray(raw.capabilities)) reasoning = (raw.capabilities as string[]).includes("reasoning");
	if (reasoning === null && raw.reasoning !== undefined) reasoning = !!raw.reasoning;
	if (reasoning === null) {
		const budget = parseArgValue(args, "--reasoning-budget") ?? parsePresetValue(preset, "reasoning-budget");
		if (budget !== null) reasoning = budget !== 0;
	}

	// Input modalities
	let input: string[] | null = null;
	if (raw.architecture && typeof raw.architecture === "object") {
		const modalities = (raw.architecture as Record<string, unknown>).input_modalities as string[] | undefined;
		if (Array.isArray(modalities) && modalities.length > 0) {
			input = [];
			for (const m of modalities) {
				const l = m.toLowerCase();
				if (l.includes("text") && !input.includes("text")) input.push("text");
				if ((l.includes("image") || l.includes("vision")) && !input.includes("image")) input.push("image");
			}
		}
	}
	if (!input && Array.isArray(raw.input)) input = raw.input as string[];
	if (input && !input.includes("image") && args?.some((a) => a.startsWith("--mmproj"))) {
		input.push("image");
	}

	const loaded = status?.value === "loaded" ? true : status?.value === "unloaded" ? false : undefined;
	const source = String(raw.source ?? (status ? "server args" : "api"));

	return { id, name, contextWindow, maxTokens, reasoning, input, source, loaded };
}

async function fetchModels(
	baseUrl: string,
	apiKey?: string,
	signal?: AbortSignal,
): Promise<{ models: Record<string, unknown>[]; serverType: string }> {
	const url = baseUrl.replace(/\/+$/, "") + "/v1/models";
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	const models = (data.data as Record<string, unknown>[]) ?? [];
	return { models, serverType: detectServerType(response.headers, models) };
}

function generateProviderName(url: string): string {
	try {
		const u = new URL(url);
		return `local-${u.hostname.replace(/\./g, "-")}${u.port ? `-${u.port}` : ""}`;
	} catch {
		return `local-${Date.now()}`;
	}
}

function fmt(n: number | null | undefined): string {
	if (n === null || n === undefined) return "?";
	// Use comma grouping regardless of system locale (avoid "262.144" confusion).
	return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// Provider registration with Pi's model registry
	// -----------------------------------------------------------------------

	async function registerProvider(
		provider: DiscoveredProvider,
		prefetched?: { models: Record<string, unknown>[]; serverType: string },
	): Promise<{ models: ModelConfig[]; serverType: string }> {
		const { models, serverType } = prefetched ?? (await fetchModels(provider.baseUrl, provider.apiKey, AbortSignal.timeout(2_000)));
		if (models.length === 0) throw new Error("No models found at this endpoint.");

		const compat: Record<string, unknown> = { ...provider.compat };
		if (serverType === "llama.cpp" || serverType === "oMLX" || serverType === "Ollama") {
			if (compat.supportsDeveloperRole === undefined) compat.supportsDeveloperRole = false;
		}
		if (serverType === "oMLX") {
			// oMLX uses chat_template_kwargs for reasoning toggling
			if (compat.thinkingFormat === undefined) compat.thinkingFormat = "qwen-chat-template";
			if (compat.supportsReasoningEffort === undefined) compat.supportsReasoningEffort = true;
		}

		// NOTE: Pi's applyExtension() spreads model definitions but does NOT merge
		// provider-level compat into individual models. So we must attach compat
		// to each model directly — otherwise getCompat(model) returns no thinkingFormat.

		const configs = models.map(extractModelConfig);
		const piModels = configs.map((c) => {
			const ov = provider.modelOverrides?.[c.id];
			// For oMLX, auto-detect reasoning capability on Qwen models
			const serverReasoning =
				serverType === "oMLX" && !c.reasoning
					? /^qwen/i.test(c.id) || /^qwen/i.test(c.name)
					: false;
			return {
				id: c.id,
				name: c.name,
				reasoning: ov?.reasoning ?? c.reasoning ?? serverReasoning,
				input: ov?.input ?? c.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: ov?.contextWindow ?? c.contextWindow ?? provider.defaultContextWindow ?? 128_000,
				maxTokens: ov?.maxTokens ?? c.maxTokens ?? provider.defaultMaxTokens ?? 16_384,
				compat: compat, // attach compat to each model (Pi's applyExtension doesn't merge provider-level compat)
			};
		});

				// OpenAI SDK appends /chat/completions to baseUrl.
		// Ensure baseUrl ends with /v1 so the full URL is .../v1/chat/completions.
		const sdkBaseUrl = provider.baseUrl.replace(/\/v1\/?$/, '') + '/v1';
		pi.registerProvider(provider.name, {
			name: `${serverType} (${provider.name})`,
			baseUrl: sdkBaseUrl,
			apiKey: provider.apiKey || "local",
			api: "openai-completions",
			compat,
			models: piModels,
		});

		provider.serverType = serverType;
		provider.lastScanned = Date.now();
		return { models: configs, serverType };
	}

	// Register saved providers at startup (concurrent — one dead endpoint can't block the others)
	const providers = loadProviders();
	if (providers.length > 0) {
		const results = await Promise.allSettled(
			providers.map(async (provider) => {
				await registerProvider(provider);
				return provider.name;
			}),
		);
		for (const result of results) {
			if (result.status === "rejected") {
				console.error(`[model-discovery] Failed to register a provider:`, result.reason);
			}
		}
	}

	// -----------------------------------------------------------------------
	// UI helpers (Pi-standard SelectList dialog)
	// -----------------------------------------------------------------------

	async function runSelect(
		ctx: ExtensionCommandContext,
		title: string,
		items: SelectItem[],
		headerLines: string[] = [],
	): Promise<string | null> {
		return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			for (const line of headerLines) {
				container.addChild(new Text(theme.fg("muted", line), 1, 0));
			}

			const selectList = new SelectList(items, Math.min(items.length, 12), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);

			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back • type to filter"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	async function runLoader<T>(
		ctx: ExtensionCommandContext,
		message: string,
		work: (signal: AbortSignal) => Promise<T>,
	): Promise<T | null> {
		return await ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, message);
			loader.onAbort = () => done(null);
			work(loader.signal)
				.then((result) => done(result))
				.catch((err) => {
					ctx.ui.notify(`${err instanceof Error ? err.message : String(err)}`, "error");
					done(null);
				});
			return loader;
		});
	}

	async function askNumber(
		ctx: ExtensionCommandContext,
		title: string,
		placeholder: string,
	): Promise<number | undefined> {
		const raw = (await ctx.ui.input(title, placeholder))?.trim();
		if (!raw) return undefined;
		const n = parseInt(raw.replace(/[,._\s]/g, ""), 10);
		return isNaN(n) ? undefined : n;
	}

	function modelFlags(c: ModelConfig, ov?: ModelOverride): string {
		const flags: string[] = [];
		const input = ov?.input ?? c.input;
		const reasoning = ov?.reasoning ?? c.reasoning;
		if (input?.includes("image")) flags.push("vision");
		if (reasoning === true) flags.push("reasoning");
		if (reasoning === null && ov?.reasoning === undefined) flags.push("reasoning?");
		if (c.loaded === true) flags.push("loaded");
		return flags.length > 0 ? ` [${flags.join(", ")}]` : "";
	}

	function modelDescription(c: ModelConfig, provider?: DiscoveredProvider): string {
		const ov = provider?.modelOverrides?.[c.id];
		const ctxVal = ov?.contextWindow ?? c.contextWindow ?? provider?.defaultContextWindow ?? null;
		const maxVal = ov?.maxTokens ?? c.maxTokens ?? provider?.defaultMaxTokens ?? null;
		const ovMark = ov && Object.keys(ov).length > 0 ? " (edited)" : "";
		return `ctx ${fmt(ctxVal)} · max ${fmt(maxVal)} · ${c.source}${ovMark}`;
	}

	// -----------------------------------------------------------------------
	// Screen: model detail / edit
	// -----------------------------------------------------------------------

	async function showModelScreen(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		config: ModelConfig,
	): Promise<void> {
		for (;;) {
			const ov = provider.modelOverrides?.[config.id] ?? {};
			const effCtx = ov.contextWindow ?? config.contextWindow ?? provider.defaultContextWindow ?? null;
			const effMax = ov.maxTokens ?? config.maxTokens ?? provider.defaultMaxTokens ?? null;
			const effReasoning = ov.reasoning ?? config.reasoning;
			const effInput = ov.input ?? config.input ?? ["text"];

			const header = [
				`server reports: ctx ${fmt(config.contextWindow)} · max ${fmt(config.maxTokens)} · reasoning ${
					config.reasoning === null ? "unknown" : config.reasoning
				} (${config.source})`,
				`effective:      ctx ${fmt(effCtx)} · max ${fmt(effMax)} · reasoning ${
					effReasoning === null ? "unknown" : effReasoning
				} · input ${effInput.join("+")}`,
			];

			const items: SelectItem[] = [
				{ value: "ctx", label: "Set context window", description: `current: ${fmt(effCtx)}` },
				{ value: "max", label: "Set max output tokens", description: `current: ${fmt(effMax)}` },
				{
					value: "reasoning",
					label: "Toggle reasoning",
					description: `current: ${effReasoning === null ? "unknown" : effReasoning ? "on" : "off"}`,
				},
			];
			if (Object.keys(ov).length > 0) {
				items.push({ value: "clear", label: "Clear overrides", description: "revert to server-reported values" });
			}
			items.push({ value: "back", label: "← Back" });

			const action = await runSelect(ctx, `Model: ${config.id}${modelFlags(config, ov)}`, items, header);
			if (!action || action === "back") return;

			if (action === "ctx") {
				const n = await askNumber(ctx, `Context window for ${config.id}`, String(effCtx ?? 128000));
				if (n !== undefined) {
					provider.modelOverrides = { ...provider.modelOverrides, [config.id]: { ...ov, contextWindow: n } };
				}
			} else if (action === "max") {
				const n = await askNumber(ctx, `Max output tokens for ${config.id}`, String(effMax ?? 16384));
				if (n !== undefined) {
					provider.modelOverrides = { ...provider.modelOverrides, [config.id]: { ...ov, maxTokens: n } };
				}
			} else if (action === "reasoning") {
				provider.modelOverrides = {
					...provider.modelOverrides,
					[config.id]: { ...ov, reasoning: !(effReasoning ?? false) },
				};
			} else if (action === "clear") {
				if (provider.modelOverrides) {
					delete provider.modelOverrides[config.id];
					if (Object.keys(provider.modelOverrides).length === 0) provider.modelOverrides = undefined;
				}
			}

			// Persist + re-register with new values
			upsertProvider(provider);
			try {
				await registerProvider(provider);
			} catch {
				/* endpoint may be down; overrides still saved */
			}
		}
	}

	// -----------------------------------------------------------------------
	// Screen: endpoint detail
	// -----------------------------------------------------------------------

	async function showEndpointScreen(ctx: ExtensionCommandContext, provider: DiscoveredProvider): Promise<void> {
		// Fetch live data
		let live = await runLoader(ctx, `Scanning ${provider.baseUrl}...`, (signal) =>
			fetchModels(provider.baseUrl, provider.apiKey, signal),
		);

		for (;;) {
			const header: string[] = [];
			let configs: ModelConfig[] = [];
			if (live) {
				configs = live.models.map(extractModelConfig);
				header.push(`${live.serverType} · ${provider.baseUrl} · online · ${configs.length} model(s)`);
			} else {
				header.push(`${provider.serverType ?? "?"} · ${provider.baseUrl} · OFFLINE (showing saved config)`);
			}
			if (provider.lastScanned) {
				header.push(`last scan: ${new Date(provider.lastScanned).toLocaleString()}`);
			}

			const items: SelectItem[] = configs.map((c) => ({
				value: `model:${c.id}`,
				label: `${c.id}${modelFlags(c, provider.modelOverrides?.[c.id])}`,
				description: modelDescription(c, provider),
			}));
			items.push({ value: "rescan", label: "⟳ Re-scan endpoint", description: "fetch fresh model list and re-register" });
			items.push({
				value: "defaults",
				label: "✎ Edit fallback defaults",
				description: `used when server reports nothing — ctx ${fmt(provider.defaultContextWindow ?? null)} · max ${fmt(provider.defaultMaxTokens ?? null)}`,
			});
			items.push({ value: "remove", label: "✗ Remove endpoint", description: "unregister provider and delete saved config" });
			items.push({ value: "back", label: "← Back" });

			const action = await runSelect(ctx, `Endpoint: ${provider.name}`, items, header);
			if (!action || action === "back") return;

			if (action.startsWith("model:")) {
				const id = action.slice("model:".length);
				const config = configs.find((c) => c.id === id);
				if (config) await showModelScreen(ctx, provider, config);
			} else if (action === "rescan") {
				live = await runLoader(ctx, `Scanning ${provider.baseUrl}...`, (signal) =>
					fetchModels(provider.baseUrl, provider.apiKey, signal),
				);
				if (live) {
					try {
						await registerProvider(provider, live);
						upsertProvider(provider);
						ctx.ui.notify(`Re-registered ${live.models.length} model(s) from ${live.serverType}.`, "success");
					} catch (err) {
						ctx.ui.notify(`${err instanceof Error ? err.message : String(err)}`, "error");
					}
				}
			} else if (action === "defaults") {
				const cw = await askNumber(ctx, "Default context window (blank = keep)", String(provider.defaultContextWindow ?? 128000));
				if (cw !== undefined) provider.defaultContextWindow = cw;
				const mt = await askNumber(ctx, "Default max output tokens (blank = keep)", String(provider.defaultMaxTokens ?? 16384));
				if (mt !== undefined) provider.defaultMaxTokens = mt;
				upsertProvider(provider);
				try {
					await registerProvider(provider, live ?? undefined);
				} catch {
					/* offline */
				}
			} else if (action === "remove") {
				const sure = await ctx.ui.confirm("Remove endpoint", `Remove "${provider.name}" (${provider.baseUrl})?`);
				if (sure) {
					pi.unregisterProvider(provider.name);
					deleteProvider(provider.name);
					ctx.ui.notify(`Removed "${provider.name}".`, "success");
					return;
				}
			}
		}
	}

	// -----------------------------------------------------------------------
	// Screen: add endpoint
	// -----------------------------------------------------------------------

	async function showAddScreen(ctx: ExtensionCommandContext, presetUrl?: string): Promise<void> {
		let baseUrl = presetUrl ?? (await ctx.ui.input("Endpoint URL", "http://192.168.1.100:8080"))?.trim();
		if (!baseUrl) return;
		if (!baseUrl.startsWith("http")) baseUrl = `http://${baseUrl}`;
		baseUrl = baseUrl.replace(/\/+$/, "");

		// Probe endpoint first — availability check
		let live = await runLoader(ctx, `Probing ${baseUrl}...`, (signal) => fetchModels(baseUrl, undefined, signal));

		// If unauthorized or failed, offer API key
		let apiKey: string | undefined;
		if (!live) {
			const retry = await ctx.ui.confirm("Endpoint unreachable or refused", "Try again with an API key?");
			if (!retry) return;
			apiKey = (await ctx.ui.input("API key", ""))?.trim() || undefined;
			live = await runLoader(ctx, `Probing ${baseUrl} with key...`, (signal) => fetchModels(baseUrl, apiKey, signal));
			if (!live) return;
		}

		if (live.models.length === 0) {
			ctx.ui.notify("Endpoint is online but reports no models.", "warning");
			return;
		}

		const name = (await ctx.ui.input("Provider name", generateProviderName(baseUrl)))?.trim() || generateProviderName(baseUrl);

		const provider: DiscoveredProvider = { name, baseUrl, apiKey };
		const configs = live.models.map(extractModelConfig);

		// Review screen: show exactly what the server reports
		const header = [`${live.serverType} · ${baseUrl} · online · ${configs.length} model(s)`];
		const missing = configs.filter((c) => c.contextWindow === null || c.maxTokens === null || c.reasoning === null);
		if (missing.length > 0) {
			header.push(`${missing.length} model(s) have values the server didn't report (shown as ?)`);
		}

		for (;;) {
			const items: SelectItem[] = configs.map((c) => ({
				value: `model:${c.id}`,
				label: `${c.id}${modelFlags(c, provider.modelOverrides?.[c.id])}`,
				description: modelDescription(c, provider),
			}));
			items.push({ value: "register", label: "✓ Register endpoint", description: `save as "${name}" and make models available in /model` });
			items.push({ value: "cancel", label: "✗ Cancel" });

			const action = await runSelect(ctx, `Review: ${name}`, items, header);
			if (!action || action === "cancel") {
				ctx.ui.notify("Discovery cancelled.", "info");
				return;
			}

			if (action.startsWith("model:")) {
				const id = action.slice("model:".length);
				const config = configs.find((c) => c.id === id);
				if (config) {
					// During add flow, edit without registering yet
					const ov = provider.modelOverrides?.[config.id] ?? {};
					const effCtx = ov.contextWindow ?? config.contextWindow;
					const effMax = ov.maxTokens ?? config.maxTokens;
					const cw = await askNumber(ctx, `Context window for ${config.id} (blank = keep)`, String(effCtx ?? 128000));
					if (cw !== undefined) provider.modelOverrides = { ...provider.modelOverrides, [config.id]: { ...ov, contextWindow: cw } };
					const updated = provider.modelOverrides?.[config.id] ?? ov;
					const mt = await askNumber(ctx, `Max output tokens for ${config.id} (blank = keep)`, String(effMax ?? 16384));
					if (mt !== undefined) provider.modelOverrides = { ...provider.modelOverrides, [config.id]: { ...updated, maxTokens: mt } };
				}
				continue;
			}

			if (action === "register") {
				// If values are still missing, ask for provider-wide fallbacks
				const stillMissingCtx = configs.some(
					(c) => (provider.modelOverrides?.[c.id]?.contextWindow ?? c.contextWindow) === null,
				);
				const stillMissingMax = configs.some(
					(c) => (provider.modelOverrides?.[c.id]?.maxTokens ?? c.maxTokens) === null,
				);
				if (stillMissingCtx) {
					provider.defaultContextWindow = await askNumber(ctx, "Fallback context window for unreported models", "128000");
				}
				if (stillMissingMax) {
					provider.defaultMaxTokens = await askNumber(ctx, "Fallback max output tokens for unreported models", "16384");
				}

				const existing = loadProviders().find((p) => p.name === name);
				if (existing) pi.unregisterProvider(name);

				try {
					await registerProvider(provider, live);
					upsertProvider(provider);
					ctx.ui.notify(
						`Registered ${configs.length} model(s) from ${live.serverType} as "${name}". Use /model to select.`,
						"success",
					);
				} catch (err) {
					ctx.ui.notify(`Failed to register: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}
		}
	}

	// -----------------------------------------------------------------------
	// Screen: main menu
	// -----------------------------------------------------------------------

	async function showMainScreen(ctx: ExtensionCommandContext): Promise<void> {
		for (;;) {
			const providers = loadProviders();
			const items: SelectItem[] = providers.map((p) => ({
				value: `provider:${p.name}`,
				label: p.name,
				description: `${p.serverType ?? "?"} · ${p.baseUrl} · scanned ${
					p.lastScanned ? new Date(p.lastScanned).toLocaleString() : "never"
				}`,
			}));
			items.push({ value: "add", label: "+ Add endpoint", description: "discover models from an OpenAI-compatible server" });
			if (providers.length > 0) {
				items.push({ value: "rescan-all", label: "⟳ Re-scan all", description: "refresh model lists from every endpoint" });
			}
			items.push({ value: "quit", label: "✗ Close" });

			const action = await runSelect(ctx, "Model Discovery", items, [
				providers.length === 0 ? "No endpoints yet — add your first one." : `${providers.length} endpoint(s) registered`,
			]);
			if (!action || action === "quit") return;

			if (action === "add") {
				await showAddScreen(ctx);
			} else if (action === "rescan-all") {
				const results = await runLoader(ctx, "Re-scanning all endpoints...", async () => {
					let ok = 0;
					let fail = 0;
					for (const provider of loadProviders()) {
						try {
							pi.unregisterProvider(provider.name);
							await registerProvider(provider);
							upsertProvider(provider);
							ok++;
						} catch {
							fail++;
						}
					}
					return { ok, fail };
				});
				if (results) {
					const level = results.fail === 0 ? "success" : "warning";
					ctx.ui.notify(`Re-scanned ${results.ok} endpoint(s)${results.fail ? `, ${results.fail} failed` : ""}.`, level);
				}
			} else if (action.startsWith("provider:")) {
				const name = action.slice("provider:".length);
				const provider = loadProviders().find((p) => p.name === name);
				if (provider) await showEndpointScreen(ctx, provider);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Command: /discover — single entry point
	// -----------------------------------------------------------------------

	pi.registerCommand("discover", {
		description: "Manage local model endpoints (llama.cpp, oMLX, Ollama, vLLM, ...)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/discover requires interactive mode", "error");
				return;
			}
			const url = args?.trim();
			if (url) {
				await showAddScreen(ctx, url.startsWith("http") ? url : `http://${url}`);
			} else {
				await showMainScreen(ctx);
			}
		},
	});

	// -----------------------------------------------------------------------
	// Tool: discover_models (LLM-callable)
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "discover_models",
		label: "Discover Models",
		description:
			"Discover and register models from an OpenAI-compatible endpoint (llama.cpp, oMLX, Ollama, vLLM). Reads actual server config. Use when the user asks to add a local model server.",
		parameters: Type.Object({
			url: Type.String({ description: "Base URL of the OpenAI-compatible endpoint (e.g., http://localhost:8080)" }),
			providerName: Type.Optional(Type.String({ description: "Name for the provider (auto-generated if omitted)" })),
			apiKey: Type.Optional(Type.String({ description: "API key if required" })),
		}),
		async execute(_toolCallId, params) {
			let { url, providerName, apiKey } = params;
			if (!url.startsWith("http")) url = `http://${url}`;
			url = url.replace(/\/+$/, "");
			providerName = providerName || generateProviderName(url);

			let live: { models: Record<string, unknown>[]; serverType: string };
			try {
				live = await fetchModels(url, apiKey);
			} catch (err) {
				return {
					content: [
						{ type: "text", text: `Endpoint unavailable: ${err instanceof Error ? err.message : String(err)}` },
					],
					details: {},
					isError: true,
				};
			}
			if (live.models.length === 0) {
				return { content: [{ type: "text", text: "Endpoint online but reports no models." }], details: {} };
			}

			const existing = loadProviders().find((p) => p.name === providerName);
			const provider: DiscoveredProvider = existing
				? { ...existing, baseUrl: url, apiKey: apiKey ?? existing.apiKey }
				: { name: providerName, baseUrl: url, apiKey };
			if (existing) pi.unregisterProvider(providerName);

			try {
				const { models: configs } = await registerProvider(provider, live);
				upsertProvider(provider);

				const lines = configs.map(
					(c) =>
						`- ${c.id}${modelFlags(c, provider.modelOverrides?.[c.id])}: ${modelDescription(c, provider)}`,
				);
				const missing = configs.filter((c) => c.contextWindow === null || c.maxTokens === null);
				const note =
					missing.length > 0
						? `\n\n${missing.length} model(s) had unreported values (defaults applied: ctx ${fmt(provider.defaultContextWindow ?? 128000)}, max ${fmt(provider.defaultMaxTokens ?? 16384)}). The user can fine-tune them via /discover.`
						: "";

				return {
					content: [
						{
							type: "text",
							text: `Endpoint online (${live.serverType}). Registered ${configs.length} model(s) as "${providerName}":\n${lines.join("\n")}${note}\n\nModels are now selectable via /model.`,
						},
					],
					details: { providerName, serverType: live.serverType, modelCount: configs.length },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Failed to register: ${err instanceof Error ? err.message : String(err)}` }],
					details: {},
					isError: true,
				};
			}
		},
	});
}

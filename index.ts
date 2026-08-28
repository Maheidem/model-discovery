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

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Container, Input, type SelectItem, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	analyzeExplicitProfileRouting,
	applyThinkingProfileRoute,
	buildProfileSamplingParams,
	describeChatTemplateKwargs,
	describeProfileSampling,
	expandAdaptiveProfileRouters,
	expandModelProfiles,
	migrateLegacyProfileRouting,
	profileModelId,
	REASONING_EFFORTS,
	repetitionPenaltyKeyForServer,
	THINKING_LEVELS,
	type ModelProfile,
	type ModelProfileRouting,
	type ProfileSampling,
	type ThinkingLevel,
	type ThinkingProfileRoutes,
	validateModelProfile,
	validateProfileSampling,
	validateProfileSlug,
} from "./profiles.ts";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
	modelProfiles?: Record<string, ModelProfile[]>;
	modelProfileRouting?: Record<string, ModelProfileRouting>;
	profileSchemaVersion?: number;
	cachedModels?: Record<string, unknown>[];
	compat?: Record<string, unknown>;
	/** Last successful live catalogue refresh (legacy name retained in storage). */
	lastScanned?: number;
	lastScanAttempt?: number;
	lastScanError?: string;
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

function writeProvidersAtomic(providers: DiscoveredProvider[]): void {
	const tempPath = `${STORAGE_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tempPath, JSON.stringify(providers, null, 2), { encoding: "utf-8", mode: 0o600 });
		renameSync(tempPath, STORAGE_PATH);
	} catch (error) {
		try {
			if (existsSync(tempPath)) unlinkSync(tempPath);
		} catch {
			/* best-effort cleanup */
		}
		throw error;
	}
}

function loadProviders(): DiscoveredProvider[] {
	try {
		if (existsSync(STORAGE_PATH)) {
			const providers = JSON.parse(readFileSync(STORAGE_PATH, "utf-8")) as DiscoveredProvider[];
			let migrated = false;
			for (const provider of providers) {
				if ((provider.profileSchemaVersion ?? 0) >= 2) continue;
				for (const [modelId, rawProfiles] of Object.entries(provider.modelProfiles ?? {})) {
					if (!Array.isArray(rawProfiles)) continue;
					const result = migrateLegacyProfileRouting(rawProfiles, provider.modelProfileRouting?.[modelId]);
					if (!result.changed || !result.routing) continue;
					provider.modelProfiles = { ...provider.modelProfiles, [modelId]: result.profiles };
					provider.modelProfileRouting = { ...provider.modelProfileRouting, [modelId]: result.routing };
					migrated = true;
				}
				provider.profileSchemaVersion = 2;
				migrated = true;
			}
			if (migrated) writeProvidersAtomic(providers);
			return providers;
		}
	} catch {
		/* ignore */
	}
	return [];
}

function saveProviders(providers: DiscoveredProvider[]): void {
	writeProvidersAtomic(providers);
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function redactSecret(value: string, secret?: string): string {
	return secret ? value.replaceAll(secret, "[redacted]") : value;
}

function persistProviderScanState(provider: DiscoveredProvider): void {
	try {
		const providers = loadProviders();
		const stored = providers.find((candidate) => candidate.name === provider.name && candidate.baseUrl === provider.baseUrl);
		if (!stored) return;
		stored.serverType = provider.serverType;
		stored.cachedModels = provider.cachedModels;
		stored.lastScanned = provider.lastScanned;
		stored.lastScanAttempt = provider.lastScanAttempt;
		stored.lastScanError = provider.lastScanError;
		saveProviders(providers);
	} catch (error) {
		// Runtime registration must not fail merely because scan metadata could not be persisted.
		console.error(`[model-discovery] ${provider.name}: could not persist catalogue state (${errorMessage(error)}).`);
	}
}

function recordSuccessfulScan(
	provider: DiscoveredProvider,
	models: Record<string, unknown>[],
	serverType: string,
	persist = true,
): void {
	const now = Date.now();
	provider.serverType = serverType;
	provider.cachedModels = models;
	provider.lastScanned = now;
	provider.lastScanAttempt = now;
	provider.lastScanError = undefined;
	if (persist) persistProviderScanState(provider);
}

function recordFailedScan(provider: DiscoveredProvider, error: unknown, persist = true): void {
	provider.lastScanAttempt = Date.now();
	provider.lastScanError = redactSecret(errorMessage(error), provider.apiKey);
	if (persist) persistProviderScanState(provider);
}

function renameProvider(oldName: string, newName: string): boolean {
	const all = loadProviders();
	const idx = all.findIndex((p) => p.name === oldName);
	if (idx < 0) return false;
	if (all.some((p) => p.name === newName)) return false; // name already taken
	all[idx].name = newName;
	saveProviders(all);
	return true;
}

function getModelProfiles(provider: DiscoveredProvider, modelId: string): ModelProfile[] {
	const profiles: unknown = provider.modelProfiles?.[modelId];
	if (!Array.isArray(profiles)) return [];
	return profiles.filter((profile): profile is ModelProfile => validateModelProfile(profile) === null);
}

function saveModelProfile(
	provider: DiscoveredProvider,
	modelId: string,
	profile: ModelProfile,
	previousSlug?: string,
): void {
	const profiles = getModelProfiles(provider, modelId);
	const index = previousSlug === undefined ? -1 : profiles.findIndex((item) => item.slug === previousSlug);
	const next = [...profiles];
	if (index >= 0) next[index] = profile;
	else next.push(profile);
	provider.modelProfiles = { ...provider.modelProfiles, [modelId]: next };
}

function deleteModelProfile(provider: DiscoveredProvider, modelId: string, slug: string): void {
	const nextProfiles = getModelProfiles(provider, modelId).filter((profile) => profile.slug !== slug);
	const modelProfiles = { ...provider.modelProfiles };
	if (nextProfiles.length > 0) modelProfiles[modelId] = nextProfiles;
	else delete modelProfiles[modelId];
	provider.modelProfiles = Object.keys(modelProfiles).length > 0 ? modelProfiles : undefined;
}

function getModelProfileRouting(provider: DiscoveredProvider, modelId: string): ModelProfileRouting | undefined {
	return provider.modelProfileRouting?.[modelId];
}

function saveModelProfileRouting(
	provider: DiscoveredProvider,
	modelId: string,
	routing: ModelProfileRouting,
): void {
	provider.modelProfileRouting = { ...provider.modelProfileRouting, [modelId]: routing };
}

function deleteModelProfileRouting(provider: DiscoveredProvider, modelId: string): void {
	const routing = { ...provider.modelProfileRouting };
	delete routing[modelId];
	provider.modelProfileRouting = Object.keys(routing).length > 0 ? routing : undefined;
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
	if (server.includes("lm-studio") || server.includes("lm studio") || server.includes("lmstudio")) return "LM Studio";
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
	let hasVision = false;

	// 1. Standard architecture.input_modalities (vLLM, SGLang, etc.)
	if (raw.architecture && typeof raw.architecture === "object") {
		const arch = raw.architecture as Record<string, unknown>;
		const modalities = arch.input_modalities as string[] | undefined;
		if (Array.isArray(modalities) && modalities.length > 0) {
			input = [];
			for (const m of modalities) {
				const l = m.toLowerCase();
				if (l.includes("text") && !input.includes("text")) input.push("text");
				if ((l.includes("image") || l.includes("vision")) && !input.includes("image")) {
					input.push("image");
					hasVision = true;
				}
			}
		}
		// Also check for vision-specific architecture keys
		if (!hasVision && (arch.vision_config || arch.vision_model || arch.mm_proj || arch.multi_modal_projector)) {
			hasVision = true;
		}
	}

	// 2. Direct input array on the model object
	if (!input && Array.isArray(raw.input)) {
		input = raw.input as string[];
		if (input.includes("image")) hasVision = true;
	}

	// 3. llama.cpp: --mmproj flag in args or preset (multimodal projector file)
	if (!hasVision && args) {
		for (const a of args) {
			if (a.startsWith("--mmproj") || a.startsWith("--vision")) {
				hasVision = true;
				break;
			}
		}
	}
	if (!hasVision && preset) {
		if (/mmproj|vision/i.test(preset)) {
			hasVision = true;
		}
	}

	// 4. oMLX: check for vision-specific capabilities or model tags
	if (!hasVision && Array.isArray(raw.capabilities)) {
		const caps = (raw.capabilities as string[]).map((c: string) => c.toLowerCase());
		if (caps.some((c: string) => c.includes("vision") || c.includes("image") || c.includes("multimodal"))) {
			hasVision = true;
		}
	}

	// 5. Build final input array — always include "text", add "image" if vision detected
	if (hasVision) {
		input = input && input.includes("image") ? input : ["text", "image"];
	} else if (!input) {
		input = ["text"];
	} else if (!input.includes("text")) {
		input.unshift("text");
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
		throw new Error(`HTTP ${response.status}: ${redactSecret(body.slice(0, 200), apiKey)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	if (!data || typeof data !== "object" || !Array.isArray(data.data)) {
		throw new Error("Invalid /v1/models response: expected a data array.");
	}
	const models = data.data.filter(
		(model): model is Record<string, unknown> =>
			!!model && typeof model === "object" && typeof (model as Record<string, unknown>).id === "string" &&
			(model as Record<string, unknown>).id !== "",
	);
	if (models.length !== data.data.length) {
		throw new Error("Invalid /v1/models response: every model must have a non-empty string id.");
	}
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
	type RuntimeThinkingRoutes = {
		routes: ThinkingProfileRoutes;
		repetitionPenaltyKey: ReturnType<typeof repetitionPenaltyKeyForServer>;
	};
	const thinkingRoutes = new Map<string, RuntimeThinkingRoutes>();
	const fixedProfileLabels = new Map<string, string>();
	const routeKey = (providerName: string, modelId: string): string => `${providerName}/${modelId}`;

	// -----------------------------------------------------------------------
	// Provider registration with Pi's model registry
	// -----------------------------------------------------------------------

	async function registerProvider(
		provider: DiscoveredProvider,
		prefetched?: { models: Record<string, unknown>[]; serverType: string },
	): Promise<{ models: ModelConfig[]; rawModels: Record<string, unknown>[]; serverType: string; profileCount: number }> {
		const { models, serverType } = prefetched ?? (await fetchModels(provider.baseUrl, provider.apiKey, AbortSignal.timeout(2_000)));
		if (models.length === 0) throw new Error("No models found at this endpoint.");

		const routePrefix = `${provider.name}/`;
		for (const key of thinkingRoutes.keys()) {
			if (key.startsWith(routePrefix)) thinkingRoutes.delete(key);
		}
		for (const key of fixedProfileLabels.keys()) {
			if (key.startsWith(routePrefix)) fixedProfileLabels.delete(key);
		}
		const compat: Record<string, unknown> = { ...provider.compat };
		if (serverType === "llama.cpp" || serverType === "oMLX" || serverType === "Ollama") {
			if (compat.supportsDeveloperRole === undefined) compat.supportsDeveloperRole = false;
		}
		if (serverType === "oMLX") {
			// Preserve the pre-profile base-model behavior. Fixed and adaptive profile
			// aliases supply their own complete chat-template kwargs independently.
			if (compat.thinkingFormat === undefined) compat.thinkingFormat = "qwen-chat-template";
			if (compat.supportsReasoningEffort === undefined) compat.supportsReasoningEffort = true;
		}

		// NOTE: Pi's applyExtension() spreads model definitions but does NOT merge
		// provider-level compat into individual models. So we must attach compat
		// to each model directly — otherwise getCompat(model) returns no thinkingFormat.

		const configs = models.map(extractModelConfig);
		const baseModels = configs.map((c) => {
			const ov = provider.modelOverrides?.[c.id];
			// For oMLX, auto-detect reasoning capability on Qwen models
			const serverReasoning =
				serverType === "oMLX" && !c.reasoning
					? /^qwen/i.test(c.id) || /^qwen/i.test(c.name)
					: false;
			const reasoning = ov?.reasoning ?? c.reasoning ?? serverReasoning;
			return {
				id: c.id,
				name: c.name,
				reasoning,
				input: ov?.input ?? c.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: ov?.contextWindow ?? c.contextWindow ?? provider.defaultContextWindow ?? 128_000,
				maxTokens: ov?.maxTokens ?? c.maxTokens ?? provider.defaultMaxTokens ?? 16_384,
				compat: compat, // attach compat to each model (Pi's applyExtension doesn't merge provider-level compat)
			};
		});
		const expandedProfiles = expandModelProfiles(
			baseModels.map((model) => ({ ...model, input: model.input as ("text" | "image")[] })),
			provider.modelProfiles,
			{ repetitionPenaltyKey: repetitionPenaltyKeyForServer(serverType) },
		);
		const expandedRouters = expandAdaptiveProfileRouters(
			expandedProfiles.models,
			provider.modelProfiles,
			provider.modelProfileRouting,
		);
		for (const warning of [...expandedProfiles.warnings, ...expandedRouters.warnings]) {
			console.error(`[model-discovery] ${provider.name}: ${warning}`);
		}

		const repetitionPenaltyKey = repetitionPenaltyKeyForServer(serverType);
		for (const [modelId, routes] of expandedRouters.runtimeRoutes) {
			thinkingRoutes.set(routeKey(provider.name, modelId), { routes, repetitionPenaltyKey });
		}
		for (const base of baseModels) {
			for (const profile of getModelProfiles(provider, base.id)) {
				if (profile.exposeAsModel !== false) {
					fixedProfileLabels.set(routeKey(provider.name, profileModelId(base.id, profile.slug)), profile.slug);
				}
			}
		}

		// OpenAI SDK appends /chat/completions to baseUrl.
		// Ensure baseUrl ends with /v1 so the full URL is .../v1/chat/completions.
		const sdkBaseUrl = provider.baseUrl.replace(/\/v1\/?$/, "") + "/v1";
		pi.registerProvider(provider.name, {
			name: `${serverType} (${provider.name})`,
			baseUrl: sdkBaseUrl,
			apiKey: provider.apiKey || "local",
			api: "openai-completions",
			models: expandedRouters.models,
		});

		provider.serverType = serverType;
		return {
			models: configs,
			rawModels: models,
			serverType,
			profileCount: expandedProfiles.profileCount + expandedRouters.routerCount,
		};
	}

	// Register saved providers at startup (concurrent — one dead endpoint can't block the others)
	const providers = loadProviders();
	if (providers.length > 0) {
		const results = await Promise.allSettled(
			providers.map(async (provider) => {
				try {
					const registered = await registerProvider(provider);
					recordSuccessfulScan(provider, registered.rawModels, registered.serverType);
				} catch (error) {
					recordFailedScan(provider, error);
					if (!provider.cachedModels?.length) throw error;
					try {
						await registerProvider(provider, {
							models: provider.cachedModels,
							serverType: provider.serverType ?? "OpenAI-compatible",
						});
					} catch (cacheError) {
						throw new Error(
							`Live scan failed (${errorMessage(error)}); cached catalogue also failed (${errorMessage(cacheError)}).`,
						);
					}
					console.error(
						`[model-discovery] ${provider.name}: ${errorMessage(error)}; registered last known-good cached catalogue.`,
					);
				}
				return provider.name;
			}),
		);
		results.forEach((result, index) => {
			if (result.status === "rejected") {
				console.error(
					`[model-discovery] ${providers[index].name}: unavailable with no usable cache (${errorMessage(result.reason)}); other sources remain available.`,
				);
			}
		});
	}

	function activeThinkingRoute(ctx: { model?: { provider: string; id: string }; thinkingLevel?: string }) {
		if (!ctx.model || !ctx.thinkingLevel) return undefined;
		const runtime = thinkingRoutes.get(routeKey(ctx.model.provider, ctx.model.id));
		if (!runtime) return undefined;
		const profile = runtime.routes[ctx.thinkingLevel as keyof ThinkingProfileRoutes];
		return profile ? { runtime, profile } : undefined;
	}

	pi.on("before_provider_request", (event, ctx) => {
		const active = activeThinkingRoute(ctx);
		if (!active) return undefined;
		return applyThinkingProfileRoute(event.payload, active.profile, active.runtime.repetitionPenaltyKey);
	});

	const updateThinkingProfileStatus = (ctx: ExtensionContext): void => {
		const active = activeThinkingRoute(ctx);
		const fixed = ctx.model ? fixedProfileLabels.get(routeKey(ctx.model.provider, ctx.model.id)) : undefined;
		ctx.ui.setStatus(
			"model-discovery-thinking-profile",
			active ? `preset: ${active.profile.slug}` : fixed ? `fixed preset: ${fixed}` : undefined,
		);
	};
	pi.on("session_start", (_event, ctx) => updateThinkingProfileStatus(ctx));
	pi.on("model_select", (_event, ctx) => updateThinkingProfileStatus(ctx));
	pi.on("thinking_level_select", (_event, ctx) => updateThinkingProfileStatus(ctx));

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

			const selectList = new SelectList(
				items,
				Math.min(items.length, 12),
				{
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				},
				{ minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 48 },
			);
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
		onError?: (error: unknown) => void,
	): Promise<T | null> {
		return await ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, message);
			loader.onAbort = () => done(null);
			work(loader.signal)
				.then((result) => done(result))
				.catch((err) => {
					onError?.(err);
					ctx.ui.notify(errorMessage(err), "error");
					done(null);
				});
			return loader;
		});
	}

	async function askSecret(
		ctx: ExtensionCommandContext,
		title: string,
		description: string,
	): Promise<string | undefined> {
		return await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
			const input = new Input();
			input.onSubmit = (value) => done(value);
			input.onEscape = () => done(undefined);

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			container.addChild(new Text(theme.fg("muted", description), 1, 0));
			container.addChild({
				render: (width: number) => {
					const count = [...input.getValue()].length;
					const available = Math.max(1, width - 4);
					const masked = count > available ? `…${"•".repeat(Math.max(0, available - 1))}` : "•".repeat(count);
					const marker = input.focused ? CURSOR_MARKER : "";
					return [truncateToWidth(`> ${masked}${marker}\x1b[7m \x1b[27m`, width, "")];
				},
				invalidate: () => {},
			});
			container.addChild(new Text(theme.fg("dim", "enter submit • esc cancel • value is masked"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				get focused() {
					return input.focused;
				},
				set focused(value: boolean) {
					input.focused = value;
				},
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					input.handleInput(data);
					tui.requestRender();
				},
			};
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

	function optionalBooleanDescription(value: boolean | undefined): string {
		return value === undefined ? "omitted (inherits base behavior)" : value ? "true" : "false";
	}

	async function chooseOptionalBoolean(
		ctx: ExtensionCommandContext,
		title: string,
		current: boolean | undefined,
	): Promise<boolean | undefined | null> {
		const currentValue = current === undefined ? "omit" : String(current);
		const choices: SelectItem[] = [
			{ value: "omit", label: "Omit", description: "do not fix this key in the profile" },
			{ value: "true", label: "true" },
			{ value: "false", label: "false" },
		];
		const selected = await runSelect(
			ctx,
			title,
			[...choices.filter((item) => item.value === currentValue), ...choices.filter((item) => item.value !== currentValue)],
			[`current: ${optionalBooleanDescription(current)}`],
		);
		if (selected === null) return null;
		if (selected === "omit") return undefined;
		return selected === "true";
	}

	async function chooseReasoningEffort(
		ctx: ExtensionCommandContext,
		current: string | undefined,
	): Promise<(typeof REASONING_EFFORTS)[number] | undefined | null> {
		const currentValue = current ?? "omit";
		const choices: SelectItem[] = [
			{ value: "omit", label: "Omit", description: "do not fix this key in the profile" },
			...REASONING_EFFORTS.map((effort) => ({ value: effort, label: effort })),
		];
		const selected = await runSelect(
			ctx,
			"reasoning_effort",
			[...choices.filter((item) => item.value === currentValue), ...choices.filter((item) => item.value !== currentValue)],
			[`current: ${current ?? "omitted (inherits base behavior)"}`],
		);
		if (selected === null) return null;
		if (selected === "omit") return undefined;
		return selected as (typeof REASONING_EFFORTS)[number];
	}

	type ProfileSamplingField = {
		key: keyof ProfileSampling;
		label: string;
		description: string;
		example: string;
	};

	function profileSamplingFields(serverType: string): ProfileSamplingField[] {
		const repetitionPenaltyKey = repetitionPenaltyKeyForServer(serverType);
		return [
			{ key: "temperature", label: "temperature", description: "0–2; 0 is greedy", example: "0.7" },
			{ key: "topP", label: "top_p", description: "0–1; 1 disables top-p filtering", example: "0.9" },
			{ key: "topK", label: "top_k", description: "integer ≥ 0; omit to keep the backend default", example: "20" },
			{ key: "minP", label: "min_p", description: "0–1; 0 disables min-p filtering", example: "0.05" },
			{
				key: "repetitionPenalty",
				label: repetitionPenaltyKey,
				description: "> 0; 1 disables the multiplicative penalty",
				example: "1.05",
			},
			{ key: "presencePenalty", label: "presence_penalty", description: "-2–2; 0 disables it", example: "0" },
			{ key: "frequencyPenalty", label: "frequency_penalty", description: "-2–2; 0 disables it", example: "0" },
		];
	}

	async function chooseOptionalSamplingValue(
		ctx: ExtensionCommandContext,
		field: ProfileSamplingField,
		current: number | undefined,
	): Promise<number | undefined | null> {
		const action = await runSelect(
			ctx,
			field.label,
			[
				{ value: "set", label: "Set value", description: field.description },
				{ value: "omit", label: "Omit", description: "do not send this key; use the server/model default" },
			],
			[`current: ${current ?? "omitted (server/model default)"}`],
		);
		if (action === null) return null;
		if (action === "omit") return undefined;

		for (;;) {
			const raw = await ctx.ui.input(`Value for ${field.label}`, String(current ?? field.example));
			if (raw === undefined) return null;
			const trimmed = raw.trim();
			if (!trimmed) {
				ctx.ui.notify("Enter a numeric value, or choose Omit from the previous screen.", "error");
				continue;
			}
			const value = Number(trimmed);
			const error = validateProfileSampling({ [field.key]: value });
			if (!error) return value;
			ctx.ui.notify(error, "error");
		}
	}

	function profileDescription(
		profile: ModelProfile,
		serverType: string,
		routing: ModelProfileRouting | undefined,
	): string {
		const repetitionPenaltyKey = repetitionPenaltyKeyForServer(serverType);
		const routedLevels = routing
			? (Object.entries(routing.levels) as Array<[ThinkingLevel, string]>)
					.filter(([, slug]) => slug === profile.slug)
					.map(([level]) => level)
			: [];
		return [
			routedLevels.length > 0 ? `routed: ${routedLevels.join(",")}` : "preset",
			profile.exposeAsModel === false ? "fixed alias hidden" : "fixed alias visible",
			describeChatTemplateKwargs(profile.chatTemplateKwargs),
			describeProfileSampling(profile.sampling, repetitionPenaltyKey),
		]
			.filter(Boolean)
			.join(" · ");
	}

	function profileRoutingHeader(
		routing: ModelProfileRouting | undefined,
		profiles: readonly ModelProfile[],
	): string[] {
		if (!routing) return ["Adaptive Shift-Tab routing: not configured (base and fixed aliases are unchanged)"];
		const analysis = analyzeExplicitProfileRouting(routing, profiles);
		if (analysis.errors.length > 0) {
			return [
				`Adaptive Shift-Tab routing: invalid${routing.enabled ? "" : " (disabled)"}`,
				...analysis.errors.map((error) => `⚠ ${error}`),
			];
		}
		return [
			`Adaptive Shift-Tab routing: ${routing.enabled ? `enabled as @${routing.aliasSlug}` : "disabled"}`,
			`off → ${routing.levels.off} · minimal → ${routing.levels.minimal} · low → ${routing.levels.low}`,
			`medium → ${routing.levels.medium} · high → ${routing.levels.high} · xhigh → ${routing.levels.xhigh} · max → ${routing.levels.max}`,
		];
	}

	function profilesWithCandidate(
		provider: DiscoveredProvider,
		modelId: string,
		candidate: ModelProfile,
		previousSlug?: string,
	): ModelProfile[] {
		const profiles = getModelProfiles(provider, modelId);
		const index = previousSlug === undefined ? -1 : profiles.findIndex((profile) => profile.slug === previousSlug);
		if (index < 0) return [...profiles, candidate];
		return profiles.map((profile, profileIndex) => (profileIndex === index ? candidate : profile));
	}

	async function promptProfileSlug(
		ctx: ExtensionCommandContext,
		initial: string,
	): Promise<string | null> {
		for (;;) {
			const answer = await ctx.ui.input("Preset name", initial || "thinking-medium");
			if (answer === undefined) return null;
			const slug = answer.trim();
			const error = validateProfileSlug(slug);
			if (!error) return slug;
			ctx.ui.notify(error, "error");
		}
	}

	function validateProfileForProvider(
		provider: DiscoveredProvider,
		config: ModelConfig,
		allConfigs: ModelConfig[],
		profile: ModelProfile,
		previousSlug?: string,
	): string | null {
		const profileError = validateModelProfile(profile);
		if (profileError) return profileError;

		const aliasId = profileModelId(config.id, profile.slug);
		const routing = getModelProfileRouting(provider, config.id);
		if (routing?.aliasSlug === profile.slug && profile.slug !== previousSlug) {
			return `Preset name "${profile.slug}" collides with the adaptive model alias.`;
		}
		if (allConfigs.some((item) => item.id === aliasId)) {
			return `Profile id "${aliasId}" collides with a server model.`;
		}

		for (const [modelId, profiles] of Object.entries(provider.modelProfiles ?? {})) {
			if (!Array.isArray(profiles)) continue;
			for (const other of profiles) {
				if (validateModelProfile(other) !== null) continue;
				if (modelId === config.id && other.slug === previousSlug) continue;
				if (profileModelId(modelId, other.slug) === aliasId) {
					return `Profile id "${aliasId}" is already in use.`;
				}
			}
		}
		return null;
	}

	type ProfileEditorResult =
		| { action: "save"; profile: ModelProfile }
		| { action: "delete" }
		| null;

	async function showProfileEditor(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		config: ModelConfig,
		allConfigs: ModelConfig[],
		serverType: string,
		existing?: ModelProfile,
		template?: ModelProfile,
	): Promise<ProfileEditorResult> {
		const source = existing ?? template;
		const initialSlug = source?.slug ?? (await promptProfileSlug(ctx, ""));
		if (!initialSlug) return null;
		const profile: ModelProfile = {
			slug: initialSlug,
			...(source?.chatTemplateKwargs
				? { chatTemplateKwargs: { ...source.chatTemplateKwargs } }
				: {}),
			...(source?.sampling ? { sampling: { ...source.sampling } } : {}),
			...(source?.exposeAsModel !== undefined ? { exposeAsModel: source.exposeAsModel } : {}),
		};

		for (;;) {
			const kwargs = profile.chatTemplateKwargs ?? {};
			const sampling = profile.sampling ?? {};
			const samplingFields = profileSamplingFields(serverType);
			const repetitionPenaltyKey = repetitionPenaltyKeyForServer(serverType);
			const currentRouting = getModelProfileRouting(provider, config.id);
			const previewRouting = currentRouting
				? { ...currentRouting, levels: { ...currentRouting.levels } }
				: undefined;
			if (previewRouting && existing && existing.slug !== profile.slug) {
				previewRouting.levels = Object.fromEntries(
					Object.entries(previewRouting.levels).map(([level, slug]) => [
						level,
						slug === existing.slug ? profile.slug : slug,
					]),
				) as Record<ThinkingLevel, string>;
			}
			const items: SelectItem[] = [
				{ value: "rename", label: "Preset name", description: profile.slug },
				{
					value: "expose",
					label: "Show as fixed model in /model",
					description: profile.exposeAsModel === false ? "hidden (still available to adaptive routing)" : "visible",
				},
				{
					value: "enable",
					label: "enable_thinking",
					description: optionalBooleanDescription(kwargs.enable_thinking),
				},
				{
					value: "effort",
					label: "reasoning_effort",
					description: kwargs.reasoning_effort ?? "omitted (inherits base behavior)",
				},
				{
					value: "preserve",
					label: "preserve_thinking",
					description: optionalBooleanDescription(kwargs.preserve_thinking),
				},
				...samplingFields.map((field) => ({
					value: `sampling:${field.key}`,
					label: field.label,
					description: `${sampling[field.key] ?? "omitted (server/model default)"} · ${field.description}`,
				})),
				{ value: "save", label: "✓ Save preset", description: profileModelId(config.id, profile.slug) },
			];
			if (existing) items.push({ value: "delete", label: "✗ Delete preset" });
			items.push({ value: "cancel", label: "← Cancel" });

			const action = await runSelect(ctx, `Preset: ${profile.slug}`, items, [
				`model id: ${profileModelId(config.id, profile.slug)} → ${config.id}`,
				`thinking kwargs: ${JSON.stringify(kwargs)}`,
				`sampling params: ${JSON.stringify(buildProfileSamplingParams(profile.sampling, repetitionPenaltyKey))}`,
				...profileRoutingHeader(
					previewRouting,
					profilesWithCandidate(provider, config.id, profile, existing?.slug),
				),
				"This preset changes adaptive routing only when explicitly mapped to a Pi level.",
				"Omitted values use the server/model default.",
			]);
			if (!action || action === "cancel") return null;

			if (action === "rename") {
				const slug = await promptProfileSlug(ctx, profile.slug);
				if (slug) profile.slug = slug;
			} else if (action === "expose") {
				profile.exposeAsModel = profile.exposeAsModel === false;
			} else if (action === "enable") {
				const value = await chooseOptionalBoolean(ctx, "enable_thinking", kwargs.enable_thinking);
				if (value === null) continue;
				if (value === undefined) delete kwargs.enable_thinking;
				else kwargs.enable_thinking = value;
				if (Object.keys(kwargs).length > 0) profile.chatTemplateKwargs = kwargs;
				else delete profile.chatTemplateKwargs;
			} else if (action === "effort") {
				const value = await chooseReasoningEffort(ctx, kwargs.reasoning_effort);
				if (value === null) continue;
				if (value === undefined) delete kwargs.reasoning_effort;
				else kwargs.reasoning_effort = value;
				if (Object.keys(kwargs).length > 0) profile.chatTemplateKwargs = kwargs;
				else delete profile.chatTemplateKwargs;
			} else if (action === "preserve") {
				const value = await chooseOptionalBoolean(ctx, "preserve_thinking", kwargs.preserve_thinking);
				if (value === null) continue;
				if (value === undefined) delete kwargs.preserve_thinking;
				else kwargs.preserve_thinking = value;
				if (Object.keys(kwargs).length > 0) profile.chatTemplateKwargs = kwargs;
				else delete profile.chatTemplateKwargs;
			} else if (action.startsWith("sampling:")) {
				const key = action.slice("sampling:".length) as keyof ProfileSampling;
				const field = samplingFields.find((candidate) => candidate.key === key);
				if (!field) continue;
				const value = await chooseOptionalSamplingValue(ctx, field, sampling[key]);
				if (value === null) continue;
				if (value === undefined) delete sampling[key];
				else sampling[key] = value;
				if (Object.keys(sampling).length > 0) profile.sampling = sampling;
				else delete profile.sampling;
			} else if (action === "save") {
				const error = validateProfileForProvider(provider, config, allConfigs, profile, existing?.slug);
				if (error) {
					ctx.ui.notify(error, "error");
					continue;
				}
				return { action: "save", profile };
			} else if (action === "delete" && existing) {
				const routing = getModelProfileRouting(provider, config.id);
				const routed = routing && Object.values(routing.levels).includes(existing.slug);
				const confirmed = await ctx.ui.confirm(
					"Delete preset",
					`Delete "${existing.slug}"?${routed ? " The adaptive route will become invalid until those levels are remapped." : ""}`,
				);
				if (confirmed) return { action: "delete" };
			}
		}
	}

	async function persistProfileChange(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		prefetched: { models: Record<string, unknown>[]; serverType: string },
	): Promise<boolean> {
		upsertProvider(provider);
		try {
			await registerProvider(provider, prefetched);
			upsertProvider(provider);
			return true;
		} catch (err) {
			ctx.ui.notify(
				`Profile saved, but provider registration failed: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			return false;
		}
	}

	async function refreshSelectedProfile(
		ctx: ExtensionCommandContext,
		providerName: string,
		previousModelId: string,
		nextModelId: string,
	): Promise<void> {
		if (ctx.model?.provider !== providerName || ctx.model.id !== previousModelId) return;
		const refreshed = ctx.modelRegistry.find(providerName, nextModelId);
		if (refreshed) await pi.setModel(refreshed);
	}

	async function refreshAdaptiveSelection(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		modelId: string,
	): Promise<void> {
		const routing = getModelProfileRouting(provider, modelId);
		if (!routing || ctx.model?.provider !== provider.name) return;
		const adaptiveId = profileModelId(modelId, routing.aliasSlug);
		if (ctx.model.id !== adaptiveId) return;
		const valid =
			routing.enabled && analyzeExplicitProfileRouting(routing, getModelProfiles(provider, modelId)).errors.length === 0;
		const refreshed = ctx.modelRegistry.find(provider.name, valid ? adaptiveId : modelId);
		if (refreshed) await pi.setModel(refreshed);
	}

	async function choosePreset(
		ctx: ExtensionCommandContext,
		title: string,
		profiles: readonly ModelProfile[],
		serverType: string,
		current?: string,
	): Promise<string | null> {
		const items: SelectItem[] = profiles.map((profile) => ({
			value: profile.slug,
			label: profile.slug,
			description: profileDescription(profile, serverType, undefined),
		}));
		items.sort((a, b) => (a.value === current ? -1 : b.value === current ? 1 : a.label.localeCompare(b.label)));
		return runSelect(ctx, title, items, [current ? `current: ${current}` : "No preset selected"]);
	}

	function conventionalPreset(profiles: readonly ModelProfile[], kind: "off" | "low" | "medium" | "xhigh") {
		return profiles.find((profile) => {
			const kwargs = profile.chatTemplateKwargs;
			return kind === "off"
				? kwargs?.enable_thinking === false
				: kwargs?.enable_thinking !== false && kwargs?.reasoning_effort === kind;
		});
	}

	function defaultProfileRouting(profiles: readonly ModelProfile[]): ModelProfileRouting {
		const off = conventionalPreset(profiles, "off")?.slug ?? "";
		const low = conventionalPreset(profiles, "low")?.slug ?? "";
		const medium = conventionalPreset(profiles, "medium")?.slug ?? "";
		const xhigh = conventionalPreset(profiles, "xhigh")?.slug ?? "";
		return {
			enabled: true,
			aliasSlug: "adaptive",
			levels: { off, minimal: low, low, medium, high: xhigh, xhigh, max: xhigh },
		};
	}

	async function previewProfileRouting(
		ctx: ExtensionCommandContext,
		config: ModelConfig,
		routing: ModelProfileRouting,
		profiles: readonly ModelProfile[],
		serverType: string,
	): Promise<void> {
		const analysis = analyzeExplicitProfileRouting(routing, profiles);
		if (!analysis.routes) {
			ctx.ui.notify(analysis.errors.join(" "), "error");
			return;
		}
		const level = await runSelect(
			ctx,
			"Preview exact routed request",
			(Object.entries(analysis.routes) as Array<[ThinkingLevel, ModelProfile]>).map(([thinkingLevel, profile]) => ({
				value: thinkingLevel,
				label: thinkingLevel,
				description: `${profile.slug} · ${profileDescription(profile, serverType, routing)}`,
			})),
			[`adaptive model: ${profileModelId(config.id, routing.aliasSlug)} → ${config.id}`],
		);
		if (!level) return;
		const profile = analysis.routes[level as ThinkingLevel];
		const payload = applyThinkingProfileRoute(
			{ model: config.id },
			profile,
			repetitionPenaltyKeyForServer(serverType),
		);
		await runSelect(ctx, `${level} → ${profile.slug}`, [{ value: "back", label: "← Back" }], [
			...JSON.stringify(payload, null, 2).split("\n"),
		]);
	}

	type RoutingEditorResult = { action: "save"; routing: ModelProfileRouting } | { action: "remove" } | null;

	async function showProfileRoutingEditor(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		config: ModelConfig,
		allConfigs: ModelConfig[],
		profiles: readonly ModelProfile[],
		serverType: string,
	): Promise<RoutingEditorResult> {
		if (profiles.length === 0) {
			ctx.ui.notify("Create at least one preset before configuring adaptive routing.", "warning");
			return null;
		}
		const existing = getModelProfileRouting(provider, config.id);
		const routing: ModelProfileRouting = existing
			? { ...existing, levels: { ...existing.levels } }
			: defaultProfileRouting(profiles);

		for (;;) {
			const analysis = analyzeExplicitProfileRouting(routing, profiles);
			const items: SelectItem[] = [
				{
					value: "enabled",
					label: "Adaptive routing",
					description: routing.enabled ? "enabled" : "disabled (mapping retained)",
				},
				{
					value: "alias",
					label: "Adaptive model alias",
					description: profileModelId(config.id, routing.aliasSlug),
				},
				{
					value: "conventional",
					label: "Map four-preset layout",
					description: "choose off, low, medium, and xhigh once; expand to all seven Pi levels",
				},
				...THINKING_LEVELS.map((level) => ({
					value: `level:${level}`,
					label: `Pi ${level}`,
					description: `→ ${routing.levels[level] || "not selected"}`,
				})),
				{ value: "preview", label: "Preview exact requests", description: "inspect the payload preset for each Pi level" },
				{ value: "save", label: "✓ Review and save", description: analysis.errors.length ? `${analysis.errors.length} issue(s)` : "valid mapping" },
			];
			if (existing) items.push({ value: "remove", label: "✗ Remove adaptive routing", description: "fixed presets remain unchanged" });
			items.push({ value: "cancel", label: "← Cancel" });

			const action = await runSelect(ctx, "Adaptive Shift-Tab routing", items, [
				"Explicit router: only this alias changes complete presets when Shift-Tab is pressed.",
				...(analysis.errors.length ? analysis.errors.map((error) => `⚠ ${error}`) : profileRoutingHeader(routing, profiles)),
			]);
			if (!action || action === "cancel") return null;
			if (action === "enabled") {
				routing.enabled = !routing.enabled;
			} else if (action === "alias") {
				const alias = await promptProfileSlug(ctx, routing.aliasSlug);
				if (alias) routing.aliasSlug = alias;
			} else if (action === "conventional") {
				const selected: Partial<Record<"off" | "low" | "medium" | "xhigh", string>> = {};
				let cancelled = false;
				for (const kind of ["off", "low", "medium", "xhigh"] as const) {
					const slug = await choosePreset(ctx, `${kind} preset`, profiles, serverType, routing.levels[kind]);
					if (!slug) {
						cancelled = true;
						break;
					}
					selected[kind] = slug;
				}
				if (!cancelled && selected.off && selected.low && selected.medium && selected.xhigh) {
					routing.levels = {
						off: selected.off,
						minimal: selected.low,
						low: selected.low,
						medium: selected.medium,
						high: selected.xhigh,
						xhigh: selected.xhigh,
						max: selected.xhigh,
					};
				}
			} else if (action.startsWith("level:")) {
				const level = action.slice("level:".length) as ThinkingLevel;
				const slug = await choosePreset(ctx, `Preset for Pi ${level}`, profiles, serverType, routing.levels[level]);
				if (slug) routing.levels[level] = slug;
			} else if (action === "preview") {
				await previewProfileRouting(ctx, config, routing, profiles, serverType);
			} else if (action === "save") {
				if (analysis.errors.length > 0) {
					ctx.ui.notify(analysis.errors.join(" "), "error");
					continue;
				}
				const aliasId = profileModelId(config.id, routing.aliasSlug);
				if (allConfigs.some((model) => model.id === aliasId)) {
					ctx.ui.notify(`Adaptive alias "${aliasId}" collides with a server model.`, "error");
					continue;
				}
				const confirmed = await ctx.ui.confirm(
					"Save adaptive routing",
					`${routing.enabled ? "Enable" : "Save disabled"} "${aliasId}" with all seven Pi levels mapped? The base model and fixed aliases will not change.`,
				);
				if (confirmed) return { action: "save", routing };
			} else if (action === "remove") {
				const confirmed = await ctx.ui.confirm(
					"Remove adaptive routing",
					`Remove "${profileModelId(config.id, routing.aliasSlug)}"? Presets and fixed aliases remain.`,
				);
				if (confirmed) return { action: "remove" };
			}
		}
	}

	async function showProfilesScreen(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		config: ModelConfig,
		allConfigs: ModelConfig[],
		prefetched: { models: Record<string, unknown>[]; serverType: string },
	): Promise<void> {
		for (;;) {
			const profiles = getModelProfiles(provider, config.id);
			const routing = getModelProfileRouting(provider, config.id);
			const routeAnalysis = routing ? analyzeExplicitProfileRouting(routing, profiles) : undefined;
			const items: SelectItem[] = [
				{
					value: "routing",
					label: routing ? "Configure adaptive routing" : "+ Configure adaptive routing",
					description: !routing
						? "explicitly map all seven Pi levels to complete presets"
						: routeAnalysis?.errors.length
							? `invalid · ${routeAnalysis.errors.length} issue(s)`
							: routing.enabled
								? `enabled as ${profileModelId(config.id, routing.aliasSlug)}`
								: "disabled; mapping retained",
				},
			];
			if (routing && routeAnalysis?.routes) {
				items.push({
					value: "preview-routing",
					label: "Preview routed requests",
					description: "inspect exact thinking and sampling fields for every Pi level",
				});
			}
			items.push(
				{ value: "add", label: "+ Create preset", description: "create a complete thinking/sampling parameter bundle" },
				{ value: "clone", label: "+ Clone preset", description: "copy an existing preset, then edit only what differs" },
			);
			for (const profile of profiles) {
				items.push({
					value: `profile:${profile.slug}`,
					label: profile.slug,
					description: profileDescription(profile, prefetched.serverType, routing),
				});
			}
			items.push({ value: "back", label: "← Back" });

			const action = await runSelect(ctx, `Thinking & presets: ${config.id}`, items, [
				`${profiles.length} preset(s) · base model behavior is never changed by presets`,
				...profileRoutingHeader(routing, profiles),
			]);
			if (!action || action === "back") return;

			if (action === "routing") {
				const previousAlias = routing?.aliasSlug;
				const result = await showProfileRoutingEditor(
					ctx,
					provider,
					config,
					allConfigs,
					profiles,
					prefetched.serverType,
				);
				if (!result) continue;
				if (result.action === "save") saveModelProfileRouting(provider, config.id, result.routing);
				else deleteModelProfileRouting(provider, config.id);
				const registered = await persistProfileChange(ctx, provider, prefetched);
				if (registered) {
					const nextAlias = result.action === "save" && result.routing.enabled ? result.routing.aliasSlug : undefined;
					if (previousAlias) {
						await refreshSelectedProfile(
							ctx,
							provider.name,
							profileModelId(config.id, previousAlias),
							nextAlias ? profileModelId(config.id, nextAlias) : config.id,
						);
					}
					updateThinkingProfileStatus(ctx);
					ctx.ui.notify(result.action === "save" ? "Adaptive routing saved." : "Adaptive routing removed.", "info");
				}
				continue;
			}
			if (action === "preview-routing" && routing) {
				await previewProfileRouting(ctx, config, routing, profiles, prefetched.serverType);
				continue;
			}

			let existing = action.startsWith("profile:")
				? profiles.find((profile) => profile.slug === action.slice("profile:".length))
				: undefined;
			let template: ModelProfile | undefined;
			if (action === "clone") {
				const sourceSlug = await choosePreset(ctx, "Clone which preset?", profiles, prefetched.serverType);
				const source = profiles.find((profile) => profile.slug === sourceSlug);
				if (!source) continue;
				const slug = await promptProfileSlug(ctx, `${source.slug}-copy`);
				if (!slug) continue;
				template = {
					...source,
					slug,
					...(source.chatTemplateKwargs ? { chatTemplateKwargs: { ...source.chatTemplateKwargs } } : {}),
					...(source.sampling ? { sampling: { ...source.sampling } } : {}),
				};
			}
			if (action !== "add" && action !== "clone" && !existing) continue;

			const result = await showProfileEditor(
				ctx,
				provider,
				config,
				allConfigs,
				prefetched.serverType,
				existing,
				template,
			);
			if (!result) continue;
			if (result.action === "save") {
				const currentRouting = getModelProfileRouting(provider, config.id);
				const nextRouting = currentRouting
					? { ...currentRouting, levels: { ...currentRouting.levels } }
					: undefined;
				const prospectiveProfiles = profilesWithCandidate(provider, config.id, result.profile, existing?.slug);
				const wasValid = currentRouting
					? analyzeExplicitProfileRouting(currentRouting, profiles).errors.length === 0
					: false;
				if (nextRouting && existing && existing.slug !== result.profile.slug) {
					nextRouting.levels = Object.fromEntries(
						Object.entries(nextRouting.levels).map(([level, slug]) => [
							level,
							slug === existing.slug ? result.profile.slug : slug,
						]),
					) as Record<ThinkingLevel, string>;
				}
				const willBeValid = nextRouting
					? analyzeExplicitProfileRouting(nextRouting, prospectiveProfiles).errors.length === 0
					: false;
				if (nextRouting?.enabled && wasValid && !willBeValid) {
					const confirmed = await ctx.ui.confirm(
						"Routing will become invalid",
						"Save this preset anyway? The adaptive alias will not be registered until the mapping is repaired.",
					);
					if (!confirmed) continue;
				}
				saveModelProfile(provider, config.id, result.profile, existing?.slug);
				if (nextRouting) saveModelProfileRouting(provider, config.id, nextRouting);
				const registered = await persistProfileChange(ctx, provider, prefetched);
				if (registered) {
					if (existing && existing.exposeAsModel !== false) {
						await refreshSelectedProfile(
							ctx,
							provider.name,
							profileModelId(config.id, existing.slug),
							result.profile.exposeAsModel === false
								? config.id
								: profileModelId(config.id, result.profile.slug),
						);
					}
					await refreshAdaptiveSelection(ctx, provider, config.id);
					updateThinkingProfileStatus(ctx);
					ctx.ui.notify(`${existing ? "Updated" : "Created"} preset "${result.profile.slug}".`, "info");
				}
			} else if (existing) {
				deleteModelProfile(provider, config.id, existing.slug);
				const registered = await persistProfileChange(ctx, provider, prefetched);
				if (registered) {
					await refreshSelectedProfile(
						ctx,
						provider.name,
						profileModelId(config.id, existing.slug),
						config.id,
					);
					await refreshAdaptiveSelection(ctx, provider, config.id);
					updateThinkingProfileStatus(ctx);
					ctx.ui.notify(`Deleted preset "${existing.slug}".`, "info");
				}
			}
		}
	}

	// -----------------------------------------------------------------------
	// Screen: model detail / edit
	// -----------------------------------------------------------------------

	async function showModelScreen(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		config: ModelConfig,
		allConfigs: ModelConfig[],
		prefetched: { models: Record<string, unknown>[]; serverType: string },
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

			const configuredProfiles = getModelProfiles(provider, config.id);
			const configuredRouting = getModelProfileRouting(provider, config.id);
			const routingAnalysis = configuredRouting
				? analyzeExplicitProfileRouting(configuredRouting, configuredProfiles)
				: undefined;
			const routingStatus = !configuredRouting
				? "not configured"
				: routingAnalysis?.errors.length
					? `invalid (${routingAnalysis.errors.length} issue(s))`
					: configuredRouting.enabled
						? `enabled as @${configuredRouting.aliasSlug}`
						: "disabled";
			const items: SelectItem[] = [
				{ value: "ctx", label: "Set context window", description: `current: ${fmt(effCtx)}` },
				{ value: "max", label: "Set max output tokens", description: `current: ${fmt(effMax)}` },
				{
					value: "reasoning",
					label: "Toggle reasoning",
					description: `current: ${effReasoning === null ? "unknown" : effReasoning ? "on" : "off"}`,
				},
				{
					value: "input",
					label: "Toggle vision (image input)",
					description: `current: ${effInput.includes("image") ? "vision on" : "text only"}`,
				},
				{
					value: "profiles",
					label: "Thinking & presets",
					description: `${configuredProfiles.length} preset(s) · adaptive routing ${routingStatus}`,
				},
			];
			if (Object.keys(ov).length > 0) {
				items.push({ value: "clear", label: "Clear overrides", description: "revert to server-reported values" });
			}
			items.push({ value: "back", label: "← Back" });

			const action = await runSelect(ctx, `Model: ${config.id}${modelFlags(config, ov)}`, items, header);
			if (!action || action === "back") return;

			if (action === "profiles") {
				await showProfilesScreen(ctx, provider, config, allConfigs, prefetched);
				continue;
			}

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
			} else if (action === "input") {
				// Toggle vision: add/remove "image" from input modalities
				const hasVision = effInput.includes("image");
				const newInput = hasVision
					? ["text"]
					: [...new Set([...effInput, "image"])]; // ensure both text and image
				provider.modelOverrides = {
					...provider.modelOverrides,
					[config.id]: { ...ov, input: newInput },
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
				await registerProvider(provider, prefetched);
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
		let live = await runLoader(
			ctx,
			`Scanning ${provider.baseUrl}...`,
			(signal) => fetchModels(provider.baseUrl, provider.apiKey, signal),
			(error) => recordFailedScan(provider, error),
		);
		if (live && live.models.length === 0) {
			const error = new Error("Endpoint reported no models; retaining the last known-good catalogue.");
			recordFailedScan(provider, error);
			ctx.ui.notify(error.message, "warning");
			live = null;
		} else if (live) {
			recordSuccessfulScan(provider, live.models, live.serverType);
		}

		for (;;) {
			const header: string[] = [];
			const cachedModels = provider.cachedModels ?? [];
			let configs: ModelConfig[] = [];
			if (live) {
				configs = live.models.map(extractModelConfig);
				header.push(`${live.serverType} · ${provider.baseUrl} · online · ${configs.length} model(s)`);
			} else {
				configs = cachedModels.map(extractModelConfig);
				header.push(
					`${provider.serverType ?? "?"} · ${provider.baseUrl} · OFFLINE · ${configs.length} cached model(s)`,
				);
			}
			header.push(`authentication: ${provider.apiKey ? "API key configured" : "anonymous"}`);
			if (provider.lastScanned) {
				header.push(`last successful scan: ${new Date(provider.lastScanned).toLocaleString()}`);
			}
			if (!live && provider.lastScanError) {
				header.push(`latest live scan failed: ${provider.lastScanError}`);
				header.push("Last known-good models and all saved presets remain available.");
			}

			const items: SelectItem[] = configs.map((c) => ({
				value: `model:${c.id}`,
				label: `${c.id}${modelFlags(c, provider.modelOverrides?.[c.id])}`,
				description: modelDescription(c, provider),
			}));
			items.push({ value: "rescan", label: "⟳ Re-scan endpoint", description: "fetch fresh model list and re-register" });
			items.push({
				value: "rename",
				label: "✎ Rename source",
				description: `current: ${provider.name}`,
			});
			items.push({
				value: "auth",
				label: "🔑 Authentication",
				description: provider.apiKey ? "API key configured · replace or clear" : "anonymous · add an API key",
			});
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
				const catalog = live ?? {
					models: cachedModels,
					serverType: provider.serverType ?? "OpenAI-compatible",
				};
				if (config) await showModelScreen(ctx, provider, config, configs, catalog);
			} else if (action === "rescan") {
				live = await runLoader(
					ctx,
					`Scanning ${provider.baseUrl}...`,
					(signal) => fetchModels(provider.baseUrl, provider.apiKey, signal),
					(error) => recordFailedScan(provider, error),
				);
				if (live) {
					try {
						const registered = await registerProvider(provider, live);
						recordSuccessfulScan(provider, live.models, live.serverType, false);
						upsertProvider(provider);
						ctx.ui.notify(
							`Re-registered ${live.models.length} base model(s)${
								registered.profileCount ? ` + ${registered.profileCount} profile(s)` : ""
							} from ${live.serverType}.`,
							"info",
						);
					} catch (err) {
						recordFailedScan(provider, err);
						live = null;
						ctx.ui.notify(errorMessage(err), "error");
					}
				}
			} else if (action === "rename") {
				const newName = (await ctx.ui.input("New source name", provider.name))?.trim();
				if (newName && newName !== provider.name) {
					const oldName = provider.name;
					if (!renameProvider(oldName, newName)) {
						ctx.ui.notify(`Cannot rename — "${newName}" already exists or "${oldName}" not found.`, "error");
					} else {
						provider.name = newName;
						const catalog = live ??
							(provider.cachedModels?.length
								? {
									models: provider.cachedModels,
									serverType: provider.serverType ?? "OpenAI-compatible",
								}
								: undefined);
						try {
							await registerProvider(provider, catalog);
							pi.unregisterProvider(oldName);
							upsertProvider(provider);
							ctx.ui.notify(`Renamed to "${newName}"${live ? "" : " using the cached catalogue"}.`, "info");
						} catch (error) {
							renameProvider(newName, oldName);
							provider.name = oldName;
							ctx.ui.notify(`Rename rolled back: ${errorMessage(error)}`, "error");
						}
					}
				}
			} else if (action === "auth") {
				const authAction = await runSelect(
					ctx,
					"Provider authentication",
					[
						{
							value: "set",
							label: provider.apiKey ? "Replace API key" : "Set API key",
							description: "masked while typing · used for discovery and inference",
						},
						...(provider.apiKey
							? [{ value: "clear", label: "Clear API key", description: "remove the saved bearer credential" }]
							: []),
						{ value: "back", label: "← Back" },
					],
					[provider.baseUrl, `current: ${provider.apiKey ? "API key configured" : "anonymous"}`],
				);
				if (!authAction || authAction === "back") continue;

				let nextApiKey: string | undefined;
				if (authAction === "set") {
					const entered = await askSecret(ctx, "API key", "Paste or type the replacement key. It will not be displayed.");
					if (entered === undefined) continue;
					nextApiKey = entered.trim();
					if (!nextApiKey) {
						ctx.ui.notify("API key cannot be blank. Use Clear API key for anonymous access.", "warning");
						continue;
					}
				} else {
					const confirmed = await ctx.ui.confirm(
						"Clear API key",
						"Remove the saved bearer credential from this provider?",
					);
					if (!confirmed) continue;
				}

				provider.apiKey = nextApiKey;
				upsertProvider(provider);
				const checked = await runLoader(
					ctx,
					`Validating ${provider.name} authentication...`,
					(signal) => fetchModels(provider.baseUrl, provider.apiKey, signal),
					(error) => recordFailedScan(provider, error),
				);
				if (checked?.models.length) {
					try {
						await registerProvider(provider, checked);
						recordSuccessfulScan(provider, checked.models, checked.serverType, false);
						upsertProvider(provider);
						live = checked;
						ctx.ui.notify(`Authentication saved and validated for ${provider.name}.`, "info");
					} catch (error) {
						recordFailedScan(provider, error);
						live = null;
						ctx.ui.notify(`Authentication saved, but registration failed: ${errorMessage(error)}`, "warning");
					}
				} else {
					if (checked) {
						const error = new Error("Endpoint reported no models while validating authentication.");
						recordFailedScan(provider, error);
						ctx.ui.notify(error.message, "warning");
					}
					live = null;
					if (provider.cachedModels?.length) {
						try {
							await registerProvider(provider, {
								models: provider.cachedModels,
								serverType: provider.serverType ?? "OpenAI-compatible",
							});
						} catch (error) {
							ctx.ui.notify(`Authentication was saved, but cached registration failed: ${errorMessage(error)}`, "warning");
						}
					}
					ctx.ui.notify("Authentication saved but could not be validated; the last known-good catalogue was retained.", "warning");
				}
			} else if (action === "defaults") {
				const cw = await askNumber(ctx, "Default context window (blank = keep)", String(provider.defaultContextWindow ?? 128000));
				if (cw !== undefined) provider.defaultContextWindow = cw;
				const mt = await askNumber(ctx, "Default max output tokens (blank = keep)", String(provider.defaultMaxTokens ?? 16384));
				if (mt !== undefined) provider.defaultMaxTokens = mt;
				upsertProvider(provider);
				const catalog = live ??
					(provider.cachedModels?.length
						? {
							models: provider.cachedModels,
							serverType: provider.serverType ?? "OpenAI-compatible",
						}
						: undefined);
				try {
					await registerProvider(provider, catalog);
				} catch (error) {
					ctx.ui.notify(`Defaults saved; provider remains on its last registered catalogue: ${errorMessage(error)}`, "warning");
				}
			} else if (action === "remove") {
				const sure = await ctx.ui.confirm("Remove endpoint", `Remove "${provider.name}" (${provider.baseUrl})?`);
				if (sure) {
					pi.unregisterProvider(provider.name);
					deleteProvider(provider.name);
					ctx.ui.notify(`Removed "${provider.name}".`, "info");
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

		const authMode = await runSelect(
			ctx,
			"Endpoint authentication",
			[
				{ value: "none", label: "No API key", description: "connect without a configured bearer credential" },
				{
					value: "api-key",
					label: "Enter API key",
					description: "masked while typing · saved only in the private model-discovery config",
				},
				{ value: "cancel", label: "← Cancel" },
			],
			[baseUrl, "The key is sent as an Authorization: Bearer header for discovery and inference."],
		);
		if (!authMode || authMode === "cancel") return;

		let apiKey: string | undefined;
		if (authMode === "api-key") {
			const entered = await askSecret(ctx, "API key", "Paste or type the provider key. It will not be displayed.");
			if (entered === undefined) return;
			apiKey = entered.trim();
			if (!apiKey) {
				ctx.ui.notify("API key cannot be blank. Choose No API key for anonymous access.", "warning");
				return;
			}
		}

		let live: { models: Record<string, unknown>[]; serverType: string } | null = null;
		for (;;) {
			live = await runLoader(ctx, `Probing ${baseUrl}${apiKey ? " with API key" : ""}...`, (signal) =>
				fetchModels(baseUrl, apiKey, signal),
			);
			if (live) break;
			const retry = await ctx.ui.confirm(
				"Provider probe failed",
				apiKey ? "Enter a replacement API key and retry?" : "Enter an API key and retry?",
			);
			if (!retry) return;
			const entered = await askSecret(ctx, "API key", "Paste or type the provider key. It will not be displayed.");
			if (entered === undefined) return;
			apiKey = entered.trim();
			if (!apiKey) {
				ctx.ui.notify("API key cannot be blank.", "warning");
				return;
			}
		}

		if (live.models.length === 0) {
			ctx.ui.notify("Endpoint is online but reports no models.", "warning");
			return;
		}

		const name = (await ctx.ui.input("Provider name", generateProviderName(baseUrl)))?.trim() || generateProviderName(baseUrl);

		const provider: DiscoveredProvider = { name, baseUrl, apiKey };
		const configs = live.models.map(extractModelConfig);

		// Review screen: show exactly what the server reports
		const header = [
			`${live.serverType} · ${baseUrl} · online · ${configs.length} model(s)`,
			`authentication: ${apiKey ? "API key configured" : "anonymous"}`,
		];
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

				try {
					await registerProvider(provider, live);
					recordSuccessfulScan(provider, live.models, live.serverType, false);
					upsertProvider(provider);
					ctx.ui.notify(
						`Registered ${configs.length} model(s) from ${live.serverType} as "${name}". Use /model to select.`,
						"info",
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
				description: `${p.serverType ?? "?"} · ${p.baseUrl} · ${
					p.lastScanError
						? `${p.cachedModels?.length ? "cached" : "unavailable"} after failed live scan`
						: `live scan ${p.lastScanned ? new Date(p.lastScanned).toLocaleString() : "never completed"}`
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
					let live = 0;
					let cached = 0;
					let failed = 0;
					for (const provider of loadProviders()) {
						try {
							const registered = await registerProvider(provider);
							recordSuccessfulScan(provider, registered.rawModels, registered.serverType, false);
							upsertProvider(provider);
							live++;
						} catch (error) {
							recordFailedScan(provider, error, false);
							if (provider.cachedModels?.length) {
								try {
									await registerProvider(provider, {
										models: provider.cachedModels,
										serverType: provider.serverType ?? "OpenAI-compatible",
									});
									upsertProvider(provider);
									cached++;
									continue;
								} catch {
									/* report below without removing the previously registered provider */
								}
							}
							upsertProvider(provider);
							failed++;
						}
					}
					return { live, cached, failed };
				});
				if (results) {
					const level = results.failed === 0 && results.cached === 0 ? "info" : "warning";
					ctx.ui.notify(
						`Re-scan complete: ${results.live} live${results.cached ? `, ${results.cached} kept on cached catalogues` : ""}${results.failed ? `, ${results.failed} unavailable without cache` : ""}.`,
						level,
					);
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

	const discoverModelsParameters = Type.Object({
		url: Type.String({ description: "Base URL of the OpenAI-compatible endpoint (e.g., http://localhost:8080)" }),
		providerName: Type.Optional(Type.String({ description: "Name for the provider (auto-generated if omitted)" })),
		apiKey: Type.Optional(Type.String({ description: "API key if required" })),
	});
	type DiscoverModelsDetails = {
		providerName?: string;
		serverType?: string;
		modelCount?: number;
		profileCount?: number;
	};

	pi.registerTool<typeof discoverModelsParameters, DiscoverModelsDetails>({
		name: "discover_models",
		label: "Discover Models",
		description:
			"Discover and register models from an OpenAI-compatible endpoint (llama.cpp, oMLX, Ollama, vLLM). Reads actual server config. Use when the user asks to add a local model server.",
		parameters: discoverModelsParameters,
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
			try {
				const { models: configs, profileCount } = await registerProvider(provider, live);
				recordSuccessfulScan(provider, live.models, live.serverType, false);
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
							text: `Endpoint online (${live.serverType}). Registered ${configs.length} base model(s)${
								profileCount ? ` + ${profileCount} profile(s)` : ""
							} as "${providerName}":\n${lines.join("\n")}${note}\n\nModels are now selectable via /model.`,
						},
					],
					details: { providerName, serverType: live.serverType, modelCount: configs.length, profileCount },
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

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
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	analyzeExplicitProfileRouting,
	applyThinkingProfileRoute,
	buildProfileSamplingParams,
	describeChatTemplateKwargs,
	describeProfileSampling,
	expandAdaptiveProfileRouters,
	expandModelProfiles,
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
import {
	extractModelConfig,
	fetchModels,
	redactSecret,
	type ModelConfig,
} from "./providers.ts";
import {
	describeToolSchemaRepair,
	isLocalEndpointUrl,
	repairRequestToolSchemas,
	type ToolSchemaRepairReport,
} from "./schema-repair.ts";
import { createDiscoveryApplication } from "./application.ts";
import { completeDiscoverArgs, DISCOVER_USAGE, parseDiscoverArgs } from "./commands.ts";
import {
	errorMessage,
	getStorageDiagnostic,
	recordFailedScan,
	recordSuccessfulScan,
	STORAGE_PATH,
	STORAGE_PATH_DISPLAY,
	type DiscoveredProvider,
	type ModelOverride,
} from "./storage.ts";
import {
	buildDiagnosticsLines,
	buildHomeItems,
	buildHomeSummary,
	formatDiscoveryStatus,
	sourceAvailability,
} from "./ui-model.ts";
import {
	BACK_KEY,
	buildEndpointSnapshot,
	buildModelPickerSnapshot,
	buildModelSnapshot,
	buildPresetSnapshot,
	buildPresetsSnapshot,
	buildRoutingSnapshot,
	buildSourcePickerSnapshot,
	presetFieldKey,
	presetKey,
	PRESET_FIELD_ORDER,
	type PresetField,
} from "./ui/endpoint-panel.ts";
import {
	ADD_FALLBACK_CTX_KEY,
	ADD_FALLBACK_MAX_KEY,
	ADD_KEY_KEY,
	ADD_NAME_KEY,
	ADD_REGISTER_KEY,
	ADD_SCAN_KEY,
	ADD_URL_KEY,
	buildAddModelSnapshot,
	buildAddSnapshot,
} from "./ui/add-panel.ts";
import { buildReportSnapshot } from "./ui/report-panel.ts";
import { SecretField } from "./ui/secret-field.ts";
import { PAGE_NEXT_KEY, PAGE_PREV_KEY } from "./ui/panel-frame.ts";
import { SettingsPanel, type PanelActionResult, type PanelResult } from "./ui/settings-panel.ts";
import { buildHomeSnapshot, formatAge, type HomeSnapshotInput, type HomeSourceInput } from "./ui/home.ts";
import { modelDiscoveryVersion } from "./version.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function normalizeEndpointUrl(rawUrl: string): string {
	let url = rawUrl.trim();
	if (!url) throw new Error("Endpoint URL cannot be blank.");
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^https?:\/\//i.test(url)) {
		throw new Error("Endpoint URL must use HTTP or HTTPS.");
	}
	if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Endpoint URL must use HTTP or HTTPS.");
	}
	return url.replace(/\/+$/, "");
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
	const app = createDiscoveryApplication();

	type RuntimeThinkingRoutes = {
		routes: ThinkingProfileRoutes;
		repetitionPenaltyKey: ReturnType<typeof repetitionPenaltyKeyForServer>;
	};
	const thinkingRoutes = new Map<string, RuntimeThinkingRoutes>();
	const fixedProfileLabels = new Map<string, string>();
	/** Providers whose outgoing tool schemas get local grammar compatibility repair. */
	const schemaRepairProviders = new Set<string>();
	/** Repair notices already surfaced, so a per-request hook never spams the log. */
	const schemaRepairNotices = new Set<string>();
	const routeKey = (providerName: string, modelId: string): string => `${providerName}/${modelId}`;

	/**
	 * llama.cpp (and llama-swap / LM Studio / LiteLLM routes that forward to it) has
	 * strict JSON-schema→grammar compatibility limits: root-scoped $ref resolution and,
	 * in b10612, one exact nested maxLength parser failure. A single incompatible MCP
	 * tool makes *every* message 400. Local endpoints get their schemas normalised;
	 * cloud APIs stay byte-identical. See schema-repair.ts.
	 */
	function shouldRepairToolSchemas(provider: DiscoveredProvider, serverType: string): boolean {
		if (provider.repairToolSchemas === false) return false;
		if (process.env.PI_MODEL_DISCOVERY_NO_SCHEMA_REPAIR) return false;
		if (provider.repairToolSchemas === true) return true;
		const LOCAL_ENGINES = ["llama.cpp", "oMLX", "Ollama", "vLLM", "SGLang", "LM Studio", "llama-swap"];
		return LOCAL_ENGINES.some((needle) => serverType.toLowerCase().includes(needle.toLowerCase())) || isLocalEndpointUrl(provider.baseUrl);
	}

	function noteToolSchemaRepair(providerName: string, report: ToolSchemaRepairReport): void {
		if (!report.changed) return;
		const summary = describeToolSchemaRepair(report);
		const signature = `${providerName}::${summary}`;
		if (schemaRepairNotices.has(signature)) return;
		schemaRepairNotices.add(signature);
		console.error(`[model-discovery] ${providerName}: ${summary}`);
	}

	// -----------------------------------------------------------------------
	// Provider registration with Pi's model registry
	// -----------------------------------------------------------------------

	async function registerProvider(
		provider: DiscoveredProvider,
		prefetched?: { models: Record<string, unknown>[]; serverType: string },
		signal: AbortSignal = AbortSignal.timeout(2_000),
	): Promise<{ models: ModelConfig[]; rawModels: Record<string, unknown>[]; serverType: string; profileCount: number }> {
		const { models, serverType } = prefetched ?? (await fetchModels(provider.baseUrl, provider.apiKey, signal));
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
		if (shouldRepairToolSchemas(provider, serverType)) schemaRepairProviders.add(provider.name);
		else schemaRepairProviders.delete(provider.name);
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
			for (const profile of app.profiles(provider, base.id)) {
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

	async function discoverAndRegisterSource(options: {
		url: string;
		providerName?: string;
		apiKey?: string;
		signal?: AbortSignal;
	}): Promise<{
		provider: DiscoveredProvider;
		models: ModelConfig[];
		rawModels: Record<string, unknown>[];
		serverType: string;
		profileCount: number;
	}> {
		const url = normalizeEndpointUrl(options.url);
		const providerName = options.providerName?.trim() || generateProviderName(url);
		const live = await fetchModels(url, options.apiKey, options.signal);
		if (live.models.length === 0) throw new Error("Endpoint is online but reports no models.");
		const existing = app.findSource(providerName);
		const provider: DiscoveredProvider = existing
			? { ...existing, baseUrl: url, apiKey: options.apiKey ?? existing.apiKey }
			: { name: providerName, baseUrl: url, apiKey: options.apiKey };
		const registered = await registerProvider(provider, live);
		recordSuccessfulScan(provider, live.models, live.serverType, false);
		app.saveSource(provider);
		return {
			provider,
			models: registered.models,
			rawModels: live.models,
			serverType: live.serverType,
			profileCount: registered.profileCount,
		};
	}

	// Register saved providers at startup (concurrent — one dead endpoint can't block the others)
	const providers = app.listSources();
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
		let payload: unknown = event.payload;
		let touched = false;

		const active = activeThinkingRoute(ctx);
		if (active) {
			payload = applyThinkingProfileRoute(payload, active.profile, active.runtime.repetitionPenaltyKey);
			touched = true;
		}

		// Repair local tool schemas so llama.cpp-style grammar converters accept them.
		const providerName = ctx.model?.provider;
		if (providerName && schemaRepairProviders.has(providerName)) {
			const repaired = repairRequestToolSchemas(payload);
			if (repaired.report.changed) {
				noteToolSchemaRepair(providerName, repaired.report);
				payload = repaired.payload;
				touched = true;
			}
		}

		return touched ? payload : undefined;
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







	async function runLoader<T>(
		ctx: ExtensionCommandContext,
		message: string,
		work: (signal: AbortSignal) => Promise<T>,
		onError?: (error: unknown) => void,
	): Promise<T | null> {
		return await ctx.ui.custom<T | null>(
			(tui, theme, _keybindings, done) => {
				const loader = new BorderedLoader(tui, theme, message);
				let settled = false;
				loader.onAbort = () => {
					settled = true;
					done(null);
				};
				work(loader.signal)
					.then((result) => {
						if (!settled) done(result);
					})
					.catch((err) => {
						if (settled) return;
						onError?.(err);
						ctx.ui.notify(errorMessage(err), "error");
						done(null);
					});
				return loader;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 72, minWidth: 36, maxHeight: "90%", margin: 1 },
			},
		);
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



	function profilesWithCandidate(
		provider: DiscoveredProvider,
		modelId: string,
		candidate: ModelProfile,
		previousSlug?: string,
	): ModelProfile[] {
		const profiles = app.profiles(provider, modelId);
		const index = previousSlug === undefined ? -1 : profiles.findIndex((profile) => profile.slug === previousSlug);
		if (index < 0) return [...profiles, candidate];
		return profiles.map((profile, profileIndex) => (profileIndex === index ? candidate : profile));
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
		const routing = app.profileRouting(provider, config.id);
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



	async function persistProfileChange(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		prefetched: { models: Record<string, unknown>[]; serverType: string },
	): Promise<boolean> {
		app.saveSource(provider);
		try {
			await registerProvider(provider, prefetched);
			app.saveSource(provider);
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
		const routing = app.profileRouting(provider, modelId);
		if (!routing || ctx.model?.provider !== provider.name) return;
		const adaptiveId = profileModelId(modelId, routing.aliasSlug);
		if (ctx.model.id !== adaptiveId) return;
		const valid =
			routing.enabled && analyzeExplicitProfileRouting(routing, app.profiles(provider, modelId)).errors.length === 0;
		const refreshed = ctx.modelRegistry.find(provider.name, valid ? adaptiveId : modelId);
		if (refreshed) await pi.setModel(refreshed);
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



	type RoutingEditorResult = { action: "save"; routing: ModelProfileRouting } | { action: "remove" } | null;





	// -----------------------------------------------------------------------
	// Screen: model detail / edit
	// -----------------------------------------------------------------------



	// -----------------------------------------------------------------------
	// Screen: endpoint detail
	// -----------------------------------------------------------------------



	// -----------------------------------------------------------------------
	// Screen: add endpoint
	// -----------------------------------------------------------------------



	// -----------------------------------------------------------------------
	// Screen: main menu
	// -----------------------------------------------------------------------

	/** HOME snapshot input assembled from already-loaded state (no network, no writes). */
	function buildHomeInput(): HomeSnapshotInput {
		// Newest-first (home.ts contract): last successful scan wins, ties by name.
		const providers = [...app.listSources()].sort(
			(a, b) => (b.lastScanned ?? 0) - (a.lastScanned ?? 0) || a.name.localeCompare(b.name),
		);
		const sources: HomeSourceInput[] = providers.map((provider) => ({
			name: provider.name,
			baseUrl: provider.baseUrl,
			serverType: provider.serverType ?? "unknown server",
			modelCount: provider.cachedModels?.length ?? 0,
			availability: sourceAvailability(provider),
		}));
		const lastScan = providers.reduce((latest, p) => Math.max(latest, p.lastScanned ?? 0), 0);
		const presetCount = providers.reduce(
			(total, p) => total + Object.values(p.modelProfiles ?? {}).reduce((n, list) => n + list.length, 0),
			0,
		);
		return {
			version: modelDiscoveryVersion(),
			sources,
			storageLine: STORAGE_PATH_DISPLAY,
			scanLine: `last scan ${formatAge(lastScan || undefined)}`,
			adaptiveLine: presetCount ? `${presetCount} preset(s) configured` : undefined,
			diagnostic: getStorageDiagnostic()?.message,
		};
	}

	/** Re-scan every source with cache fallback (shared by the home panel and the legacy tree). */
	async function runRescanAll(ctx: ExtensionCommandContext): Promise<void> {
  const results = await runLoader(ctx, "Re-scanning all sources...", async (signal) => {
  					let live = 0;
  					let cached = 0;
  					let failed = 0;
  					for (const provider of app.listSources()) {
  						if (signal.aborted) break;
  						try {
  							const registered = await registerProvider(provider, undefined, signal);
  							recordSuccessfulScan(provider, registered.rawModels, registered.serverType, false);
  							app.saveSource(provider);
  							live++;
  						} catch (error) {
  							if (signal.aborted) break;
  							recordFailedScan(provider, error, false);
  							if (provider.cachedModels?.length) {
  								try {
  									await registerProvider(provider, {
  										models: provider.cachedModels,
  										serverType: provider.serverType ?? "OpenAI-compatible",
  									});
  									app.saveSource(provider);
  									cached++;
  									continue;
  								} catch {
  									/* report below without removing the previously registered provider */
  								}
  							}
  							app.saveSource(provider);
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
  	}

	/**
	 * Pre-alignment browse tree (TRANSITIONAL, slice 1a): deeper home actions
	 * close the panel, run this old flow, and the home loop reopens the panel
	 * afterwards — never a nested overlay (UX-STANDARD: one surface at a time).
	 * Replaced by panel-native screens in slices 1b-3.
	 */


	/**
	 * Home dashboard (slice 1a, PLAN §5): the vendored canonical SettingsPanel
	 * over a fixed-height PanelSnapshot (ui/home.ts, HOME_PANEL_ROWS at every
	 * width). Keys route close -> run -> reopen with the last key selected;
	 * esc/q close. TRANSITIONAL keys run the old wizard flow, then reopen.
	 */


	// ---------------------------------------------------------------------------
	// Panel hosts (slice 1b, D1): vendored SettingsPanel screens that replace the
	// wizard flows. One surface at a time: activate({kind:"close"}) -> run ->
	// reopen; arms live in host state; apply() validates and writes through the
	// SAME app methods the wizard used. Dropped vs wizard: per-level routing
	// request preview (diagnostic; the payloads remain inspectable via /discover).
	// ---------------------------------------------------------------------------

	function positiveInt(raw: string): number | null {
		const normalized = raw.trim().replace(/[,._\s]/g, "");
		if (!/^\d+$/.test(normalized)) return null;
		const n = Number(normalized);
		return n > 0 ? n : null;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type PanelDeps = { theme: any; keybindings: any; requestRender: () => void; done: (result: PanelResult) => void };

	async function runPanel(
		ctx: ExtensionCommandContext,
		build: (deps: PanelDeps) => SettingsPanel,
	): Promise<PanelResult | undefined> {
		return await ctx.ui.custom<PanelResult | undefined>((tui, theme, keybindings, done) =>
			build({ theme, keybindings, requestRender: () => tui.requestRender(), done }),
		);
	}

	function askSecretPanel(ctx: ExtensionCommandContext, prompt: string): Promise<string | undefined> {
		return ctx.ui.custom<string | undefined>(
			(tui, theme, keybindings, done) =>
				new SecretField({
					theme,
					keybindings,
					prompt,
					requestRender: () => tui.requestRender(),
					done,
				}),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 72, minWidth: 36, maxHeight: "90%", margin: 1 },
			},
		);
	}

	function cachedCatalog(provider: DiscoveredProvider): { models: Record<string, unknown>[]; serverType: string } | undefined {
		return provider.cachedModels?.length
			? { models: provider.cachedModels, serverType: provider.serverType ?? "OpenAI-compatible" }
			: undefined;
	}

	function endpointPanelInput(
		provider: DiscoveredProvider,
		live: { models: Record<string, unknown>[]; serverType: string } | null,
		page: number,
		armed: readonly string[],
	) {
		const configs = (live?.models ?? provider.cachedModels ?? []).map(extractModelConfig);
		return {
			version: modelDiscoveryVersion(),
			source: {
				name: provider.name,
				baseUrl: provider.baseUrl,
				serverType: provider.serverType ?? live?.serverType ?? "?",
				online: live !== null,
				modelCount: live?.models.length ?? provider.cachedModels?.length ?? 0,
				cachedCount: provider.cachedModels?.length ?? 0,
				hasApiKey: Boolean(provider.apiKey),
				defaultContextWindow: provider.defaultContextWindow ?? null,
				defaultMaxTokens: provider.defaultMaxTokens ?? null,
				lastScanned: provider.lastScanned,
				lastScanError: provider.lastScanError ? redactSecret(provider.lastScanError, provider.apiKey) : undefined,
			},
			models: configs.map((c): { id: string; flags: string; summary: string; presetCount: number; routingSummary: string } => ({
				id: c.id,
				flags: modelFlags(c, provider.modelOverrides?.[c.id]),
				summary: modelDescription(c, provider),
				presetCount: app.profiles(provider, c.id).length,
				routingSummary: routingSummaryOf(provider, c.id),
			})),
			page,
			armed,
		};
	}

	function routingSummaryOf(provider: DiscoveredProvider, modelId: string): string {
		const routing = app.profileRouting(provider, modelId);
		if (!routing) return "not configured";
		const analysis = analyzeExplicitProfileRouting(routing, app.profiles(provider, modelId));
		if (analysis.errors.length) return `invalid (${analysis.errors.length} issue(s))`;
		return routing.enabled ? `enabled as @${routing.aliasSlug}` : "disabled";
	}

	/** Host for `ui/endpoint-panel.ts`: scan header, model window, source mutations. */
	async function endpointPanel(ctx: ExtensionCommandContext, provider: DiscoveredProvider): Promise<void> {
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

		let page = 0;
		const armed = new Set<string>();
		let initialKey: string | undefined;

		for (;;) {
			const input = endpointPanelInput(provider, live, page, [...armed]);
			const built = buildEndpointSnapshot(input);
			const rebuild = () => buildEndpointSnapshot(endpointPanelInput(provider, live, page, [...armed]));
			const result = await runPanel(ctx, (deps) =>
				new SettingsPanel({
					...deps,
					initialKey,
					snapshot: () => rebuild().snapshot,
					apply: (key, raw) => {
						const m = key.match(/^cfg:source:(.+?):(name|defaultContextWindow|defaultMaxTokens)$/);
						if (!m || m[1] !== provider.name) return `Unknown setting '${key}'.`;
						if (m[2] === "name") {
							const newName = raw.trim();
							if (!newName) return "Source name cannot be blank.";
							if (app.listSources().some((c) => c.name === newName && c.name !== provider.name)) {
								return `Source "${newName}" already exists.`;
							}
							if (newName === provider.name) return null;
							const renamed = app.renameSource(provider, newName);
							if (!renamed.ok) return `Cannot rename — "${newName}" already exists.`;
							try {
								void registerProvider(provider, live ?? cachedCatalog(provider));
								pi.unregisterProvider(renamed.oldName);
								app.saveSource(provider);
								ctx.ui.notify(`Renamed to "${newName}"${live ? "" : " using the cached catalogue"}.`, "info");
							} catch (error) {
								app.renameSource(provider, renamed.oldName);
								return `Rename rolled back: ${errorMessage(error)}`;
							}
							return null;
						}
						const n = positiveInt(raw);
						if (n === null) return "Enter a positive whole number greater than zero.";
						if (m[2] === "defaultContextWindow") provider.defaultContextWindow = n;
						else provider.defaultMaxTokens = n;
						app.saveSource(provider);
						void registerProviderSafe(ctx, provider, live ?? cachedCatalog(provider), "Defaults saved");
						return null;
					},
					activate: (key): PanelActionResult => {
						if (key === `cfg:source:${provider.name}:apiKey`) return { kind: "close", action: "apikey" };
						if (key === `cfg:source:${provider.name}:apiKey:clear`) {
							if (!provider.apiKey) return { kind: "none" };
							if (!armed.has(key)) {
								armed.add(key);
								return { kind: "updated", message: `Press enter again to clear the key on "${provider.name}".` };
							}
							armed.delete(key);
							app.setCredential(provider, undefined);
							void registerProviderSafe(ctx, provider, live ?? cachedCatalog(provider), "API key cleared");
							return { kind: "updated", message: "API key cleared; now anonymous." };
						}
						if (key === `source:${provider.name}:remove`) {
							if (!armed.has(key)) {
								armed.add(key);
								return {
									kind: "updated",
									message: `Press enter again to remove "${provider.name}" — config, cache, presets, and routing are deleted.`,
								};
							}
							pi.unregisterProvider(provider.name);
							app.removeSource(provider.name);
							ctx.ui.notify(`Removed "${provider.name}".`, "info");
							return { kind: "close", action: "home" };
						}
						if (key === `source:${provider.name}:rescan`) return { kind: "close", action: "rescan" };
						if (key === BACK_KEY) return { kind: "close", action: "home" };
						if (key === PAGE_PREV_KEY) {
							page = Math.max(0, page - 1);
							return { kind: "updated" };
						}
						if (key === PAGE_NEXT_KEY) {
							page = Math.min(Math.max(0, built.pages - 1), page + 1);
							return { kind: "updated" };
						}
						if (key.startsWith("model:")) return { kind: "close", action: key };
						return { kind: "none" };
					},
				}),
			);
			void built;
			const action = result?.action;
			initialKey = undefined;
			if (!action || action === "home") return;
			if (action === "rescan") {
				const next = await runLoader(
					ctx,
					`Scanning ${provider.baseUrl}...`,
					(signal) => fetchModels(provider.baseUrl, provider.apiKey, signal),
					(error) => recordFailedScan(provider, error),
				);
				if (next && next.models.length === 0) {
					const error = new Error("Endpoint reported no models; retaining the last known-good catalogue.");
					recordFailedScan(provider, error);
					ctx.ui.notify(error.message, "warning");
					live = null;
				} else if (next) {
					recordSuccessfulScan(provider, next.models, next.serverType);
					live = next;
					ctx.ui.notify(`Re-scan complete: ${next.serverType} · ${next.models.length} model(s).`, "info");
				} else {
					live = null;
				}
				continue;
			}
			if (action === "apikey") {
				const entered = await askSecretPanel(ctx, `API key for ${provider.name} — never displayed`);
				if (entered === undefined) continue;
				const nextApiKey = entered.trim();
				if (!nextApiKey) {
					ctx.ui.notify("API key cannot be blank. Use Clear API key for anonymous access.", "warning");
					continue;
				}
				app.setCredential(provider, nextApiKey);
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
						app.saveSource(provider);
						live = checked;
						ctx.ui.notify(`Authentication saved and validated for ${provider.name}.`, "info");
					} catch (error) {
						recordFailedScan(provider, error);
						live = null;
						ctx.ui.notify(`Authentication saved, but registration failed: ${errorMessage(error)}`, "warning");
					}
				} else {
					live = null;
					if (provider.cachedModels?.length) {
						try {
							await registerProvider(provider, cachedCatalog(provider));
						} catch (error) {
							ctx.ui.notify(`Authentication was saved, but cached registration failed: ${errorMessage(error)}`, "warning");
						}
					}
					ctx.ui.notify("Authentication saved but could not be validated; the last known-good catalogue was retained.", "warning");
				}
				continue;
			}
			if (action.startsWith("model:")) {
				const id = action.slice("model:".length);
				const configs = (live?.models ?? provider.cachedModels ?? []).map(extractModelConfig);
				const config = configs.find((c) => c.id === id);
				if (config) {
					await modelPanel(ctx, provider, config, configs, live ?? cachedCatalog(provider) ?? { models: [], serverType: provider.serverType ?? "OpenAI-compatible" });
				}
				continue;
			}
			return;
		}
	}

	async function registerProviderSafe(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		catalog: { models: Record<string, unknown>[]; serverType: string } | undefined,
		feedback: string,
	): Promise<void> {
		try {
			await registerProvider(provider, catalog);
			ctx.ui.notify(`${feedback}.`, "info");
		} catch (error) {
			ctx.ui.notify(`${feedback}; provider remains on its last registered catalogue: ${errorMessage(error)}`, "warning");
		}
	}

	/** Host for `ui/endpoint-panel.ts` model screen: live per-field overrides. */
	async function modelPanel(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		config: ModelConfig,
		allConfigs: ModelConfig[],
		prefetched: { models: Record<string, unknown>[]; serverType: string },
	): Promise<void> {
		const armed = new Set<string>();
		for (;;) {
			const built = buildModelPanel();
			const result = await runPanel(ctx, (deps) =>
				new SettingsPanel({
					...deps,
					snapshot: () => buildModelPanel().snapshot,
					apply: (key, raw) => {
						const ov = provider.modelOverrides?.[config.id] ?? {};
						const write = (patch: ModelOverride, feedback: string) => {
							provider.modelOverrides = { ...provider.modelOverrides, [config.id]: { ...ov, ...patch } };
							app.saveSource(provider);
							void persistModelOverrideRegister(ctx, provider, prefetched, feedback);
						};
						if (key === `model:${config.id}:contextWindow` || key === `model:${config.id}:maxTokens`) {
							if (!raw.trim()) {
								const next = { ...ov };
								delete next[key.endsWith("maxTokens") ? "maxTokens" : "contextWindow"];
								provider.modelOverrides = { ...provider.modelOverrides, [config.id]: next };
								if (Object.keys(next).length === 0) delete provider.modelOverrides;
								app.saveSource(provider);
								void persistModelOverrideRegister(ctx, provider, prefetched, "Override removed");
								return null;
							}
							const n = positiveInt(raw);
							if (n === null) return "Enter a positive whole number greater than zero.";
							write(key.endsWith("maxTokens") ? { maxTokens: n } : { contextWindow: n }, `${key.endsWith("maxTokens") ? "Max output tokens" : "Context window"} saved as ${fmt(n)}`);
							return null;
						}
						if (key === `model:${config.id}:reasoning`) {
							const on = raw !== "true";
							write({ reasoning: on }, `Reasoning ${on ? "enabled" : "disabled"}`);
							return null;
						}
						if (key === `model:${config.id}:vision`) {
							const effInput = ov.input ?? config.input ?? ["text"];
							const next = effInput.includes("image") ? ["text"] : [...new Set([...effInput, "image"])];
							write({ input: next }, `Vision input ${effInput.includes("image") ? "disabled" : "enabled"}`);
							return null;
						}
						return `Unknown setting '${key}'.`;
					},
					activate: (key): PanelActionResult => {
						if (key === `model:${config.id}:clear`) {
							if (!armed.has(key)) {
								armed.add(key);
								return { kind: "updated", message: `Press enter again to clear overrides on "${config.id}".` };
							}
							armed.delete(key);
							if (provider.modelOverrides) {
								delete provider.modelOverrides[config.id];
								if (Object.keys(provider.modelOverrides).length === 0) provider.modelOverrides = undefined;
							}
							void persistModelOverrideRegister(ctx, provider, prefetched, "Model overrides cleared");
							return { kind: "updated", message: "Overrides cleared — server values are effective again." };
						}
						if (key === `model:${config.id}:presets`) return { kind: "close", action: "presets" };
						if (key === `routing:${config.id}`) return { kind: "close", action: "routing" };
						if (key === BACK_KEY) return { kind: "close", action: "back" };
						return { kind: "none" };
					},
				}),
			);
			const action = result?.action;
			if (!action || action === "back") return;
			if (action === "presets") {
				await presetsPanel(ctx, provider, config, allConfigs, prefetched);
				continue;
			}
			if (action === "routing") {
				await routingPanel(ctx, provider, config, allConfigs, prefetched);
				continue;
			}
			return;
		}

		function buildModelPanel() {
			const ov = provider.modelOverrides?.[config.id] ?? {};
			return buildModelSnapshot({
				version: modelDiscoveryVersion(),
				sourceName: provider.name,
				model: {
					id: config.id,
					flags: modelFlags(config, ov),
					serverContextWindow: config.contextWindow ?? null,
					serverMaxTokens: config.maxTokens ?? null,
					serverReasoning: config.reasoning ?? null,
					serverInput: config.input ?? [],
					effectiveContextWindow: ov.contextWindow ?? config.contextWindow ?? provider.defaultContextWindow ?? null,
					effectiveMaxTokens: ov.maxTokens ?? config.maxTokens ?? provider.defaultMaxTokens ?? null,
					effectiveReasoning: ov.reasoning ?? config.reasoning ?? null,
					effectiveInput: ov.input ?? config.input ?? ["text"],
					reportSource: config.source,
					presetCount: app.profiles(provider, config.id).length,
					routingSummary: routingSummaryOf(provider, config.id),
					overridden: Object.keys(ov).length > 0,
				},
				armed: [...armed],
			});
		}
	}

	async function persistModelOverrideRegister(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		prefetched: { models: Record<string, unknown>[]; serverType: string },
		feedback: string,
	): Promise<void> {
		try {
			await registerProvider(provider, prefetched);
			ctx.ui.notify(`${feedback}.`, "info");
		} catch (error) {
			ctx.ui.notify(`${feedback}. Provider registration remains on its previous state: ${errorMessage(error)}`, "warning");
		}
	}

	// ---------------------------------------------------------------------------
	// presets + routing hosts
	// ---------------------------------------------------------------------------

	function profileToFlat(profile: ModelProfile): Record<PresetField, string> {
		const kwargs = profile.chatTemplateKwargs ?? {};
		const sampling = profile.sampling ?? {};
		return {
			enable_thinking: kwargs.enable_thinking === undefined ? "" : String(kwargs.enable_thinking),
			reasoning_effort: kwargs.reasoning_effort ?? "",
			preserve_thinking: kwargs.preserve_thinking === undefined ? "" : String(kwargs.preserve_thinking),
			temperature: sampling.temperature === undefined ? "" : String(sampling.temperature),
			"top_p": sampling.topP === undefined ? "" : String(sampling.topP),
			top_k: sampling.topK === undefined ? "" : String(sampling.topK),
			min_p: sampling.minP === undefined ? "" : String(sampling.minP),
			repetition_penalty: sampling.repetitionPenalty === undefined ? "" : String(sampling.repetitionPenalty),
			presence_penalty: sampling.presencePenalty === undefined ? "" : String(sampling.presencePenalty),
			frequency_penalty: sampling.frequencyPenalty === undefined ? "" : String(sampling.frequencyPenalty),
		};
	}

	function flatToProfile(handle: string, fields: Record<PresetField, string>, exposeAsModel: boolean): ModelProfile {
		const kwargs: Record<string, unknown> = {};
		if (fields.enable_thinking !== "") kwargs.enable_thinking = fields.enable_thinking === "true";
		if (fields.reasoning_effort !== "") kwargs.reasoning_effort = fields.reasoning_effort;
		if (fields.preserve_thinking !== "") kwargs.preserve_thinking = fields.preserve_thinking === "true";
		const sampling: ProfileSampling = {};
		const numField = (key: keyof ProfileSampling, raw: string) => {
			if (raw === "") return;
			const n = Number(raw);
			if (Number.isFinite(n)) sampling[key] = n;
		};
		numField("temperature", fields.temperature);
		numField("topP", fields.top_p);
		numField("topK", fields.top_k);
		numField("minP", fields.min_p);
		numField("repetitionPenalty", fields.repetition_penalty);
		numField("presencePenalty", fields.presence_penalty);
		numField("frequencyPenalty", fields.frequency_penalty);
		return {
			slug: handle,
			...(Object.keys(kwargs).length ? { chatTemplateKwargs: kwargs as ModelProfile["chatTemplateKwargs"] } : {}),
			...(Object.keys(sampling).length ? { sampling } : {}),
			...(exposeAsModel ? { exposeAsModel: true } : {}),
		};
	}

	function draftIssues(draft: PresetDraft): string[] {
		const profile = flatToProfile(draft.handle, draft.fields, draft.exposeAsModel);
		const error = validateModelProfile(profile);
		return error ? [error] : [];
	}

	interface PresetDraft {
		handle: string;
		fields: Record<PresetField, string>;
		exposeAsModel: boolean;
		isNew: boolean;
		previousSlug?: string;
	}

	async function presetsPanel(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		config: ModelConfig,
		allConfigs: ModelConfig[],
		prefetched: { models: Record<string, unknown>[]; serverType: string },
	): Promise<void> {
		let page = 0;
		for (;;) {
			const presets = app.profiles(provider, config.id);
			const built = buildPresetsPanel(presets);
			const result = await runPanel(ctx, (deps) =>
				new SettingsPanel({
					...deps,
					snapshot: () => buildPresetsPanel(app.profiles(provider, config.id)).snapshot,
					apply: () => "Edit a preset to change its fields.",
					activate: (key): PanelActionResult => {
						if (key === `preset:${config.id}:add`) return { kind: "close", action: "add" };
						if (key === `routing:${config.id}`) return { kind: "close", action: "routing" };
						if (key === PAGE_PREV_KEY) {
							page = Math.max(0, page - 1);
							return { kind: "updated" };
						}
						if (key === PAGE_NEXT_KEY) {
							page = Math.min(Math.max(0, built.pages - 1), page + 1);
							return { kind: "updated" };
						}
						if (key === BACK_KEY) return { kind: "close", action: "back" };
						const m = key.match(/^preset:(.+?):(.+)$/);
						if (m && m[1] === config.id && m[2] !== "add") return { kind: "close", action: `edit:${m[2]}` };
						return { kind: "none" };
					},
				}),
			);
			const action = result?.action;
			if (!action || action === "back") return;
			if (action === "add") {
				await presetEditor(ctx, provider, config, allConfigs, prefetched, {
					handle: "thinking-medium",
					fields: { ...emptyPresetFields() },
					exposeAsModel: true,
					isNew: true,
				});
				continue;
			}
			if (action.startsWith("edit:")) {
				const slug = action.slice("edit:".length);
				const existing = app.profiles(provider, config.id).find((p) => p.slug === slug);
				if (existing) {
					await presetEditor(ctx, provider, config, allConfigs, prefetched, {
						handle: existing.slug,
						fields: profileToFlat(existing),
						exposeAsModel: existing.exposeAsModel !== false,
						isNew: false,
						previousSlug: existing.slug,
					});
				}
				continue;
			}
			return;
		}

		function buildPresetsPanel(presets: readonly ModelProfile[]) {
			return buildPresetsSnapshot({
				version: modelDiscoveryVersion(),
				sourceName: provider.name,
				modelId: config.id,
				presets: presets.map((p) => ({ slug: p.slug, summary: profileDescription(p, prefetched.serverType, app.profileRouting(provider, config.id) ?? undefined) })),
				routingSummary: routingSummaryOf(provider, config.id),
				page,
			});
		}
	}

	function emptyPresetFields(): Record<PresetField, string> {
		return Object.fromEntries(PRESET_FIELD_ORDER.map((f) => [f, ""])) as Record<PresetField, string>;
	}

	async function presetEditor(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		config: ModelConfig,
		allConfigs: ModelConfig[],
		prefetched: { models: Record<string, unknown>[]; serverType: string },
		draft: PresetDraft,
	): Promise<void> {
		const armed = new Set<string>();
		let page = 0;
		for (;;) {
			const built = buildEditor();
			const result = await runPanel(ctx, (deps) =>
				new SettingsPanel({
					...deps,
					snapshot: () => buildEditor().snapshot,
					apply: (key, raw) => {
						const handle = draft.handle;
						if (key === presetFieldKey(config.id, handle, "slug")) {
							const slug = raw.trim();
							const error = validateProfileSlug(slug);
							if (error) return error;
							const collision = app.profiles(provider, config.id).some((p) => p.slug === slug && p.slug !== draft.previousSlug);
							if (collision) return `Preset name "${slug}" is already in use.`;
							draft.handle = slug;
							return null;
						}
						const fm = key.match(/^cfg:preset:(.+?):(.+?):(.+)$/);
						if (fm && fm[1] === config.id && fm[2] === handle && (PRESET_FIELD_ORDER as readonly string[]).includes(fm[3])) {
							const field = fm[3] as PresetField;
							const value = raw.trim();
							if (field === "enable_thinking" || field === "preserve_thinking") {
								if (!["", "true", "false"].includes(value)) return "Choose omitted, true, or false.";
							}
							if (field === "reasoning_effort" && !["", "low", "medium", "xhigh"].includes(value)) {
								return "Choose omitted, low, medium, or xhigh.";
							}
							if (value !== "" && !Number.isFinite(Number(value)) && !["enable_thinking", "reasoning_effort", "preserve_thinking"].includes(field)) {
								return "Enter a number, or leave blank for the server/model default.";
							}
							draft.fields[field] = value;
							return null;
						}
						return `Unknown setting '${key}'.`;
					},
					activate: (key): PanelActionResult => {
						const base = presetKey(config.id, draft.handle);
						if (key === `${base}:expose`) {
							draft.exposeAsModel = !draft.exposeAsModel;
							return { kind: "updated", message: draft.exposeAsModel ? "Visible as a fixed model in /model." : "Hidden from /model (routing only)." };
						}
						if (key === `${base}:save`) {
							const issues = draftIssues(draft);
							if (issues.length) return { kind: "error", message: issues[0] ?? "Invalid draft." };
							const profile = flatToProfile(draft.handle, draft.fields, draft.exposeAsModel);
							const validationError = validateProfileForProvider(provider, config, allConfigs, profile, draft.previousSlug);
							if (validationError) return { kind: "error", message: validationError };
							// Routing invalidation guard (wizard parity): first press arms.
							const currentRouting = app.profileRouting(provider, config.id);
							const profilesBefore = app.profiles(provider, config.id);
							const prospective = profilesWithCandidate(provider, config.id, profile, draft.previousSlug);
							const wasValid = currentRouting ? analyzeExplicitProfileRouting(currentRouting, profilesBefore).errors.length === 0 : false;
							let nextRouting = currentRouting ? { ...currentRouting, levels: { ...currentRouting.levels } } : undefined;
							if (nextRouting && draft.previousSlug && draft.previousSlug !== draft.handle) {
								nextRouting.levels = Object.fromEntries(
									Object.entries(nextRouting.levels).map(([level, slug]) => [level, slug === draft.previousSlug ? draft.handle : slug]),
								) as typeof nextRouting.levels;
							}
							const willBeValid = nextRouting ? analyzeExplicitProfileRouting(nextRouting, prospective).errors.length === 0 : false;
							if (nextRouting?.enabled && wasValid && !willBeValid && !armed.has("routing-invalid")) {
								armed.add("routing-invalid");
								return { kind: "updated", message: "Saving makes the adaptive alias invalid until remapped — press save again to confirm." };
							}
							return { kind: "close", action: "save" };
						}
						if (key === `${base}:clone`) {
							const cloneHandle = `${draft.handle}-copy`;
							draft.handle = cloneHandle;
							draft.previousSlug = undefined;
							draft.isNew = true;
							return { kind: "updated", message: `Editing clone "${cloneHandle}" — save writes it as a new preset.` };
						}
						if (key === `${base}:remove`) {
							if (draft.isNew) return { kind: "close", action: "back" };
							if (!armed.has(key)) {
								armed.add(key);
								return { kind: "updated", message: `Press enter again to remove "${draft.handle}" from "${config.id}".` };
							}
							return { kind: "close", action: "remove" };
						}
						if (key === PAGE_PREV_KEY) {
							page = Math.max(0, page - 1);
							return { kind: "updated" };
						}
						if (key === PAGE_NEXT_KEY) {
							page = Math.min(Math.max(0, built.pages - 1), page + 1);
							return { kind: "updated" };
						}
						if (key === BACK_KEY) return { kind: "close", action: "back" };
						return { kind: "none" };
					},
				}),
			);
			const action = result?.action;
			if (!action || action === "back") return;
			if (action === "save") {
				const profile = flatToProfile(draft.handle, draft.fields, draft.exposeAsModel);
				const currentRouting = app.profileRouting(provider, config.id);
				const profilesBefore = app.profiles(provider, config.id);
				const prospective = profilesWithCandidate(provider, config.id, profile, draft.previousSlug);
				const wasValid = currentRouting ? analyzeExplicitProfileRouting(currentRouting, profilesBefore).errors.length === 0 : false;
				let nextRouting = currentRouting ? { ...currentRouting, levels: { ...currentRouting.levels } } : undefined;
				if (nextRouting && draft.previousSlug && draft.previousSlug !== draft.handle) {
					nextRouting.levels = Object.fromEntries(
						Object.entries(nextRouting.levels).map(([level, slug]) => [level, slug === draft.previousSlug ? draft.handle : slug]),
					) as typeof nextRouting.levels;
				}
				const willBeValid = nextRouting ? analyzeExplicitProfileRouting(nextRouting, prospective).errors.length === 0 : false;
				if (nextRouting?.enabled && wasValid && !willBeValid) {
					// armed earlier in activate; proceeding means confirmed
				}
				app.saveProfile(provider, config.id, profile, draft.previousSlug);
				if (nextRouting) app.saveRouting(provider, config.id, nextRouting);
				const registered = await persistProfileChange(ctx, provider, prefetched);
				if (registered) {
					if (!draft.isNew) {
						await refreshSelectedProfile(
							ctx,
							provider.name,
							profileModelId(config.id, draft.previousSlug ?? draft.handle),
							draft.exposeAsModel ? profileModelId(config.id, draft.handle) : config.id,
						);
					}
					await refreshAdaptiveSelection(ctx, provider, config.id);
					updateThinkingProfileStatus(ctx);
					ctx.ui.notify(`${draft.isNew ? "Created" : "Updated"} preset "${draft.handle}".`, "info");
					return;
				}
				// registration failed but storage saved; stay in editor for retry
				continue;
			}
			if (action === "remove") {
				app.removeProfile(provider, config.id, draft.handle);
				const registered = await persistProfileChange(ctx, provider, prefetched);
				if (registered) {
					await refreshSelectedProfile(ctx, provider.name, profileModelId(config.id, draft.handle), config.id);
					await refreshAdaptiveSelection(ctx, provider, config.id);
					updateThinkingProfileStatus(ctx);
					ctx.ui.notify(`Deleted preset "${draft.handle}".`, "info");
				}
				return;
			}
			return;
		}

		function buildEditor() {
			return buildPresetSnapshot({
				version: modelDiscoveryVersion(),
				sourceName: provider.name,
				modelId: config.id,
				handle: draft.handle,
				fields: draft.fields,
				aliasId: profileModelId(config.id, draft.handle),
				exposeAsModel: draft.exposeAsModel,
				issues: draftIssues(draft),
				isNew: draft.isNew,
				armed: [...armed],
				page,
			});
		}
	}


	async function routingPanel(
		ctx: ExtensionCommandContext,
		provider: DiscoveredProvider,
		config: ModelConfig,
		allConfigs: ModelConfig[],
		prefetched: { models: Record<string, unknown>[]; serverType: string },
	): Promise<void> {
		const profiles = app.profiles(provider, config.id);
		if (profiles.length === 0) {
			ctx.ui.notify("Create at least one preset before configuring adaptive routing.", "warning");
			return;
		}
		const existing = app.profileRouting(provider, config.id);
		const routing: ModelProfileRouting = existing ? { ...existing, levels: { ...existing.levels } } : defaultProfileRouting(profiles);
		const armed = new Set<string>();
		for (;;) {
			const analysis = analyzeExplicitProfileRouting(routing, app.profiles(provider, config.id));
			const built = buildRoutingSnapshot({
				version: modelDiscoveryVersion(),
				sourceName: provider.name,
				modelId: config.id,
				aliasSlug: routing.aliasSlug,
				aliasId: profileModelId(config.id, routing.aliasSlug),
				enabled: routing.enabled,
				levels: { ...routing.levels } as Record<string, string>,
				choices: app.profiles(provider, config.id).map((p) => p.slug),
				issues: analysis.errors,
				armed: [...armed],
			});
			const result = await runPanel(ctx, (deps) =>
				new SettingsPanel({
					...deps,
					snapshot: () =>
						buildRoutingSnapshot({
							version: modelDiscoveryVersion(),
							sourceName: provider.name,
							modelId: config.id,
							aliasSlug: routing.aliasSlug,
							aliasId: profileModelId(config.id, routing.aliasSlug),
							enabled: routing.enabled,
							levels: { ...routing.levels } as Record<string, string>,
							choices: app.profiles(provider, config.id).map((p) => p.slug),
							issues: analyzeExplicitProfileRouting(routing, app.profiles(provider, config.id)).errors,
							armed: [...armed],
						}).snapshot,
					apply: (key, raw) => {
						if (key === `cfg:routing:${config.id}:alias`) {
							const alias = raw.trim();
							const error = validateProfileSlug(alias);
							if (error) return error;
							routing.aliasSlug = alias;
							return null;
						}
						if (key === `routing:${config.id}:enabled`) {
							routing.enabled = raw !== "true";
							return null;
						}
						const lm = key.match(/^routing:(.+?):level:(.+)$/);
						if (lm && lm[1] === config.id && THINKING_LEVELS.includes(lm[2] as (typeof THINKING_LEVELS)[number])) {
							const slugs = app.profiles(provider, config.id).map((p) => p.slug);
							if (raw !== "" && !slugs.includes(raw)) return `"${raw}" is not a preset of this model.`;
							routing.levels[lm[2] as (typeof THINKING_LEVELS)[number]] = raw;
							return null;
						}
						return `Unknown setting '${key}'.`;
					},
					activate: (key): PanelActionResult => {
						if (key === `routing:${config.id}:conventional`) {
							const off = conventionalPreset(app.profiles(provider, config.id), "off")?.slug ?? "";
							const low = conventionalPreset(app.profiles(provider, config.id), "low")?.slug ?? "";
							const medium = conventionalPreset(app.profiles(provider, config.id), "medium")?.slug ?? "";
							const xhigh = conventionalPreset(app.profiles(provider, config.id), "xhigh")?.slug ?? "";
							if (!off || !low || !medium || !xhigh) {
								return { kind: "error", message: "The four-preset layout needs off/low/medium/xhigh presets — map the levels manually." };
							}
							routing.levels = { off, minimal: low, low, medium, high: xhigh, xhigh, max: xhigh };
							return { kind: "updated", message: "Four-preset layout mapped across all seven Pi levels — save to write." };
						}
						if (key === `routing:${config.id}:save`) {
							const errors = analyzeExplicitProfileRouting(routing, app.profiles(provider, config.id)).errors;
							if (errors.length) return { kind: "error", message: errors[0] ?? "Invalid mapping." };
							const aliasId = profileModelId(config.id, routing.aliasSlug);
							if (allConfigs.some((model) => model.id === aliasId)) {
								return { kind: "error", message: `Adaptive alias "${aliasId}" collides with a server model.` };
							}
							if (!armed.has(key)) {
								armed.add(key);
								return { kind: "updated", message: `Press save again to write "${aliasId}" — the base model never changes.` };
							}
							return { kind: "close", action: "save" };
						}
						if (key === `routing:${config.id}:remove`) {
							if (!existing) return { kind: "error", message: "No adaptive routing to remove." };
							if (!armed.has(key)) {
								armed.add(key);
								return { kind: "updated", message: `Press enter again to remove adaptive alias "${existing.aliasSlug}" on "${config.id}" — presets and fixed aliases stay.` };
							}
							return { kind: "close", action: "remove" };
						}
						if (key === BACK_KEY) return { kind: "close", action: "back" };
						return { kind: "none" };
					},
				}),
			);
			void built;
			const action = result?.action;
			if (!action || action === "back") return;
			if (action === "save") {
				const previousAlias = existing?.aliasSlug;
				app.saveRouting(provider, config.id, routing);
				const registered = await persistProfileChange(ctx, provider, prefetched);
				if (registered) {
					if (previousAlias) {
						const nextAlias = routing.enabled ? routing.aliasSlug : undefined;
						await refreshSelectedProfile(
							ctx,
							provider.name,
							profileModelId(config.id, previousAlias),
							nextAlias ? profileModelId(config.id, nextAlias) : config.id,
						);
					}
					updateThinkingProfileStatus(ctx);
					ctx.ui.notify("Adaptive routing saved.", "info");
					return;
				}
				continue;
			}
			if (action === "remove") {
				const previousAlias = existing?.aliasSlug;
				app.removeRouting(provider, config.id);
				const registered = await persistProfileChange(ctx, provider, prefetched);
				if (registered) {
					if (previousAlias) {
						await refreshSelectedProfile(ctx, provider.name, profileModelId(config.id, previousAlias), config.id);
					}
					updateThinkingProfileStatus(ctx);
					ctx.ui.notify("Adaptive routing removed.", "info");
				}
				return;
			}
			return;
		}
	}

	/** Source picker for browse/presets/routing entries (panel-native replacement of the old tree root). */
	async function sourcePickerPanel(ctx: ExtensionCommandContext, purpose: string): Promise<string | undefined> {
		let page = 0;
		for (;;) {
			const built = buildPicker();
			const result = await runPanel(ctx, (deps) =>
				new SettingsPanel({
					...deps,
					snapshot: () => buildPicker().snapshot,
					apply: () => "This screen has no editable fields.",
					activate: (key): PanelActionResult => {
						if (key === PAGE_PREV_KEY) {
							page = Math.max(0, page - 1);
							return { kind: "updated" };
						}
						if (key === PAGE_NEXT_KEY) {
							page = page + 1;
							return { kind: "updated" };
						}
						if (key === "source:add") return { kind: "close", action: "source:add" };
						if (key === BACK_KEY) return { kind: "close", action: "home" };
						if (key.startsWith("source:")) return { kind: "close", action: key };
						return { kind: "none" };
					},
				}),
			);
			const action = result?.action;
			if (!action || action === "home") return undefined;
			if (action === "source:add") return "source:add";
			if (action.startsWith("source:")) return action.slice("source:".length);
			return undefined;
		}

		function buildPicker() {
			return buildSourcePickerSnapshot({
				version: modelDiscoveryVersion(),
				purpose,
				page,
				sources: app.listSources().map((p) => ({
					name: p.name,
					baseUrl: p.baseUrl,
					serverType: p.serverType ?? "unknown server",
					modelCount: p.cachedModels?.length ?? 0,
					availability: sourceAvailability(p),
					presetCount: Object.values(p.modelProfiles ?? {}).reduce((n, list) => n + list.length, 0),
				})),
			});
		}
	}

	/** Model picker inside a source (for presets/routing entry points). */
	async function modelPickerPanel(ctx: ExtensionCommandContext, provider: DiscoveredProvider, purpose: string): Promise<ModelConfig | undefined> {
		const configs = (provider.cachedModels ?? []).map(extractModelConfig);
		let page = 0;
		for (;;) {
			const built = buildPicker();
			const result = await runPanel(ctx, (deps) =>
				new SettingsPanel({
					...deps,
					snapshot: () => buildPicker().snapshot,
					apply: () => "This screen has no editable fields.",
					activate: (key): PanelActionResult => {
						if (key === PAGE_PREV_KEY) {
							page = Math.max(0, page - 1);
							return { kind: "updated" };
						}
						if (key === PAGE_NEXT_KEY) {
							page = page + 1;
							return { kind: "updated" };
						}
						if (key === BACK_KEY) return { kind: "close", action: "home" };
						if (key.startsWith("model:")) return { kind: "close", action: key };
						return { kind: "none" };
					},
				}),
			);
			const action = result?.action;
			if (!action || action === "home") return undefined;
			if (action.startsWith("model:")) {
				const id = action.slice("model:".length);
				return configs.find((c) => c.id === id);
			}
			return undefined;
		}

		function buildPicker() {
			return buildModelPickerSnapshot({
				version: modelDiscoveryVersion(),
				sourceName: provider.name,
				purpose,
				page,
				models: configs.map((c) => ({
					id: c.id,
					flags: modelFlags(c, provider.modelOverrides?.[c.id]),
					summary: modelDescription(c, provider),
					presetCount: app.profiles(provider, c.id).length,
					routingSummary: routingSummaryOf(provider, c.id),
				})),
			});
		}
	}

	/** Panel-native add flow (form → probe → review → register). */
	async function addSourcePanel(ctx: ExtensionCommandContext, presetUrl?: string, presetName?: string): Promise<void> {
		const draft = {
			url: presetUrl ?? "",
			name: presetName?.trim() ?? "",
			hasKey: false,
			apiKey: undefined as string | undefined,
			defaultContextWindow: null as number | null,
			defaultMaxTokens: null as number | null,
		};
		let live: { models: Record<string, unknown>[]; serverType: string } | null = null;
		let urlError: string | undefined;
		let page = 0;

		const toAddModels = (): { id: string; flags: string; summary: string; unreported: boolean }[] =>
			(live?.models ?? []).map((raw) => {
				const c = extractModelConfig(raw);
				const ov = overridesOf(draft, c.id);
				return {
					id: c.id,
					flags: modelFlags(c, ov),
					summary: `ctx ${fmt(ov?.contextWindow ?? c.contextWindow ?? draft.defaultContextWindow ?? null)} · max ${fmt(ov?.maxTokens ?? c.maxTokens ?? draft.defaultMaxTokens ?? null)}`,
					unreported: (ov?.contextWindow ?? c.contextWindow) === null || (ov?.maxTokens ?? c.maxTokens) === null,
				};
			});
		const perModel = new Map<string, ModelOverride>();

		function overridesOf(_d: typeof draft, id: string): ModelOverride | undefined {
			return perModel.get(id);
		}

		for (;;) {
			const stage = live ? "review" : "form";
			const snapshotFor = () =>
				buildAddSnapshot({
					version: modelDiscoveryVersion(),
					stage,
					draft: { url: draft.url, name: draft.name || suggested(), hasKey: draft.hasKey, defaultContextWindow: draft.defaultContextWindow, defaultMaxTokens: draft.defaultMaxTokens },
					models: toAddModels(),
					note: live ? (live.models.length === 0 ? "online but no models reported" : undefined) : undefined,
					urlError,
					page,
				});
			const built = snapshotFor();
			const result = await runPanel(ctx, (deps) =>
				new SettingsPanel({
					...deps,
					snapshot: () => snapshotFor(),
					apply: (key, raw) => {
						if (key === ADD_URL_KEY) {
							const value = raw.trim();
							if (!value) return "Endpoint URL cannot be blank.";
							if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) return "Endpoint URL must use HTTP or HTTPS.";
							try {
								draft.url = normalizeEndpointUrl(value);
								urlError = undefined;
								return null;
							} catch {
								return "Enter a valid HTTP or HTTPS endpoint URL.";
							}
						}
						if (key === ADD_NAME_KEY) {
							const name = raw.trim();
							if (!name) return "Source name cannot be blank.";
							if (app.findSource(name)) return `Source "${name}" already exists. Open it from the home screen instead.`;
							draft.name = name;
							return null;
						}
						if (key === ADD_FALLBACK_CTX_KEY || key === ADD_FALLBACK_MAX_KEY) {
							if (!raw.trim()) {
								if (key === ADD_FALLBACK_CTX_KEY) draft.defaultContextWindow = null;
								else draft.defaultMaxTokens = null;
								return null;
							}
							const n = positiveInt(raw);
							if (n === null) return "Enter a positive whole number greater than zero.";
							if (key === ADD_FALLBACK_CTX_KEY) draft.defaultContextWindow = n;
							else draft.defaultMaxTokens = n;
							return null;
						}
						const mm = key.match(/^cfg:add:model:(.+?):(contextWindow|maxTokens)$/);
						if (mm) {
							const ov = perModel.get(mm[1]) ?? {};
							if (!raw.trim()) {
								const next = { ...ov };
								delete next[mm[2] as "contextWindow" | "maxTokens"];
								perModel.set(mm[1], next);
								return null;
							}
							const n = positiveInt(raw);
							if (n === null) return "Enter a positive whole number greater than zero.";
							perModel.set(mm[1], { ...ov, [mm[2]]: n });
							return null;
						}
						return `Unknown setting '${key}'.`;
					},
					activate: (key): PanelActionResult => {
						if (key === ADD_KEY_KEY) return { kind: "close", action: "apikey" };
						if (key === ADD_SCAN_KEY) return { kind: "close", action: "scan" };
						if (key === ADD_REGISTER_KEY) return { kind: "close", action: "register" };
						if (key === PAGE_PREV_KEY) {
							page = Math.max(0, page - 1);
							return { kind: "updated" };
						}
						if (key === PAGE_NEXT_KEY) {
							page = page + 1;
							return { kind: "updated" };
						}
						if (key === BACK_KEY) return { kind: "close", action: "cancel" };
						if (key.startsWith("add:model:")) return { kind: "close", action: key };
						return { kind: "none" };
					},
				}),
			);
			void built;
			const action = result?.action;
			if (!action || action === "cancel") {
				ctx.ui.notify("Discovery cancelled.", "info");
				return;
			}
			if (action === "apikey") {
				const entered = await askSecretPanel(ctx, "API key — never displayed");
				if (entered === undefined) continue;
				const key = entered.trim();
				if (!key) {
					ctx.ui.notify("API key cannot be blank. Leave unset for anonymous access.", "warning");
					continue;
				}
				draft.apiKey = key;
				draft.hasKey = true;
				continue;
			}
			if (action === "scan") {
				if (!draft.url) {
					urlError = "Enter a URL first.";
					continue;
				}
				const probed = await runLoader(ctx, `Probing ${draft.url}${draft.apiKey ? " with API key" : ""}...`, (signal) =>
					fetchModels(draft.url, draft.apiKey, signal),
				);
				if (!probed) {
					ctx.ui.notify("Probe failed — check the URL, the server, or the API key, then try again.", "warning");
					continue;
				}
				live = probed;
				if (!draft.name) draft.name = suggested();
				continue;
			}
			if (action.startsWith("add:model:")) {
				const id = action.slice("add:model:".length);
				const raw = (live?.models ?? []).find((m) => String((m as { id?: string }).id ?? "") === id);
				const config = raw ? extractModelConfig(raw) : undefined;
				if (config) {
					// per-model edits happen inline in the review stage rows
					const ov = overridesOf(draft, id) ?? {};
					const modelSnapshot = () =>
						buildAddModelSnapshot({
							version: modelDiscoveryVersion(),
							draftName: draft.name || suggested(),
							model: {
								id,
								flags: modelFlags(config, ov),
								serverContextWindow: config.contextWindow ?? null,
								serverMaxTokens: config.maxTokens ?? null,
								contextWindow: ov.contextWindow ?? config.contextWindow ?? draft.defaultContextWindow ?? null,
								maxTokens: ov.maxTokens ?? config.maxTokens ?? draft.defaultMaxTokens ?? null,
							},
						});
					await runPanel(ctx, (deps) =>
						new SettingsPanel({
							...deps,
							snapshot: () => modelSnapshot(),
							apply: (k, raw2) => {
								const mm = k.match(/^cfg:add:model:(.+?):(contextWindow|maxTokens)$/);
								if (!mm || mm[1] !== id) return `Unknown setting '${k}'.`;
								if (!raw2.trim()) {
									const next = { ...ov };
									delete next[mm[2] as "contextWindow" | "maxTokens"];
									perModel.set(id, next);
									return null;
								}
								const n = positiveInt(raw2);
								if (n === null) return "Enter a positive whole number greater than zero.";
								perModel.set(id, { ...ov, [mm[2]]: n });
								return null;
							},
							activate: (k): PanelActionResult => (k === BACK_KEY ? { kind: "close", action: "back" } : { kind: "none" }),
						}),
					);
				}
				continue;
			}
			if (action === "register") {
				if (!live) continue;
				const name = draft.name || suggested();
				const configs = live.models.map(extractModelConfig);
				const stillMissingCtx = configs.some((c) => (overridesOf(draft, c.id)?.contextWindow ?? c.contextWindow) === null);
				const stillMissingMax = configs.some((c) => (overridesOf(draft, c.id)?.maxTokens ?? c.maxTokens) === null);
				if (stillMissingCtx && draft.defaultContextWindow === null) {
					ctx.ui.notify("Some models never reported a context window — set the fallback row first.", "warning");
					continue;
				}
				if (stillMissingMax && draft.defaultMaxTokens === null) {
					ctx.ui.notify("Some models never reported max output — set the fallback row first.", "warning");
					continue;
				}
				const provider: DiscoveredProvider = {
					name,
					baseUrl: draft.url,
					apiKey: draft.apiKey,
					...(draft.defaultContextWindow !== null ? { defaultContextWindow: draft.defaultContextWindow } : {}),
					...(draft.defaultMaxTokens !== null ? { defaultMaxTokens: draft.defaultMaxTokens } : {}),
					...(perModel.size ? { modelOverrides: Object.fromEntries(perModel) } : {}),
				};
				try {
					await registerProvider(provider, live);
					recordSuccessfulScan(provider, live.models, live.serverType, false);
					app.saveSource(provider);
					ctx.ui.notify(`Registered ${configs.length} model(s) from ${live.serverType} as "${name}". Use /model to select.`, "info");
					return;
				} catch (err) {
					ctx.ui.notify(`Failed to register: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				continue;
			}
		}

		function suggested(): string {
			return draft.name || (draft.url ? generateProviderName(draft.url) : "?");
		}
	}


	async function showReport(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
		if (ctx.mode !== "tui") {
			emitText(ctx, text);
			return;
		}
		const lines = text.split("\n");
		let page = 0;
		for (;;) {
			const snapshot = () => buildReportSnapshot({ title, version: modelDiscoveryVersion(), lines, page });
			const result = await runPanel(ctx, (deps) =>
				new SettingsPanel({
					...deps,
					snapshot,
					apply: () => "This report is read-only.",
					activate: (key): PanelActionResult => {
						if (key === PAGE_PREV_KEY) {
							page = Math.max(0, page - 1);
							return { kind: "updated" };
						}
						if (key === PAGE_NEXT_KEY) {
							page = page + 1;
							return { kind: "updated" };
						}
						if (key === BACK_KEY || key === "close") return { kind: "close", action: "close" };
						return { kind: "none" };
					},
				}),
			);
			if (!result?.action || result.action === "close") return;
		}
	}

	/** Home dashboard (slice 1b): canonical SettingsPanel; every deep key is panel-native. */
	async function showMainScreen(ctx: ExtensionCommandContext): Promise<void> {
		let initialKey: string | undefined;
		for (;;) {
			const result = await runPanel(ctx, (deps) =>
				new SettingsPanel({
					...deps,
					initialKey,
					snapshot: () => buildHomeSnapshot(buildHomeInput()),
					apply: (key) =>
						/^cfg:/.test(key)
							? "Advanced config is wired in slice 3 of this migration — `/discover doctor` shows effective state."
							: `Unknown setting '${key}'.`,
						activate: (key): PanelActionResult => ({ kind: "close", action: key }),
					}),
				);
			const action = typeof result === "string" ? result : result?.action;
			if (!action || action === "close" || action === "quit") return;
			initialKey = action;
			if (action === "discover") {
				await runRescanAll(ctx);
				continue;
			}
			if (action === "source:add") {
				await addSourcePanel(ctx);
				continue;
			}
			if (action === "browse") {
				const picked = await sourcePickerPanel(ctx, "to browse");
				if (picked === "source:add") {
					await addSourcePanel(ctx);
				} else if (picked) {
					const provider = app.findSource(picked);
					if (provider) await endpointPanel(ctx, provider);
				}
				continue;
			}
			if (action === "presets" || action === "routing") {
				const picked = await sourcePickerPanel(ctx, action === "presets" ? "for presets" : "for adaptive routing");
				if (picked === "source:add") {
					await addSourcePanel(ctx);
					continue;
			}
				if (!picked) continue;
				const provider = app.findSource(picked);
				if (!provider) continue;
				const config = await modelPickerPanel(ctx, provider, action === "presets" ? "for presets" : "for adaptive routing");
				if (!config) continue;
				const configs = (provider.cachedModels ?? []).map(extractModelConfig);
				const catalog = cachedCatalog(provider) ?? { models: [], serverType: provider.serverType ?? "OpenAI-compatible" };
				if (action === "presets") await presetsPanel(ctx, provider, config, configs, catalog);
				else await routingPanel(ctx, provider, config, configs, catalog);
				continue;
			}
			if (action === "configure-advanced") {
				await showReport(
					ctx,
					"Advanced configuration",
					"Wired in slice 3 (cfg:<scope>:<field> apply). Today: `/discover doctor` for effective state, or edit ~/.pi/agent/model-discovery.json directly.",
				);
				continue;
			}
			if (action === "doctor") {
				await showReport(ctx, "Model Discovery diagnostics", buildDiagnosticsLines(app.listSources()).join("\n"));
				continue;
			}
			if (action === "status") {
				await showReport(ctx, "Model Discovery status", formatDiscoveryStatus(app.listSources()));
				continue;
			}
			if (action === "paths") {
				await showReport(ctx, "Model Discovery paths", `Configuration: ${STORAGE_PATH}`);
				continue;
			}
			if (action === "help") {
				await showReport(ctx, "Model Discovery help", DISCOVER_USAGE);
				continue;
			}
			if (action.startsWith("source:")) {
				const provider = app.findSource(action.slice("source:".length));
				if (provider) await endpointPanel(ctx, provider);
				continue;
			}
			return;
		}
	}
	// -----------------------------------------------------------------------
	// Command: /discover — single entry point
	// -----------------------------------------------------------------------

	type ReportLevel = "info" | "warning" | "error";
	function emitText(ctx: ExtensionCommandContext, text: string, level: ReportLevel = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else console.log(text);
	}



	async function addSourceHeadlessly(
		ctx: ExtensionCommandContext,
		url: string,
		providerName?: string,
	): Promise<void> {
		try {
			const result = await discoverAndRegisterSource({ url, providerName });
			emitText(
				ctx,
				`Registered source "${result.provider.name}" (${result.serverType}): ${result.models.length} base model(s)${result.profileCount ? ` + ${result.profileCount} preset model(s)` : ""}.`,
			);
		} catch (error) {
			emitText(ctx, `Could not add source: ${errorMessage(error)}`, "error");
		}
	}

	pi.registerCommand("discover", {
		description: "Open model-source discovery or inspect it with /discover status",
		getArgumentCompletions: (prefix) => completeDiscoverArgs(
			prefix,
			app.listSources().map((provider) => provider.name),
		),
		handler: async (args, ctx) => {
			const intent = parseDiscoverArgs(args);
			switch (intent.kind) {
				case "open":
					if (ctx.mode === "tui") await showMainScreen(ctx);
					else await showReport(ctx, "Model Discovery status", formatDiscoveryStatus(app.listSources()));
					return;
				case "status":
					await showReport(ctx, "Model Discovery status", formatDiscoveryStatus(app.listSources()));
					return;
				case "doctor": {
					const lines = buildDiagnosticsLines(app.listSources());
					lines.push(
						"",
						"Actions",
						"- Re-scan from the wizard to refresh live catalogues.",
						"- Authentication secrets are configured only through the masked TUI.",
					);
					await showReport(ctx, "Model Discovery diagnostics", lines.join("\n"));
					return;
				}
				case "paths":
					await showReport(ctx, "Model Discovery paths", `Configuration: ${STORAGE_PATH}`);
					return;
				case "help":
					await showReport(ctx, "Model Discovery help", DISCOVER_USAGE);
					return;
				case "add":
					if (!intent.url) {
						if (ctx.mode === "tui") await addSourcePanel(ctx);
						else emitText(ctx, `Missing source URL.\n${DISCOVER_USAGE}`, "error");
						return;
					}
					if (ctx.mode === "tui") {
						await addSourcePanel(ctx, intent.url, intent.providerName);
					} else {
						await addSourceHeadlessly(ctx, intent.url, intent.providerName);
					}
					return;
				case "remove": {
					const provider = app.findSource(intent.name);
					if (!provider) {
						emitText(ctx, `Unknown source: ${intent.name}`, "error");
						return;
					}
					if (!intent.confirmed && ctx.mode !== "tui") {
						emitText(ctx, `Refusing to remove "${provider.name}" without --yes.`, "error");
						return;
					}
					const confirmed = intent.confirmed || await ctx.ui.confirm(
						"Remove source",
						`Unregister "${provider.name}" and delete its saved configuration, cached catalogue, presets, and routing?`,
					);
					if (!confirmed) return;
					pi.unregisterProvider(provider.name);
					app.removeSource(provider.name);
					emitText(ctx, `Removed source "${provider.name}".`);
					return;
				}
				case "source-open": {
					const provider = app.findSource(intent.name);
					if (!provider) {
						emitText(ctx, `Unknown source: ${intent.name}`, "error");
						return;
					}
					if (ctx.mode === "tui") await endpointPanel(ctx, provider);
					else await showReport(ctx, `Source ${provider.name}`, formatDiscoveryStatus([provider]));
					return;
				}
				case "source-rename": {
					const provider = app.findSource(intent.oldName);
					if (!provider) {
						emitText(ctx, `Unknown source: ${intent.oldName}`, "error");
						return;
					}
					const newName = intent.newName.trim();
					if (!newName) {
						emitText(ctx, "Source name cannot be blank.", "error");
						return;
					}
					if (app.listSources().some((c) => c.name === newName)) {
						emitText(ctx, `Source "${newName}" already exists.`, "error");
						return;
					}
					const renamed = app.renameSource(provider, newName);
					if (!renamed.ok) {
						emitText(ctx, `Cannot rename — "${newName}" already exists.`, "error");
						return;
					}
					try {
						await registerProvider(provider, cachedCatalog(provider));
						try {
							pi.unregisterProvider(renamed.oldName);
						} catch {
							/* stale registration may already be gone */
						}
						app.saveSource(provider);
						emitText(ctx, `Renamed "${renamed.oldName}" to "${newName}".`);
					} catch (error) {
						app.renameSource(provider, renamed.oldName);
						emitText(ctx, `Rename rolled back: ${errorMessage(error)}`, "error");
					}
					return;
				}
				case "source-auth": {
					const provider = app.findSource(intent.name);
					if (!provider) {
						emitText(ctx, `Unknown source: ${intent.name}`, "error");
						return;
					}
					let nextApiKey: string | undefined;
					if (intent.keyFromEnv) {
						const value = process.env[intent.keyFromEnv]?.trim();
						if (!value) {
							emitText(ctx, `Environment variable ${intent.keyFromEnv} is not set or empty. Secrets are never accepted inline.`, "error");
							return;
						}
						nextApiKey = value;
					} else if (ctx.mode === "tui") {
						const entered = await askSecretPanel(ctx, `API key for ${provider.name} — never displayed`);
						if (entered === undefined) return;
						nextApiKey = entered.trim();
					} else {
						emitText(ctx, `Interactive key entry needs a TUI. Use: /discover source auth ${intent.name} --key-from-env ENV`, "error");
						return;
					}
					if (!nextApiKey) {
						emitText(ctx, "API key cannot be blank. Clear it from the source panel for anonymous access.", "error");
						return;
					}
					app.setCredential(provider, nextApiKey);
					app.saveSource(provider);
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
							app.saveSource(provider);
							emitText(ctx, `Authentication saved and validated for ${provider.name} (${checked.models.length} models).`);
						} catch (error) {
							recordFailedScan(provider, error);
							emitText(ctx, `Authentication saved, but registration failed: ${errorMessage(error)}`, "warning");
						}
					} else {
						if (provider.cachedModels?.length) {
							try {
								await registerProvider(provider, cachedCatalog(provider));
							} catch (error) {
								emitText(ctx, `Authentication was saved, but cached registration failed: ${errorMessage(error)}`, "warning");
							}
						}
						emitText(ctx, "Authentication saved but could not be validated; the last known-good catalogue was retained.", "warning");
					}
					return;
				}
				case "source-defaults": {
					const provider = app.findSource(intent.name);
					if (!provider) {
						emitText(ctx, `Unknown source: ${intent.name}`, "error");
						return;
					}
					if (intent.contextWindow !== undefined) provider.defaultContextWindow = intent.contextWindow;
					if (intent.maxTokens !== undefined) provider.defaultMaxTokens = intent.maxTokens;
					app.saveSource(provider);
					await registerProviderSafe(ctx, provider, cachedCatalog(provider), "Fallback defaults saved");
					return;
				}
				case "source-rescan": {
					const provider = app.findSource(intent.name);
					if (!provider) {
						emitText(ctx, `Unknown source: ${intent.name}`, "error");
						return;
					}
					const registered = await runLoader(
						ctx,
						`Re-scanning ${provider.name}...`,
						(signal) => registerProvider(provider, undefined, signal),
						(error) => recordFailedScan(provider, error),
					);
					if (registered) {
						recordSuccessfulScan(provider, registered.rawModels, registered.serverType, false);
						app.saveSource(provider);
						emitText(ctx, `Re-scanned "${provider.name}" (${registered.serverType}): ${registered.rawModels.length} model(s) live.`);
						return;
					}
					if (provider.cachedModels?.length) {
						try {
							await registerProvider(provider, cachedCatalog(provider));
							app.saveSource(provider);
							emitText(ctx, `Scan failed; "${provider.name}" re-registered from its cached catalogue.`, "warning");
						} catch (error) {
							emitText(ctx, `Scan failed and cached re-registration failed too: ${errorMessage(error)}`, "error");
						}
						return;
					}
					emitText(ctx, `Scan failed and no cached catalogue exists for "${provider.name}".`, "error");
					return;
				}
				case "model-set": {
					const sources = intent.source ? [app.findSource(intent.source)].filter((s): s is NonNullable<typeof s> => Boolean(s)) : app.listSources();
					if (intent.source && sources.length === 0) {
						emitText(ctx, `Unknown source: ${intent.source}`, "error");
						return;
					}
					const provider = sources.find((s) => (s.cachedModels ?? []).some((m) => String((m as { id?: unknown }).id ?? "") === intent.modelId));
					if (!provider) {
						emitText(ctx, `Model "${intent.modelId}" is not in any cached catalogue — add or rescan the source first.`, "error");
						return;
					}
					const prefetched = cachedCatalog(provider) ?? { models: [], serverType: provider.serverType ?? "OpenAI-compatible" };
					const ov = provider.modelOverrides?.[intent.modelId] ?? {};
					const writeOverride = async (patch: ModelOverride, feedback: string) => {
						provider.modelOverrides = { ...provider.modelOverrides, [intent.modelId]: { ...ov, ...patch } };
						app.saveSource(provider);
						await persistModelOverrideRegister(ctx, provider, prefetched, `${feedback} for "${intent.modelId}"`);
					};
					if (intent.field === "vision") {
						const effInput = ov.input ?? ["text"];
						const wantImage = intent.value === "on";
						const nextInput = wantImage ? [...new Set([...effInput, "image"])] : effInput.filter((i) => i !== "image");
						await writeOverride({ input: nextInput }, `Vision ${wantImage ? "enabled" : "disabled"}`);
						return;
					}
					if (intent.field === "reasoning") {
						await writeOverride({ reasoning: intent.value === "on" }, `Reasoning ${intent.value === "on" ? "enabled" : "disabled"}`);
						return;
					}
					const n = positiveInt(intent.value);
					if (n === null) {
						emitText(ctx, "Value must be a positive whole number.", "error");
						return;
					}
					await writeOverride(intent.field === "maxTokens" ? { maxTokens: n } : { contextWindow: n }, `${intent.field === "maxTokens" ? "Max output tokens" : "Context window"} set to ${fmt(n)}`);
					return;
				}
				case "preset-set": {
					const provider = app.findSource(intent.source);
					if (!provider) {
						emitText(ctx, `Unknown source: ${intent.source}`, "error");
						return;
					}
					const existing = app.profiles(provider, intent.modelId).find((p) => p.slug === intent.slug);
					const fields = profileToFlat(existing ?? ({ slug: intent.slug } as never));
					const bool = (raw: string): boolean | undefined => (raw === "on" || raw === "true" ? true : raw === "off" || raw === "false" ? false : undefined);
					if (intent.field === "enable_thinking" || intent.field === "preserve_thinking") {
						const b = bool(intent.value);
						if (b === undefined) {
							emitText(ctx, `${intent.field} expects on|off.`, "error");
							return;
						}
						fields[intent.field] = String(b);
					} else if (intent.field === "reasoning_effort") {
						fields.reasoning_effort = intent.value;
					} else if ((PRESET_FIELD_ORDER as readonly string[]).includes(intent.field)) {
						const n = Number(intent.value);
						if (!Number.isFinite(n)) {
							emitText(ctx, `${intent.field} expects a number.`, "error");
							return;
						}
						fields[intent.field as keyof typeof fields] = String(n);
					} else {
						emitText(ctx, `Unknown preset field: ${intent.field}. Try one of: ${PRESET_FIELD_ORDER.join(", ")}`, "error");
						return;
					}
					const profile = flatToProfile(intent.slug, fields, existing?.exposeAsModel ?? false);
					const prefetched = cachedCatalog(provider) ?? { models: [], serverType: provider.serverType ?? "OpenAI-compatible" };
					app.saveProfile(provider, intent.modelId, profile, existing?.slug);
					const registered = await persistProfileChange(ctx, provider, prefetched);
					if (registered) {
						await refreshAdaptiveSelection(ctx, provider, intent.modelId);
						updateThinkingProfileStatus(ctx);
						emitText(ctx, `${existing ? "Updated" : "Created"} preset "${intent.slug}" on "${intent.modelId}" (${intent.field}=${intent.value}).`);
					}
					return;
				}
				case "preset-remove": {
					const provider = app.findSource(intent.source);
					if (!provider) {
						emitText(ctx, `Unknown source: ${intent.source}`, "error");
						return;
					}
					if (!app.profiles(provider, intent.modelId).some((p) => p.slug === intent.slug)) {
						emitText(ctx, `No preset "${intent.slug}" on "${intent.modelId}".`, "error");
						return;
					}
					if (!intent.confirmed && ctx.mode !== "tui") {
						emitText(ctx, `Refusing to remove preset "${intent.slug}" without --yes.`, "error");
						return;
					}
					if (!intent.confirmed && !(await ctx.ui.confirm("Delete preset", `Delete preset "${intent.slug}" on "${intent.modelId}"?`))) return;
					app.removeProfile(provider, intent.modelId, intent.slug);
					const prefetched = cachedCatalog(provider) ?? { models: [], serverType: provider.serverType ?? "OpenAI-compatible" };
					const registered = await persistProfileChange(ctx, provider, prefetched);
					if (registered) {
						await refreshSelectedProfile(ctx, provider.name, profileModelId(intent.modelId, intent.slug), intent.modelId);
						await refreshAdaptiveSelection(ctx, provider, intent.modelId);
						updateThinkingProfileStatus(ctx);
						emitText(ctx, `Deleted preset "${intent.slug}" on "${intent.modelId}".`);
					}
					return;
				}
				case "routing-set": {
					const provider = app.findSource(intent.source);
					if (!provider) {
						emitText(ctx, `Unknown source: ${intent.source}`, "error");
						return;
					}
					const LEVELS = THINKING_LEVELS;
					if (!(LEVELS as readonly string[]).includes(intent.level)) {
						emitText(ctx, `Unknown routing level: ${intent.level}. Use one of: ${LEVELS.join(", ")}`, "error");
						return;
					}
					const profiles = app.profiles(provider, intent.modelId);
					if (intent.slug && !profiles.some((p) => p.slug === intent.slug)) {
						emitText(ctx, `No preset "${intent.slug}" on "${intent.modelId}" — create it first.`, "error");
						return;
					}
					const existing = app.profileRouting(provider, intent.modelId);
					const routing: ModelProfileRouting = existing
						? { ...existing, levels: { ...existing.levels, [intent.level]: intent.slug } }
						: { ...defaultProfileRouting(profiles), levels: { ...defaultProfileRouting(profiles).levels, [intent.level]: intent.slug } };
					const errors = analyzeExplicitProfileRouting(routing, profiles).errors;
					if (errors.length) {
						emitText(ctx, errors[0] ?? "Invalid mapping.", "error");
						return;
					}
					app.saveRouting(provider, intent.modelId, routing);
					const prefetched = cachedCatalog(provider) ?? { models: [], serverType: provider.serverType ?? "OpenAI-compatible" };
					const registered = await persistProfileChange(ctx, provider, prefetched);
					if (registered) {
						await refreshAdaptiveSelection(ctx, provider, intent.modelId);
						updateThinkingProfileStatus(ctx);
						emitText(ctx, `Routing level "${intent.level}" on "${intent.modelId}" → ${intent.slug ? `"${intent.slug}"` : "unmapped"}.`);
					}
					return;
				}
				case "routing-conventional": {
					const provider = app.findSource(intent.source);
					if (!provider) {
						emitText(ctx, `Unknown source: ${intent.source}`, "error");
						return;
					}
					const profiles = app.profiles(provider, intent.modelId);
					const off = conventionalPreset(profiles, "off")?.slug ?? "";
					const low = conventionalPreset(profiles, "low")?.slug ?? "";
					const medium = conventionalPreset(profiles, "medium")?.slug ?? "";
					const xhigh = conventionalPreset(profiles, "xhigh")?.slug ?? "";
					if (!off || !low || !medium || !xhigh) {
						emitText(ctx, "The four-preset layout needs off/low/medium/xhigh presets — map the levels manually via /discover routing set.", "error");
						return;
					}
					const existing = app.profileRouting(provider, intent.modelId);
					const routing: ModelProfileRouting = existing
						? { ...existing, levels: { ...existing.levels, off, minimal: low, low, medium, high: xhigh, xhigh, max: xhigh } }
						: { ...defaultProfileRouting(profiles), levels: { off, minimal: low, low, medium, high: xhigh, xhigh, max: xhigh } };
					const errors = analyzeExplicitProfileRouting(routing, profiles).errors;
					if (errors.length) {
						emitText(ctx, errors[0] ?? "Invalid mapping.", "error");
						return;
					}
					app.saveRouting(provider, intent.modelId, routing);
					const prefetched = cachedCatalog(provider) ?? { models: [], serverType: provider.serverType ?? "OpenAI-compatible" };
					const registered = await persistProfileChange(ctx, provider, prefetched);
					if (registered) {
						await refreshAdaptiveSelection(ctx, provider, intent.modelId);
						updateThinkingProfileStatus(ctx);
						emitText(ctx, `Four-preset layout mapped on "${intent.modelId}": off=${off}, low/medium=${low}/${medium}, high/xhigh/max=${xhigh}.`);
					}
					return;
				}
				case "routing-remove": {
					const provider = app.findSource(intent.source);
					if (!provider) {
						emitText(ctx, `Unknown source: ${intent.source}`, "error");
						return;
					}
					const existing = app.profileRouting(provider, intent.modelId);
					if (!existing) {
						emitText(ctx, `No adaptive routing on "${intent.modelId}".`, "error");
						return;
					}
					if (!intent.confirmed && ctx.mode !== "tui") {
						emitText(ctx, `Refusing to remove adaptive routing without --yes.`, "error");
						return;
					}
					if (!intent.confirmed && !(await ctx.ui.confirm("Remove adaptive routing", `Remove adaptive alias "${existing.aliasSlug}" on "${intent.modelId}"? Presets stay.`))) return;
					app.removeRouting(provider, intent.modelId);
					const prefetched = cachedCatalog(provider) ?? { models: [], serverType: provider.serverType ?? "OpenAI-compatible" };
					const registered = await persistProfileChange(ctx, provider, prefetched);
					if (registered) {
						await refreshSelectedProfile(ctx, provider.name, profileModelId(intent.modelId, existing.aliasSlug), intent.modelId);
						updateThinkingProfileStatus(ctx);
						emitText(ctx, `Removed adaptive routing on "${intent.modelId}".`);
					}
					return;
				}
				case "invalid":
					emitText(ctx, `${intent.message}\n${DISCOVER_USAGE}`, "error");
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
			let result: Awaited<ReturnType<typeof discoverAndRegisterSource>>;
			try {
				result = await discoverAndRegisterSource(params);
			} catch (error) {
				const message = errorMessage(error);
				if (message === "Endpoint is online but reports no models.") {
					return { content: [{ type: "text", text: message }], details: {} };
				}
				return {
					content: [{ type: "text", text: `Endpoint unavailable or registration failed: ${message}` }],
					details: {},
					isError: true,
				};
			}

			const { provider, models: configs, serverType, profileCount } = result;
			try {
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
							text: `Endpoint online (${serverType}). Registered ${configs.length} base model(s)${
								profileCount ? ` + ${profileCount} profile(s)` : ""
							} as "${provider.name}":\n${lines.join("\n")}${note}\n\nModels are now selectable via /model.`,
						},
					],
					details: { providerName: provider.name, serverType, modelCount: configs.length, profileCount },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Failed to register: ${err instanceof Error ? err.message : String(err)}` }],
					details: {},
					isError: true,
				};
			}
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderCall(args: any, theme: any) {
			const url = typeof args.url === "string" ? args.url : "?";
			const name = typeof args.providerName === "string" && args.providerName ? ` as "${args.providerName}"` : "";
			const text = `→ discover · ${url}${name}`;
			return new Text(theme?.fg ? theme.fg("accent", text) : text, 0, 0);
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderResult(result: any, options: any, theme: any) {
			const fg = (kind: string, s: string) => (theme?.fg ? theme.fg(kind, s) : s);
			const d = (result.details ?? {}) as DiscoverModelsDetails;
			const text = (result.content ?? []).map((c: { text?: string }) => c.text ?? "").filter(Boolean).join("\n");
			if (result.isError) {
				// Authoritative flag only (OPERATIONAL §2.9) — never infer from content.
				const first = text.split("\n")[0] ?? "failed";
				const noModels = /no models/i.test(first);
				const glyph = noModels ? "⊘" : "✗";
				const word = noModels ? "online · no models" : "failed";
				const lines = [fg(noModels ? "warning" : "error", `discover ${glyph} ${word}`), fg("muted", `  ${first.slice(0, 120)}`)];
				lines.push(fg("muted", "  next: check the URL/server, or run /discover → Add provider for an interactive probe"));
				return new Text(lines.join("\n"), 0, 0);
			}
			if (!d.providerName) return new Text(text || "(no output)", 0, 0);
			const bits = [`discover ✓ registered`, `"${d.providerName}"`, d.serverType ?? "?", `${d.modelCount ?? 0} model(s)`];
			if (d.profileCount) bits.push(`+${d.profileCount} preset(s)`);
			const lines = [fg("success", bits.join(" · "))];
			const note = text.split("\n").find((l: string) => /unreported/i.test(l));
			if (note) lines.push(fg("warning", `  ${note.trim().slice(0, 120)}`));
			if (options?.expanded) {
				for (const l of text.split("\n").slice(0, 12)) lines.push(fg("muted", `  ${l}`));
			}
			lines.push(fg("muted", "  next: select a model via /model · tune values via /discover"));
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

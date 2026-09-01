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
	recordFailedScan,
	recordSuccessfulScan,
	STORAGE_PATH,
	type DiscoveredProvider,
	type ModelOverride,
} from "./storage.ts";
import {
	buildDiagnosticsLines,
	buildHomeItems,
	buildHomeSummary,
	formatDiscoveryStatus,
} from "./ui-model.ts";
import { WizardInput, WizardSecretInput, WizardSelect, WizardTextView } from "./ui/wizard-shell.ts";

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

	async function runSelect(
		ctx: ExtensionCommandContext,
		title: string,
		items: SelectItem[],
		headerLines: string[] = [],
	): Promise<string | null> {
		return await ctx.ui.custom<string | null>(
			(tui, theme, keybindings, done) => new WizardSelect({
				theme,
				keybindings,
				title,
				items,
				headerLines,
				requestRender: () => tui.requestRender(),
				done,
			}),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 88, minWidth: 36, maxHeight: "90%", margin: 1 },
			},
		);
	}

	async function runTextView(
		ctx: ExtensionCommandContext,
		title: string,
		lines: string[],
	): Promise<void> {
		await ctx.ui.custom<void>(
			(tui, theme, keybindings, done) => new WizardTextView({
				theme,
				keybindings,
				title,
				lines,
				requestRender: () => tui.requestRender(),
				done: () => done(),
			}),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 88, minWidth: 36, maxHeight: "90%", margin: 1 },
			},
		);
	}

	async function runInput(
		ctx: ExtensionCommandContext,
		title: string,
		initialValue = "",
		description?: string,
		validate?: (value: string) => string | null,
	): Promise<string | undefined> {
		return await ctx.ui.custom<string | undefined>(
			(tui, theme, keybindings, done) => new WizardInput({
				theme,
				keybindings,
				title,
				description,
				initialValue,
				validate,
				requestRender: () => tui.requestRender(),
				done,
			}),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 72, minWidth: 36, maxHeight: "90%", margin: 1 },
			},
		);
	}

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

	async function askSecret(
		ctx: ExtensionCommandContext,
		title: string,
		description: string,
	): Promise<string | undefined> {
		return await ctx.ui.custom<string | undefined>(
			(tui, theme, keybindings, done) => new WizardSecretInput({
				theme,
				keybindings,
				title,
				description,
				requestRender: () => tui.requestRender(),
				done,
			}),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 72, minWidth: 36, maxHeight: "90%", margin: 1 },
			},
		);
	}

	async function askNumber(
		ctx: ExtensionCommandContext,
		title: string,
		initialValue: string,
	): Promise<number | undefined> {
		const raw = await runInput(
			ctx,
			title,
			initialValue,
			"Enter a positive whole number. Clear the field and submit to keep the current value.",
			(value) => {
				const normalized = value.trim().replace(/[,._\s]/g, "");
				if (!normalized) return null;
				if (!/^\d+$/.test(normalized) || Number(normalized) <= 0) return "Enter a positive whole number greater than zero.";
				return null;
			},
		);
		const normalized = raw?.trim().replace(/[,._\s]/g, "");
		return normalized ? Number(normalized) : undefined;
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

		const raw = await runInput(
			ctx,
			`Value for ${field.label}`,
			String(current ?? field.example),
			field.description,
			(value) => {
				const trimmed = value.trim();
				if (!trimmed) return "Enter a numeric value, or return and choose Omit.";
				return validateProfileSampling({ [field.key]: Number(trimmed) });
			},
		);
		return raw === undefined ? null : Number(raw.trim());
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
		const profiles = app.profiles(provider, modelId);
		const index = previousSlug === undefined ? -1 : profiles.findIndex((profile) => profile.slug === previousSlug);
		if (index < 0) return [...profiles, candidate];
		return profiles.map((profile, profileIndex) => (profileIndex === index ? candidate : profile));
	}

	async function promptProfileSlug(
		ctx: ExtensionCommandContext,
		initial: string,
	): Promise<string | null> {
		const answer = await runInput(
			ctx,
			"Preset name",
			initial || "thinking-medium",
			"Use a short slug for the fixed model alias and routing map.",
			(value) => validateProfileSlug(value.trim()),
		);
		return answer === undefined ? null : answer.trim();
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
			const currentRouting = app.profileRouting(provider, config.id);
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
				{ value: "save", label: "Save preset", description: profileModelId(config.id, profile.slug) },
			];
			if (existing) items.push({ value: "delete", label: "Delete preset", description: "Requires confirmation" });
			items.push({ value: "cancel", label: "Cancel" });

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
				const routing = app.profileRouting(provider, config.id);
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
		await runTextView(ctx, `${level} → ${profile.slug}`, [
			`Adaptive model: ${profileModelId(config.id, routing.aliasSlug)}`,
			`Base model: ${config.id}`,
			"",
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
		const existing = app.profileRouting(provider, config.id);
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
				{ value: "preview", label: "Preview exact requests", description: "Inspect the payload preset for each Pi level" },
				{ value: "save", label: "Review and save", description: analysis.errors.length ? `${analysis.errors.length} issue(s)` : "Valid mapping" },
			];
			if (existing) items.push({ value: "remove", label: "Remove adaptive routing", description: "Fixed presets remain unchanged · requires confirmation" });
			items.push({ value: "cancel", label: "Cancel" });

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
			const profiles = app.profiles(provider, config.id);
			const routing = app.profileRouting(provider, config.id);
			const routeAnalysis = routing ? analyzeExplicitProfileRouting(routing, profiles) : undefined;
			const items: SelectItem[] = [
				{
					value: "routing",
					label: "Configure adaptive routing",
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
				{ value: "add", label: "Create preset", description: "Create a complete thinking/sampling parameter bundle" },
				{ value: "clone", label: "Clone preset", description: "Copy an existing preset, then edit only what differs" },
			);
			for (const profile of profiles) {
				items.push({
					value: `profile:${profile.slug}`,
					label: profile.slug,
					description: profileDescription(profile, prefetched.serverType, routing),
				});
			}
			items.push({ value: "back", label: "Back" });

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
				if (result.action === "save") app.saveRouting(provider, config.id, result.routing);
				else app.removeRouting(provider, config.id);
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
				const currentRouting = app.profileRouting(provider, config.id);
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
				app.saveProfile(provider, config.id, result.profile, existing?.slug);
				if (nextRouting) app.saveRouting(provider, config.id, nextRouting);
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
				app.removeProfile(provider, config.id, existing.slug);
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

			const configuredProfiles = app.profiles(provider, config.id);
			const configuredRouting = app.profileRouting(provider, config.id);
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
			items.push({ value: "back", label: "Back" });

			const action = await runSelect(ctx, `Model: ${config.id}${modelFlags(config, ov)}`, items, header);
			if (!action || action === "back") return;

			if (action === "profiles") {
				await showProfilesScreen(ctx, provider, config, allConfigs, prefetched);
				continue;
			}

			let feedback: string | undefined;
			if (action === "ctx") {
				const n = await askNumber(ctx, `Context window for ${config.id}`, String(effCtx ?? 128000));
				if (n === undefined) continue;
				provider.modelOverrides = { ...provider.modelOverrides, [config.id]: { ...ov, contextWindow: n } };
				feedback = `Context window saved as ${fmt(n)}.`;
			} else if (action === "max") {
				const n = await askNumber(ctx, `Max output tokens for ${config.id}`, String(effMax ?? 16384));
				if (n === undefined) continue;
				provider.modelOverrides = { ...provider.modelOverrides, [config.id]: { ...ov, maxTokens: n } };
				feedback = `Max output tokens saved as ${fmt(n)}.`;
			} else if (action === "reasoning") {
				const reasoning = !(effReasoning ?? false);
				provider.modelOverrides = {
					...provider.modelOverrides,
					[config.id]: { ...ov, reasoning },
				};
				feedback = `Reasoning ${reasoning ? "enabled" : "disabled"}.`;
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
				feedback = `Vision input ${hasVision ? "disabled" : "enabled"}.`;
			} else if (action === "clear") {
				if (provider.modelOverrides) {
					delete provider.modelOverrides[config.id];
					if (Object.keys(provider.modelOverrides).length === 0) provider.modelOverrides = undefined;
				}
				feedback = "Model overrides cleared.";
			}
			if (!feedback) continue;

			// Persist + re-register with new values.
			app.saveSource(provider);
			try {
				await registerProvider(provider, prefetched);
				ctx.ui.notify(feedback, "info");
			} catch (error) {
				ctx.ui.notify(`${feedback} Provider registration remains on its previous state: ${errorMessage(error)}`, "warning");
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
				header.push(`latest live scan failed: ${redactSecret(provider.lastScanError, provider.apiKey)}`);
				header.push("Last known-good models and all saved presets remain available.");
			}

			const items: SelectItem[] = configs.map((c) => ({
				value: `model:${c.id}`,
				label: `${c.id}${modelFlags(c, provider.modelOverrides?.[c.id])}`,
				description: modelDescription(c, provider),
			}));
			items.push({ value: "rescan", label: "Re-scan source", description: "Fetch a fresh model list and re-register" });
			items.push({
				value: "rename",
				label: "Rename source",
				description: `Current: ${provider.name}`,
			});
			items.push({
				value: "auth",
				label: "Authentication",
				description: provider.apiKey ? "API key configured · replace or clear" : "Anonymous · add an API key",
			});
			items.push({
				value: "defaults",
				label: "Fallback defaults",
				description: `Used when the server reports nothing · ctx ${fmt(provider.defaultContextWindow ?? null)} · max ${fmt(provider.defaultMaxTokens ?? null)}`,
			});
			items.push({ value: "remove", label: "Remove source", description: "Unregister the provider and delete its saved configuration" });
			items.push({ value: "back", label: "Back" });

			const action = await runSelect(ctx, `Source: ${provider.name}`, items, header);
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
						app.saveSource(provider);
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
				const enteredName = await runInput(
					ctx,
					"New source name",
					provider.name,
					"This name identifies the provider and its models in /model.",
					(value) => {
						const name = value.trim();
						if (!name) return "Source name cannot be blank.";
						if (app.listSources().some((candidate) => candidate.name === name && candidate.name !== provider.name)) {
							return `Source "${name}" already exists.`;
						}
						return null;
					},
				);
				const newName = enteredName?.trim();
				if (newName && newName !== provider.name) {
					const renamed = app.renameSource(provider, newName);
					if (!renamed.ok) {
						ctx.ui.notify(`Cannot rename — "${newName}" already exists or "${renamed.oldName}" was not found.`, "error");
					} else {
						const catalog = live ??
							(provider.cachedModels?.length
								? {
									models: provider.cachedModels,
									serverType: provider.serverType ?? "OpenAI-compatible",
								}
								: undefined);
						try {
							await registerProvider(provider, catalog);
							pi.unregisterProvider(renamed.oldName);
							app.saveSource(provider);
							ctx.ui.notify(`Renamed to "${newName}"${live ? "" : " using the cached catalogue"}.`, "info");
						} catch (error) {
							app.renameSource(provider, renamed.oldName);
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
						{ value: "back", label: "Back" },
					],
					[provider.baseUrl, `Current: ${provider.apiKey ? "API key configured" : "anonymous"}`],
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
				const changed: string[] = [];
				const cw = await askNumber(ctx, "Default context window (blank = keep)", String(provider.defaultContextWindow ?? 128000));
				if (cw !== undefined) {
					provider.defaultContextWindow = cw;
					changed.push(`context ${fmt(cw)}`);
				}
				const mt = await askNumber(ctx, "Default max output tokens (blank = keep)", String(provider.defaultMaxTokens ?? 16384));
				if (mt !== undefined) {
					provider.defaultMaxTokens = mt;
					changed.push(`max output ${fmt(mt)}`);
				}
				if (!changed.length) continue;
				app.saveSource(provider);
				const catalog = live ??
					(provider.cachedModels?.length
						? {
							models: provider.cachedModels,
							serverType: provider.serverType ?? "OpenAI-compatible",
						}
						: undefined);
				try {
					await registerProvider(provider, catalog);
					ctx.ui.notify(`Fallback defaults saved: ${changed.join(" · ")}.`, "info");
				} catch (error) {
					ctx.ui.notify(`Defaults saved; provider remains on its last registered catalogue: ${errorMessage(error)}`, "warning");
				}
			} else if (action === "remove") {
				const sure = await ctx.ui.confirm(
					"Remove source",
					`Unregister "${provider.name}" and delete its saved configuration, cached catalogue, presets, and routing?`,
				);
				if (sure) {
					pi.unregisterProvider(provider.name);
					app.removeSource(provider.name);
					ctx.ui.notify(`Removed "${provider.name}".`, "info");
					return;
				}
			}
		}
	}

	// -----------------------------------------------------------------------
	// Screen: add endpoint
	// -----------------------------------------------------------------------

	async function showAddScreen(ctx: ExtensionCommandContext, presetUrl?: string, presetName?: string): Promise<void> {
		const enteredUrl = presetUrl ?? await runInput(
			ctx,
			"Endpoint URL",
			"http://192.168.1.100:8080",
			"Enter the base URL of an OpenAI-compatible model server.",
			(value) => {
				if (!value.trim()) return "Endpoint URL cannot be blank.";
				if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) && !/^https?:\/\//i.test(value.trim())) {
					return "Endpoint URL must use HTTP or HTTPS.";
				}
				try {
					new URL(normalizeEndpointUrl(value));
					return null;
				} catch {
					return "Enter a valid HTTP or HTTPS endpoint URL.";
				}
			},
		);
		if (!enteredUrl) return;
		let baseUrl: string;
		try {
			baseUrl = normalizeEndpointUrl(enteredUrl);
		} catch (error) {
			ctx.ui.notify(errorMessage(error), "error");
			return;
		}

		const authMode = await runSelect(
			ctx,
			"Endpoint authentication",
			[
				{ value: "none", label: "No API key", description: "Connect without a configured bearer credential" },
				{
					value: "api-key",
					label: "Enter API key",
					description: "Masked while typing · saved only in the private model-discovery configuration",
				},
				{ value: "cancel", label: "Cancel" },
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

		const suggestedName = presetName?.trim() || generateProviderName(baseUrl);
		const enteredName = await runInput(
			ctx,
			"Source name",
			suggestedName,
			"This name identifies the provider and its models in /model.",
			(value) => {
				const name = value.trim();
				if (!name) return "Source name cannot be blank.";
				if (app.findSource(name)) return `Source "${name}" already exists. Open it from the home screen instead.`;
				return null;
			},
		);
		if (enteredName === undefined) return;
		const name = enteredName.trim();

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
			items.push({ value: "register", label: "Register source", description: `Save as "${name}" and make models available in /model` });
			items.push({ value: "cancel", label: "Cancel" });

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
					app.saveSource(provider);
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
			const providers = app.listSources();
			const action = await runSelect(
				ctx,
				"Model Discovery",
				buildHomeItems(providers),
				buildHomeSummary(providers),
			);
			if (!action || action === "quit") return;

			if (action === "add") {
				await showAddScreen(ctx);
			} else if (action === "diagnostics") {
				await runTextView(ctx, "Model Discovery diagnostics", buildDiagnosticsLines(app.listSources()));
			} else if (action === "rescan-all") {
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
			} else if (action.startsWith("provider:")) {
				const name = action.slice("provider:".length);
				const provider = app.findSource(name);
				if (provider) await showEndpointScreen(ctx, provider);
			}
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

	async function showReport(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
		if (ctx.mode === "tui") await runTextView(ctx, title, text.split("\n"));
		else emitText(ctx, text);
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
						if (ctx.mode === "tui") await showAddScreen(ctx);
						else emitText(ctx, `Missing source URL.\n${DISCOVER_USAGE}`, "error");
						return;
					}
					if (ctx.mode === "tui") {
						await showAddScreen(ctx, intent.url, intent.providerName);
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
	});
}

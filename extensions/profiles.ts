export const REASONING_EFFORTS = ["low", "medium", "xhigh"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ChatTemplateKwargs {
	enable_thinking?: boolean;
	reasoning_effort?: ReasoningEffort;
	preserve_thinking?: boolean;
}

/** Backend-neutral sampling values stored in a named profile. */
export interface ProfileSampling {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	repetitionPenalty?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
}

export interface ModelProfile {
	slug: string;
	chatTemplateKwargs?: ChatTemplateKwargs;
	sampling?: ProfileSampling;
	/** Whether this preset is also registered as a fixed model alias. Defaults to true. */
	exposeAsModel?: boolean;
}

export type RepetitionPenaltyWireKey = "repetition_penalty" | "repeat_penalty";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, ThinkingLevel | null>>;
export type ThinkingProfileRoutes = Record<ThinkingLevel, ModelProfile>;

export interface ModelProfileRouting {
	enabled: boolean;
	aliasSlug: string;
	levels: Record<ThinkingLevel, string>;
}

export interface ExplicitProfileRoutingAnalysis {
	routing?: ModelProfileRouting;
	routes?: ThinkingProfileRoutes;
	errors: string[];
}

/**
 * Map Pi's seven native levels onto Qwen's three supported reasoning efforts.
 * Keeping every Pi level available makes Shift-Tab work naturally; adjacent
 * native levels intentionally share the closest Qwen effort.
 */
export const QWEN_NATIVE_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "xhigh",
	xhigh: "xhigh",
	max: "xhigh",
};

/** Dynamic chat-template values resolved by Pi for each request. */
export const QWEN_NATIVE_CHAT_TEMPLATE_KWARGS = {
	enable_thinking: { $var: "thinking.enabled" as const },
	reasoning_effort: { $var: "thinking.effort" as const, omitWhenOff: true },
	preserve_thinking: true,
};

export interface ProfileCapableModel {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Record<string, unknown>;
	samplingParams?: Record<string, unknown>;
}

export interface ProfileExpansionOptions {
	repetitionPenaltyKey?: RepetitionPenaltyWireKey;
}

export interface ProfileExpansion<T extends ProfileCapableModel> {
	models: Array<T & ProfileCapableModel>;
	profileCount: number;
	warnings: string[];
}

const PROFILE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHAT_TEMPLATE_KEYS = new Set(["enable_thinking", "reasoning_effort", "preserve_thinking"]);
const PROFILE_SAMPLING_KEYS = new Set([
	"temperature",
	"topP",
	"topK",
	"minP",
	"repetitionPenalty",
	"presencePenalty",
	"frequencyPenalty",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(object, key);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function validateProfileSlug(slug: string): string | null {
	if (!slug) return "Profile name cannot be empty.";
	if (!PROFILE_SLUG_PATTERN.test(slug)) {
		return "Use 1–64 characters: letters, numbers, dot, underscore, or hyphen; start with a letter or number.";
	}
	return null;
}

export function validateChatTemplateKwargs(value: unknown): string | null {
	if (!isRecord(value)) return "chat_template_kwargs must be an object.";

	for (const key of Object.keys(value)) {
		if (!CHAT_TEMPLATE_KEYS.has(key)) return `Unsupported chat_template_kwargs key: ${key}`;
	}

	if (hasOwn(value, "enable_thinking") && typeof value.enable_thinking !== "boolean") {
		return "enable_thinking must be true or false.";
	}
	if (
		hasOwn(value, "reasoning_effort") &&
		!REASONING_EFFORTS.includes(value.reasoning_effort as ReasoningEffort)
	) {
		return 'reasoning_effort must be "low", "medium", or "xhigh".';
	}
	if (hasOwn(value, "preserve_thinking") && typeof value.preserve_thinking !== "boolean") {
		return "preserve_thinking must be true or false.";
	}
	return null;
}

export function validateProfileSampling(value: unknown): string | null {
	if (value === undefined) return null;
	if (!isRecord(value)) return "sampling must be an object.";

	for (const key of Object.keys(value)) {
		if (!PROFILE_SAMPLING_KEYS.has(key)) return `Unsupported sampling key: ${key}`;
	}
	for (const [key, fieldValue] of Object.entries(value)) {
		if (!isFiniteNumber(fieldValue)) return `${key} must be a finite number.`;
	}

	const temperature = value.temperature;
	if (temperature !== undefined && (!isFiniteNumber(temperature) || temperature < 0 || temperature > 2)) {
		return "temperature must be between 0 and 2.";
	}
	const topP = value.topP;
	if (topP !== undefined && (!isFiniteNumber(topP) || topP < 0 || topP > 1)) {
		return "top_p must be between 0 and 1.";
	}
	const topK = value.topK;
	if (topK !== undefined && (!isFiniteNumber(topK) || !Number.isInteger(topK) || topK < 0)) {
		return "top_k must be an integer greater than or equal to 0.";
	}
	const minP = value.minP;
	if (minP !== undefined && (!isFiniteNumber(minP) || minP < 0 || minP > 1)) {
		return "min_p must be between 0 and 1.";
	}
	const repetitionPenalty = value.repetitionPenalty;
	if (repetitionPenalty !== undefined && (!isFiniteNumber(repetitionPenalty) || repetitionPenalty <= 0)) {
		return "repetition penalty must be greater than 0 (1 disables it).";
	}
	const presencePenalty = value.presencePenalty;
	if (presencePenalty !== undefined && (!isFiniteNumber(presencePenalty) || presencePenalty < -2 || presencePenalty > 2)) {
		return "presence_penalty must be between -2 and 2.";
	}
	const frequencyPenalty = value.frequencyPenalty;
	if (frequencyPenalty !== undefined && (!isFiniteNumber(frequencyPenalty) || frequencyPenalty < -2 || frequencyPenalty > 2)) {
		return "frequency_penalty must be between -2 and 2.";
	}
	return null;
}

export function validateModelProfile(value: unknown): string | null {
	if (!isRecord(value)) return "Profile must be an object.";
	if (typeof value.slug !== "string") return "Profile name must be a string.";

	const chatTemplateKwargs = value.chatTemplateKwargs ?? {};
	const slugError = validateProfileSlug(value.slug);
	if (slugError) return slugError;
	const chatError = validateChatTemplateKwargs(chatTemplateKwargs);
	if (chatError) return chatError;
	const samplingError = validateProfileSampling(value.sampling);
	if (samplingError) return samplingError;
	if (hasOwn(value, "exposeAsModel") && typeof value.exposeAsModel !== "boolean") {
		return "exposeAsModel must be true or false.";
	}

	const hasThinking = Object.keys(chatTemplateKwargs as Record<string, unknown>).length > 0;
	const hasSampling = isRecord(value.sampling) && Object.keys(value.sampling).length > 0;
	if (!hasThinking && !hasSampling) return "Configure at least one thinking or sampling value.";
	return null;
}

export function profileModelId(baseModelId: string, slug: string): string {
	return `${baseModelId}@${slug}`;
}

export function repetitionPenaltyKeyForServer(serverType: string): RepetitionPenaltyWireKey {
	switch (serverType) {
		case "llama.cpp":
		case "LM Studio":
			return "repeat_penalty";
		case "oMLX":
		case "vLLM":
		case "SGLang":
		case "Ollama":
		case "OpenAI-compatible":
		default:
			// Ollama's OpenAI endpoint does not currently expose a dedicated
			// repetition control. Use the ecosystem's common extension key as a
			// best-effort fallback for unknown/OpenAI-compatible servers.
			return "repetition_penalty";
	}
}

export function buildProfileSamplingParams(
	sampling: ProfileSampling | undefined,
	repetitionPenaltyKey: RepetitionPenaltyWireKey = "repetition_penalty",
): Record<string, unknown> {
	if (!sampling) return {};
	const params: Record<string, unknown> = {};
	if (sampling.temperature !== undefined) params.temperature = sampling.temperature;
	if (sampling.topP !== undefined) params.top_p = sampling.topP;
	if (sampling.topK !== undefined) params.top_k = sampling.topK;
	if (sampling.minP !== undefined) params.min_p = sampling.minP;
	if (sampling.repetitionPenalty !== undefined) params[repetitionPenaltyKey] = sampling.repetitionPenalty;
	if (sampling.presencePenalty !== undefined) params.presence_penalty = sampling.presencePenalty;
	if (sampling.frequencyPenalty !== undefined) params.frequency_penalty = sampling.frequencyPenalty;
	return params;
}

export type ThinkingProfileKind = "off" | ReasoningEffort;

export interface ThinkingProfileRouteAnalysis {
	byKind: Record<ThinkingProfileKind, ModelProfile[]>;
	routes?: ThinkingProfileRoutes;
	issues: string[];
}

export function thinkingProfileKind(profile: ModelProfile): ThinkingProfileKind | undefined {
	const kwargs = profile.chatTemplateKwargs;
	if (kwargs?.enable_thinking === false) return "off";
	if (kwargs?.reasoning_effort !== undefined) return kwargs.reasoning_effort;
	return undefined;
}

/** Explain missing/ambiguous preset roles as well as returning a complete route. */
export function analyzeThinkingProfileRoutes(
	profiles: readonly ModelProfile[] | undefined,
): ThinkingProfileRouteAnalysis {
	const byKind: Record<ThinkingProfileKind, ModelProfile[]> = { off: [], low: [], medium: [], xhigh: [] };
	for (const profile of profiles ?? []) {
		if (validateModelProfile(profile) !== null) continue;
		const kind = thinkingProfileKind(profile);
		if (kind !== undefined) byKind[kind].push(profile);
	}
	const issues: string[] = [];
	for (const kind of ["off", "low", "medium", "xhigh"] as const) {
		const matching = byKind[kind];
		if (matching.length === 0) issues.push(`missing ${kind}`);
		else if (matching.length > 1) issues.push(`ambiguous ${kind}: ${matching.map((profile) => profile.slug).join(", ")}`);
	}
	if (issues.length > 0) return { byKind, issues };
	const off = byKind.off[0];
	const low = byKind.low[0];
	const medium = byKind.medium[0];
	const xhigh = byKind.xhigh[0];
	return {
		byKind,
		issues,
		routes: {
			off,
			minimal: low,
			low,
			medium,
			high: xhigh,
			xhigh,
			max: xhigh,
		},
	};
}

/**
 * Build a complete native-level router when there is exactly one fixed profile
 * for off, low, medium, and xhigh. Sampling-only profiles are deliberately
 * ignored so they can themselves act as adaptive router aliases.
 */
export function resolveThinkingProfileRoutes(
	profiles: readonly ModelProfile[] | undefined,
): ThinkingProfileRoutes | undefined {
	return analyzeThinkingProfileRoutes(profiles).routes;
}

export function routingLevelsFromProfiles(routes: ThinkingProfileRoutes): Record<ThinkingLevel, string> {
	return Object.fromEntries(THINKING_LEVELS.map((level) => [level, routes[level].slug])) as Record<ThinkingLevel, string>;
}

/** Validate an explicit adaptive alias and resolve every level to its preset. */
export function analyzeExplicitProfileRouting(
	value: unknown,
	profiles: readonly ModelProfile[] | undefined,
): ExplicitProfileRoutingAnalysis {
	const errors: string[] = [];
	if (!isRecord(value)) return { errors: ["Routing configuration must be an object."] };
	if (typeof value.enabled !== "boolean") errors.push("enabled must be true or false.");
	if (typeof value.aliasSlug !== "string") errors.push("Adaptive alias must be a string.");
	else {
		const slugError = validateProfileSlug(value.aliasSlug);
		if (slugError) errors.push(`Adaptive alias: ${slugError}`);
	}
	if (!isRecord(value.levels)) errors.push("Routing levels must be an object.");

	const validProfiles = (profiles ?? []).filter((profile) => validateModelProfile(profile) === null);
	const profilesBySlug = new Map<string, ModelProfile[]>();
	for (const profile of validProfiles) {
		const matching = profilesBySlug.get(profile.slug) ?? [];
		matching.push(profile);
		profilesBySlug.set(profile.slug, matching);
	}
	if (typeof value.aliasSlug === "string" && profilesBySlug.has(value.aliasSlug)) {
		errors.push(`Adaptive alias "${value.aliasSlug}" collides with a preset name.`);
	}

	const resolved = {} as ThinkingProfileRoutes;
	if (isRecord(value.levels)) {
		for (const key of Object.keys(value.levels)) {
			if (!(THINKING_LEVELS as readonly string[]).includes(key)) errors.push(`Unsupported Pi level: ${key}`);
		}
		for (const level of THINKING_LEVELS) {
			const slug = value.levels[level];
			if (typeof slug !== "string" || !slug) {
				errors.push(`Missing preset mapping for ${level}.`);
				continue;
			}
			const matching = profilesBySlug.get(slug) ?? [];
			if (matching.length === 0) errors.push(`${level} references missing preset "${slug}".`);
			else if (matching.length > 1) errors.push(`${level} references duplicate preset name "${slug}".`);
			else resolved[level] = matching[0];
		}
	}

	if (errors.length > 0) return { errors };
	return {
		errors,
		routing: value as unknown as ModelProfileRouting,
		routes: resolved,
	};
}

export interface LegacyProfileRoutingMigration {
	profiles: ModelProfile[];
	routing?: ModelProfileRouting;
	changed: boolean;
}

/** One-time conservative migration for the previously shipped implicit router. */
export function migrateLegacyProfileRouting(
	profiles: readonly ModelProfile[],
	existingRouting: unknown,
): LegacyProfileRoutingMigration {
	if (existingRouting !== undefined) return { profiles: [...profiles], changed: false };
	const routes = resolveThinkingProfileRoutes(profiles);
	if (!routes) return { profiles: [...profiles], changed: false };
	const adaptiveCandidates = profiles.filter(
		(profile) =>
			(profile.chatTemplateKwargs === undefined || Object.keys(profile.chatTemplateKwargs).length === 0) &&
			profile.sampling !== undefined,
	);
	if (adaptiveCandidates.length !== 1) return { profiles: [...profiles], changed: false };
	const adaptive = adaptiveCandidates[0];
	return {
		profiles: profiles.filter((profile) => profile !== adaptive),
		routing: {
			enabled: true,
			aliasSlug: adaptive.slug,
			levels: routingLevelsFromProfiles(routes),
		},
		changed: true,
	};
}

const PROFILE_CONTROLLED_WIRE_KEYS = [
	"enable_thinking",
	"reasoning_effort",
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"repetition_penalty",
	"repeat_penalty",
	"presence_penalty",
	"frequency_penalty",
] as const;

/** Replace every profile-controlled wire field with one routed profile. */
export function applyThinkingProfileRoute(
	payload: unknown,
	profile: ModelProfile,
	repetitionPenaltyKey: RepetitionPenaltyWireKey = "repetition_penalty",
): unknown {
	if (!isRecord(payload)) return payload;
	const next = { ...payload };
	for (const key of PROFILE_CONTROLLED_WIRE_KEYS) delete next[key];
	Object.assign(next, buildProfileSamplingParams(profile.sampling, repetitionPenaltyKey));
	const kwargs = profile.chatTemplateKwargs;
	if (kwargs && Object.keys(kwargs).length > 0) next.chat_template_kwargs = { ...kwargs };
	else delete next.chat_template_kwargs;
	return next;
}

export function describeChatTemplateKwargs(kwargs: ChatTemplateKwargs | undefined): string {
	const values: string[] = [];
	if (kwargs?.enable_thinking !== undefined) values.push(`thinking ${kwargs.enable_thinking ? "on" : "off"}`);
	if (kwargs?.reasoning_effort !== undefined) values.push(`effort ${kwargs.reasoning_effort}`);
	if (kwargs?.preserve_thinking !== undefined) values.push(`preserve ${kwargs.preserve_thinking ? "on" : "off"}`);
	return values.join(" · ");
}

export function describeProfileSampling(
	sampling: ProfileSampling | undefined,
	repetitionPenaltyKey: RepetitionPenaltyWireKey = "repetition_penalty",
): string {
	return Object.entries(buildProfileSamplingParams(sampling, repetitionPenaltyKey))
		.map(([key, value]) => `${key} ${value}`)
		.join(" · ");
}

function fixedThinkingLevelMap(
	kwargs: ChatTemplateKwargs,
	base: ProfileCapableModel,
): ThinkingLevelMap | undefined {
	const { enable_thinking, reasoning_effort } = kwargs;
	if (enable_thinking === false) return undefined;

	if (reasoning_effort !== undefined) {
		return {
			off: null,
			minimal: null,
			low: reasoning_effort === "low" ? "low" : null,
			medium: reasoning_effort === "medium" ? "medium" : null,
			high: null,
			xhigh: reasoning_effort === "xhigh" ? "xhigh" : null,
			max: null,
		};
	}

	// Pi has no generic on/off reasoning level. Lock an explicitly enabled profile
	// to one visible level so the UI cannot imply that a different effort is sent.
	if (enable_thinking === true) {
		return {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		};
	}

	return base.thinkingLevelMap;
}

/**
 * Add selectable alias models for valid profiles. The alias remains Pi's model
 * identity while samplingParams rewrites the OpenAI-compatible request to the
 * real server model and the profile's fixed thinking/sampling values.
 */
export function expandModelProfiles<T extends ProfileCapableModel>(
	baseModels: readonly T[],
	profilesByModel: Record<string, ModelProfile[]> | undefined,
	options: ProfileExpansionOptions = {},
): ProfileExpansion<T> {
	const models = baseModels.map((model) => ({ ...model })) as Array<T & ProfileCapableModel>;
	const warnings: string[] = [];
	const usedModelIds = new Set(baseModels.map((model) => model.id));
	const baseModelIds = new Set(usedModelIds);
	const repetitionPenaltyKey = options.repetitionPenaltyKey ?? "repetition_penalty";
	let profileCount = 0;

	for (const base of baseModels) {
		const rawProfiles: unknown = profilesByModel?.[base.id];
		if (rawProfiles === undefined) continue;
		if (!Array.isArray(rawProfiles)) {
			warnings.push(`Profiles for "${base.id}" are not an array and were skipped.`);
			continue;
		}

		for (const rawProfile of rawProfiles) {
			const error = validateModelProfile(rawProfile);
			if (error) {
				warnings.push(`Invalid profile for "${base.id}": ${error}`);
				continue;
			}
			const profile = rawProfile as ModelProfile;
			if (profile.exposeAsModel === false) continue;
			const aliasId = profileModelId(base.id, profile.slug);
			if (usedModelIds.has(aliasId)) {
				warnings.push(`Profile "${aliasId}" collides with another model and was skipped.`);
				continue;
			}

			const kwargs = profile.chatTemplateKwargs ?? {};
			const hasThinkingValues = Object.keys(kwargs).length > 0;
			const enabled = kwargs.enable_thinking;
			const effort = kwargs.reasoning_effort;
			const reasoning = hasThinkingValues
				? enabled === false
					? false
					: enabled === true || effort !== undefined
						? true
						: base.reasoning
				: base.reasoning;
			const profileModel = {
				...base,
				id: aliasId,
				name: `${base.name} (${profile.slug})`,
				reasoning,
				thinkingLevelMap: hasThinkingValues
					? reasoning
						? fixedThinkingLevelMap(kwargs, base)
						: undefined
					: base.thinkingLevelMap,
				compat: hasThinkingValues
					? {
							...base.compat,
							thinkingFormat: "chat-template",
							chatTemplateKwargs: {},
							supportsReasoningEffort: false,
						}
					: base.compat,
				samplingParams: {
					...base.samplingParams,
					model: base.id,
					...buildProfileSamplingParams(profile.sampling, repetitionPenaltyKey),
					...(hasThinkingValues ? { chat_template_kwargs: { ...kwargs } } : {}),
				},
			} as T & ProfileCapableModel;

			models.push(profileModel);
			usedModelIds.add(aliasId);
			profileCount++;
		}
	}

	for (const [modelId, rawProfiles] of Object.entries(profilesByModel ?? {})) {
		if (!baseModelIds.has(modelId) && Array.isArray(rawProfiles) && rawProfiles.length > 0) {
			warnings.push(`Profiles for missing model "${modelId}" were retained but not registered.`);
		}
	}

	return { models, profileCount, warnings };
}

export interface AdaptiveRouterExpansion<T extends ProfileCapableModel> {
	models: Array<T & ProfileCapableModel>;
	routerCount: number;
	warnings: string[];
	runtimeRoutes: Map<string, ThinkingProfileRoutes>;
}

/** Add only explicitly enabled adaptive aliases; base and preset aliases are untouched. */
export function expandAdaptiveProfileRouters<T extends ProfileCapableModel>(
	baseModels: readonly T[],
	profilesByModel: Record<string, ModelProfile[]> | undefined,
	routingByModel: Record<string, ModelProfileRouting> | undefined,
): AdaptiveRouterExpansion<T> {
	const models = baseModels.map((model) => ({ ...model })) as Array<T & ProfileCapableModel>;
	const warnings: string[] = [];
	const runtimeRoutes = new Map<string, ThinkingProfileRoutes>();
	const usedModelIds = new Set(baseModels.map((model) => model.id));
	let routerCount = 0;

	for (const base of baseModels) {
		const rawRouting: unknown = routingByModel?.[base.id];
		if (rawRouting === undefined) continue;
		const profiles = Array.isArray(profilesByModel?.[base.id]) ? profilesByModel?.[base.id] : [];
		const analysis = analyzeExplicitProfileRouting(rawRouting, profiles);
		if (analysis.errors.length > 0) {
			warnings.push(`Invalid adaptive routing for "${base.id}": ${analysis.errors.join(" ")}`);
			continue;
		}
		if (!analysis.routing?.enabled || !analysis.routes) continue;
		const aliasId = profileModelId(base.id, analysis.routing.aliasSlug);
		if (usedModelIds.has(aliasId)) {
			warnings.push(`Adaptive alias "${aliasId}" collides with another model and was skipped.`);
			continue;
		}
		models.push({
			...base,
			id: aliasId,
			name: `${base.name} (${analysis.routing.aliasSlug}; adaptive)`,
			reasoning: true,
			thinkingLevelMap: { ...QWEN_NATIVE_THINKING_LEVEL_MAP },
			samplingParams: { ...base.samplingParams, model: base.id },
		} as T & ProfileCapableModel);
		usedModelIds.add(aliasId);
		runtimeRoutes.set(aliasId, analysis.routes);
		routerCount++;
	}

	for (const modelId of Object.keys(routingByModel ?? {})) {
		if (!baseModels.some((model) => model.id === modelId)) {
			warnings.push(`Adaptive routing for missing model "${modelId}" was retained but not registered.`);
		}
	}
	return { models, routerCount, warnings, runtimeRoutes };
}

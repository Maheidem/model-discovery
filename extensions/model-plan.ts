/**
 * The effective settings of one model.
 *
 * Pure module. It joins four inputs: the setting of the user, the facts that
 * the server reports, the family file and the fixed defaults. The order is
 * always: user setting, then server, then family, then fixed default.
 * `registerProvider` and the panels read the same result, so the panel shows
 * what is registered.
 */

import {
	buildFamilyPresets,
	detectModelKind,
	familyCapabilities,
	levelKwargs,
	mapLevels,
	matchFamily,
	resolveThinkingProfile,
	type FamilyRegistry,
	type LevelControl,
	type LevelMap,
	type ModelFamily,
	type ModelKind,
	type ThinkingProfile,
} from "./families.ts";
import {
	buildLevelParams,
	THINKING_LEVELS,
	type LevelParamOptions,
	type ModelProfile,
	type ModelProfileRouting,
	type ModelThinkingPlan,
	type ThinkingLevel,
	type ThinkingProfileKind,
	type ThinkingTransport,
} from "./profiles.ts";
import type { ModelConfig } from "./providers.ts";

/** The part of `ModelOverride` and `DiscoveredProvider` that this module reads. */
export interface ModelPlanOverride {
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
	/** A family id, or `"none"`. Not set = find the family from the name. */
	family?: string;
	/** `false` = do not send the recommended sampling and efforts on the base model. */
	familyDefaults?: boolean;
	/** `true` = do not register the model. `false` = register a model that is not a chat model. */
	hidden?: boolean;
}

export interface ModelPlanSource {
	defaultContextWindow?: number;
	defaultMaxTokens?: number;
	modelOverrides?: Record<string, ModelPlanOverride>;
}

export type ValueSource = "your setting" | "server" | "family" | "source default" | "default";

export interface ResolvedModel {
	config: ModelConfig;
	kind: ModelKind;
	/** The model is not registered with pi. */
	hidden: boolean;
	family?: ModelFamily;
	familySource: "your setting" | "name" | "none";
	/** The thinking controls that the model accepts. Not set = no thinking control. */
	thinking?: ThinkingProfile;
	levelMap?: LevelMap;
	reasoning: boolean;
	reasoningSource: ValueSource;
	input: ("text" | "image")[];
	vision: boolean;
	visionSource: ValueSource;
	audio?: boolean;
	tools?: boolean;
	contextWindow: number;
	contextWindowSource: ValueSource;
	maxTokens: number;
	maxTokensSource: ValueSource;
	/** The recommended defaults are sent on the base model. */
	defaultsOn: boolean;
	/** The bundled presets and routing of the model. Not set when the model has no thinking control. */
	defaults?: { presets: ModelProfile[]; routing: ModelProfileRouting; levelSlugs: Record<ThinkingLevel, string> };
	/** The pi `thinkingLevelMap` of the base model. */
	baseThinkingLevelMap?: ModelThinkingPlan["thinkingLevelMap"];
	/** The request fields of the base model at each pi level. */
	baseLevelParams?: Record<ThinkingLevel, Record<string, unknown>>;
	/** The plan that the preset aliases of this model use. */
	plan?: ModelThinkingPlan;
	/** The preset kind that each pi level needs (for the conventional routing). */
	levelKinds?: Record<ThinkingLevel, ThinkingProfileKind>;
}

export const FALLBACK_CONTEXT_WINDOW = 128_000;
export const FALLBACK_MAX_TOKENS = 16_384;

export function thinkingTransportForServer(registry: FamilyRegistry, serverType: string): ThinkingTransport {
	return registry.index.servers?.[serverType]?.thinking ?? "chat-template";
}

/** The preset kind of a level control: "off", "on", or the effort name. */
export function controlKind(control: LevelControl): ThinkingProfileKind {
	if (control.enableThinking === false) return "off";
	return control.effort ?? "on";
}

function perLevel<T>(build: (level: ThinkingLevel) => T): Record<ThinkingLevel, T> {
	return Object.fromEntries(THINKING_LEVELS.map((level) => [level, build(level)])) as Record<ThinkingLevel, T>;
}

export function resolveModel(
	source: ModelPlanSource,
	config: ModelConfig,
	registry: FamilyRegistry,
	serverType: string,
	options: Pick<LevelParamOptions, "repetitionPenaltyKey"> = {},
): ResolvedModel {
	const override = source.modelOverrides?.[config.id] ?? {};
	const kind = detectModelKind(config.id, config.name, config.modelType ?? undefined);
	const hidden = override.hidden ?? kind !== "chat";

	const family = kind === "chat" ? matchFamily(registry, config.id, config.name, override.family) : undefined;
	const familySource: ResolvedModel["familySource"] = !family
		? "none"
		: override.family === family.id
			? "your setting"
			: "name";
	const capabilities = family ? familyCapabilities(family, config.id, config.name) : {};

	const thinking = kind === "chat" ? resolveThinkingProfile(config.thinking ?? undefined, family) : undefined;
	const levelMap = thinking ? mapLevels(thinking) : undefined;

	let reasoning: boolean;
	let reasoningSource: ValueSource;
	if (override.reasoning !== undefined) [reasoning, reasoningSource] = [override.reasoning, "your setting"];
	else if (thinking && thinking.source !== "family") [reasoning, reasoningSource] = [true, "server"];
	else if (config.reasoning !== null) [reasoning, reasoningSource] = [config.reasoning, "server"];
	else if (thinking) [reasoning, reasoningSource] = [true, "family"];
	else [reasoning, reasoningSource] = [false, "default"];

	let vision: boolean;
	let visionSource: ValueSource;
	if (override.input !== undefined) [vision, visionSource] = [override.input.includes("image"), "your setting"];
	else if (config.vision !== null) [vision, visionSource] = [config.vision, "server"];
	else if (capabilities.image !== undefined) [vision, visionSource] = [capabilities.image, "family"];
	else [vision, visionSource] = [false, "default"];

	let contextWindow: number;
	let contextWindowSource: ValueSource;
	if (override.contextWindow !== undefined) [contextWindow, contextWindowSource] = [override.contextWindow, "your setting"];
	else if (config.contextWindow !== null) [contextWindow, contextWindowSource] = [config.contextWindow, "server"];
	else if (source.defaultContextWindow !== undefined) [contextWindow, contextWindowSource] = [source.defaultContextWindow, "source default"];
	else if (capabilities.contextWindow !== undefined) [contextWindow, contextWindowSource] = [capabilities.contextWindow, "family"];
	else [contextWindow, contextWindowSource] = [FALLBACK_CONTEXT_WINDOW, "default"];

	let maxTokens: number;
	let maxTokensSource: ValueSource;
	if (override.maxTokens !== undefined) [maxTokens, maxTokensSource] = [override.maxTokens, "your setting"];
	else if (config.maxTokens !== null) [maxTokens, maxTokensSource] = [config.maxTokens, "server"];
	else if (source.defaultMaxTokens !== undefined) [maxTokens, maxTokensSource] = [source.defaultMaxTokens, "source default"];
	else [maxTokens, maxTokensSource] = [FALLBACK_MAX_TOKENS, "default"];

	const resolved: ResolvedModel = {
		config,
		kind,
		hidden,
		family,
		familySource,
		thinking,
		levelMap,
		reasoning,
		reasoningSource,
		input: vision ? ["text", "image"] : ["text"],
		vision,
		visionSource,
		audio: capabilities.audio,
		tools: capabilities.tools,
		contextWindow,
		contextWindowSource,
		maxTokens,
		maxTokensSource,
		defaultsOn: override.familyDefaults !== false,
	};
	if (!thinking || !levelMap) return resolved;

	const levelOptions: LevelParamOptions = {
		repetitionPenaltyKey: options.repetitionPenaltyKey,
		thinkingTransport: thinkingTransportForServer(registry, serverType),
	};
	const defaults = buildFamilyPresets(family, thinking, config.id, config.name);
	resolved.defaults = defaults;
	resolved.levelKinds = perLevel((level) => controlKind(levelMap.controls[level]));

	if (resolved.defaultsOn) {
		// The base model sends the bundled preset of each level: thinking values and sampling.
		const bySlug = new Map(defaults.presets.map((preset) => [preset.slug, preset]));
		resolved.baseThinkingLevelMap = levelMap.thinkingLevelMap;
		resolved.baseLevelParams = perLevel((level) =>
			buildLevelParams(bySlug.get(defaults.levelSlugs[level]) ?? {}, thinking, levelOptions),
		);
		resolved.plan = {
			controls: thinking,
			thinkingLevelMap: levelMap.thinkingLevelMap,
			levelParams: perLevel((level) =>
				buildLevelParams(
					{ chatTemplateKwargs: levelKwargs(levelMap.controls[level], thinking) },
					thinking,
					levelOptions,
				),
			),
		};
		return resolved;
	}

	// Recommended defaults off: the base model sends the on/off switch only, with
	// no effort and no sampling. This is the behaviour of 0.10.0 for each family.
	// The preset aliases still use the full controls of the model.
	const switchOnly: ThinkingProfile | undefined = thinking.toggle ? { ...thinking, efforts: [] } : undefined;
	const switchMap = switchOnly ? mapLevels(switchOnly) : undefined;
	const switchParams =
		switchOnly && switchMap
			? perLevel((level) =>
					buildLevelParams(
						{ chatTemplateKwargs: levelKwargs(switchMap.controls[level], switchOnly) },
						switchOnly,
						levelOptions,
					),
				)
			: perLevel(() => ({}));
	resolved.baseThinkingLevelMap = switchMap?.thinkingLevelMap;
	resolved.baseLevelParams = switchOnly ? switchParams : undefined;
	resolved.plan = {
		controls: thinking,
		thinkingLevelMap: switchMap?.thinkingLevelMap ?? levelMap.thinkingLevelMap,
		levelParams: switchParams,
	};
	return resolved;
}

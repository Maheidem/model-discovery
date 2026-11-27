/**
 * Model families: pure logic, no I/O and no pi API.
 *
 * A family file (`families/*.json`) holds the facts that a server does not
 * always report: the thinking controls of the chat template, the sampling
 * values and the fallback capabilities. `family-store.ts` reads the files.
 * This module validates them, matches a model to a family and makes the
 * thinking profile, the level map and the bundled presets.
 *
 * `docs/model-families.md` gives the source of each value.
 */

import {
	THINKING_LEVELS,
	validateProfileSampling,
	validateProfileSlug,
	type ModelProfile,
	type ModelProfileRouting,
	type ProfileSampling,
	type ThinkingLevel,
} from "./profiles.ts";

/** All effort names that a template can read, from the lowest to the highest. */
export const EFFORT_SCALE = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const FAMILY_SCHEMA_VERSION = 1;

export type ModelKind = "chat" | "embedding" | "speech-to-text" | "text-to-speech" | "reranker" | "other";

export interface FamilyCapabilities {
	image?: boolean;
	audio?: boolean;
	tools?: boolean;
	/** Fallback only. The server value wins. */
	contextWindow?: number;
}

export interface FamilyThinking {
	/** The template reads `enable_thinking`. */
	toggle: boolean;
	/** The effort names that the template reads from `reasoning_effort`. */
	efforts: string[];
	/** The template reads `preserve_thinking`. */
	readsPreserve: boolean;
	/** Send `preserve_thinking: true` when the template reads it. */
	sendPreserve: boolean;
	/** Thinking is on when the request sends no control. */
	defaultOn: boolean;
}

export interface FamilySampling {
	off?: ProfileSampling;
	on?: ProfileSampling;
}

export interface FamilyVariant {
	match: string[];
	capabilities?: FamilyCapabilities;
	sampling?: FamilySampling;
}

export interface FamilyExtraPreset {
	slug: string;
	thinking: "on" | "off";
	sampling: ProfileSampling;
}

export interface ModelFamily {
	id: string;
	label: string;
	sources: string[];
	/** Regex strings. Each one is tested without case against the model id and the model name. */
	match: string[];
	capabilities: FamilyCapabilities;
	variants?: FamilyVariant[];
	thinking?: FamilyThinking;
	sampling: FamilySampling;
	extraPresets?: FamilyExtraPreset[];
	notes?: Record<string, string>;
}

export interface FamilyIndex {
	schemaVersion: number;
	/** An integer that goes up with each data change. */
	revision: number;
	updated: string;
	/** The family files, in match order. The first family that matches wins. */
	files: string[];
	servers?: Record<string, { thinking: "top-level" | "chat-template" }>;
}

export interface FamilyRegistry {
	index: FamilyIndex;
	families: ModelFamily[];
	layer: "bundled" | "cache";
	fetchedAt?: number;
	rejected: { file: string; error: string }[];
}

/** A family file name has no path part. */
export const FAMILY_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*\.json$/;
const MAX_PATTERN_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function unknownKey(value: Record<string, unknown>, allowed: readonly string[], where: string): string | null {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) return `${where}: unknown key "${key}".`;
	}
	return null;
}

function validateStringList(value: unknown, where: string, allowEmpty: boolean): string | null {
	if (!Array.isArray(value)) return `${where} must be an array of strings.`;
	if (!allowEmpty && value.length === 0) return `${where} must not be empty.`;
	for (const item of value) {
		if (!isNonEmptyString(item)) return `${where} must contain only non-empty strings.`;
	}
	return null;
}

function validatePatterns(value: unknown, where: string): string | null {
	const listError = validateStringList(value, where, false);
	if (listError) return listError;
	for (const pattern of value as string[]) {
		if (pattern.length > MAX_PATTERN_LENGTH) return `${where}: a pattern is longer than ${MAX_PATTERN_LENGTH} characters.`;
		try {
			new RegExp(pattern, "i");
		} catch {
			return `${where}: the pattern "${pattern}" does not compile.`;
		}
	}
	return null;
}

function validateCapabilities(value: unknown, where: string): string | null {
	if (!isRecord(value)) return `${where} must be an object.`;
	const keyError = unknownKey(value, ["image", "audio", "tools", "contextWindow"], where);
	if (keyError) return keyError;
	for (const key of ["image", "audio", "tools"]) {
		if (value[key] !== undefined && typeof value[key] !== "boolean") return `${where}.${key} must be true or false.`;
	}
	const context = value.contextWindow;
	if (context !== undefined && !(typeof context === "number" && Number.isInteger(context) && context > 0)) {
		return `${where}.contextWindow must be a positive integer.`;
	}
	return null;
}

function validateSamplingSets(value: unknown, where: string): string | null {
	if (!isRecord(value)) return `${where} must be an object.`;
	const keyError = unknownKey(value, ["off", "on"], where);
	if (keyError) return keyError;
	for (const key of ["off", "on"]) {
		if (value[key] === undefined) continue;
		const error = validateProfileSampling(value[key]);
		if (error) return `${where}.${key}: ${error}`;
	}
	return null;
}

function validateThinking(value: unknown): string | null {
	if (!isRecord(value)) return "thinking must be an object.";
	const keyError = unknownKey(value, ["toggle", "efforts", "readsPreserve", "sendPreserve", "defaultOn"], "thinking");
	if (keyError) return keyError;
	for (const key of ["toggle", "readsPreserve", "sendPreserve", "defaultOn"]) {
		if (typeof value[key] !== "boolean") return `thinking.${key} must be true or false.`;
	}
	if (!Array.isArray(value.efforts)) return "thinking.efforts must be an array.";
	for (const effort of value.efforts) {
		if (!(EFFORT_SCALE as readonly unknown[]).includes(effort)) {
			return `thinking.efforts: "${String(effort)}" is not one of ${EFFORT_SCALE.join(", ")}.`;
		}
	}
	if (new Set(value.efforts).size !== value.efforts.length) return "thinking.efforts must not repeat a name.";
	return null;
}

export function validateFamilyIndex(value: unknown): string | null {
	if (!isRecord(value)) return "The index must be an object.";
	const keyError = unknownKey(value, ["schemaVersion", "revision", "updated", "files", "servers"], "index");
	if (keyError) return keyError;
	if (value.schemaVersion !== FAMILY_SCHEMA_VERSION) {
		return `Unknown schemaVersion ${JSON.stringify(value.schemaVersion)}. This version reads schemaVersion ${FAMILY_SCHEMA_VERSION}.`;
	}
	if (!(typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision > 0)) {
		return "revision must be a positive integer.";
	}
	if (typeof value.updated !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.updated)) {
		return "updated must be a date in the form YYYY-MM-DD.";
	}
	const filesError = validateStringList(value.files, "files", false);
	if (filesError) return filesError;
	const files = value.files as string[];
	for (const file of files) {
		if (!FAMILY_FILE_NAME_PATTERN.test(file) || file === "index.json") return `files: "${file}" is not a permitted file name.`;
	}
	if (new Set(files).size !== files.length) return "files must not repeat a name.";
	if (value.servers !== undefined) {
		if (!isRecord(value.servers)) return "servers must be an object.";
		for (const [server, entry] of Object.entries(value.servers)) {
			if (!isRecord(entry)) return `servers.${server} must be an object.`;
			const serverKeyError = unknownKey(entry, ["thinking"], `servers.${server}`);
			if (serverKeyError) return serverKeyError;
			if (entry.thinking !== "top-level" && entry.thinking !== "chat-template") {
				return `servers.${server}.thinking must be "top-level" or "chat-template".`;
			}
		}
	}
	return null;
}

const FAMILY_KEYS = [
	"id",
	"label",
	"sources",
	"match",
	"capabilities",
	"variants",
	"thinking",
	"sampling",
	"extraPresets",
	"notes",
];

export function validateFamily(value: unknown): string | null {
	if (!isRecord(value)) return "The family must be an object.";
	const keyError = unknownKey(value, FAMILY_KEYS, "family");
	if (keyError) return keyError;
	if (!isNonEmptyString(value.id)) return "id must be a non-empty string.";
	if (value.id === "none") return 'id must not be "none".';
	if (!isNonEmptyString(value.label)) return "label must be a non-empty string.";
	const sourcesError = validateStringList(value.sources, "sources", true);
	if (sourcesError) return sourcesError;
	const matchError = validatePatterns(value.match, "match");
	if (matchError) return matchError;
	const capabilitiesError = validateCapabilities(value.capabilities, "capabilities");
	if (capabilitiesError) return capabilitiesError;

	if (value.variants !== undefined) {
		if (!Array.isArray(value.variants)) return "variants must be an array.";
		for (const [index, variant] of value.variants.entries()) {
			const where = `variants[${index}]`;
			if (!isRecord(variant)) return `${where} must be an object.`;
			const variantKeyError = unknownKey(variant, ["match", "capabilities", "sampling"], where);
			if (variantKeyError) return variantKeyError;
			const variantMatchError = validatePatterns(variant.match, `${where}.match`);
			if (variantMatchError) return variantMatchError;
			if (variant.capabilities !== undefined) {
				const error = validateCapabilities(variant.capabilities, `${where}.capabilities`);
				if (error) return error;
			}
			if (variant.sampling !== undefined) {
				const error = validateSamplingSets(variant.sampling, `${where}.sampling`);
				if (error) return error;
			}
		}
	}

	if (value.thinking !== undefined) {
		const error = validateThinking(value.thinking);
		if (error) return error;
	}
	const samplingError = validateSamplingSets(value.sampling, "sampling");
	if (samplingError) return samplingError;

	if (value.extraPresets !== undefined) {
		if (!Array.isArray(value.extraPresets)) return "extraPresets must be an array.";
		const slugs = new Set<string>();
		for (const [index, preset] of value.extraPresets.entries()) {
			const where = `extraPresets[${index}]`;
			if (!isRecord(preset)) return `${where} must be an object.`;
			const presetKeyError = unknownKey(preset, ["slug", "thinking", "sampling"], where);
			if (presetKeyError) return presetKeyError;
			if (typeof preset.slug !== "string") return `${where}.slug must be a string.`;
			const slugError = validateProfileSlug(preset.slug);
			if (slugError) return `${where}.slug: ${slugError}`;
			if (slugs.has(preset.slug)) return `${where}.slug: "${preset.slug}" is used two times.`;
			slugs.add(preset.slug);
			if (preset.thinking !== "on" && preset.thinking !== "off") return `${where}.thinking must be "on" or "off".`;
			const error = validateProfileSampling(preset.sampling);
			if (error) return `${where}.sampling: ${error}`;
		}
	}

	if (value.notes !== undefined) {
		if (!isRecord(value.notes)) return "notes must be an object.";
		for (const [key, note] of Object.entries(value.notes)) {
			if (typeof note !== "string") return `notes.${key} must be a string.`;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Family match
// ---------------------------------------------------------------------------

function matchesAny(patterns: readonly string[], id: string, name?: string): boolean {
	for (const pattern of patterns) {
		let regex: RegExp;
		try {
			regex = new RegExp(pattern, "i");
		} catch {
			continue;
		}
		if (regex.test(id) || (name !== undefined && regex.test(name))) return true;
	}
	return false;
}

/**
 * Find the family of a model. The families are tested in registry order and the
 * first match wins. `forcedFamilyId` is the user override: `"none"` forces no
 * family, a known id forces that family, and an unknown id is ignored.
 */
export function matchFamily(
	registry: FamilyRegistry | readonly ModelFamily[],
	id: string,
	name?: string,
	forcedFamilyId?: string,
): ModelFamily | undefined {
	const families: readonly ModelFamily[] = Array.isArray(registry)
		? (registry as readonly ModelFamily[])
		: (registry as FamilyRegistry).families;
	if (forcedFamilyId === "none") return undefined;
	if (forcedFamilyId) {
		const forced = families.find((family) => family.id === forcedFamilyId);
		if (forced) return forced;
	}
	return families.find((family) => matchesAny(family.match, id, name));
}

/** The base capabilities merged with each variant that matches the model. */
export function familyCapabilities(family: ModelFamily, id: string, name?: string): FamilyCapabilities {
	let capabilities: FamilyCapabilities = { ...family.capabilities };
	for (const variant of family.variants ?? []) {
		if (variant.capabilities && matchesAny(variant.match, id, name)) {
			capabilities = { ...capabilities, ...variant.capabilities };
		}
	}
	return capabilities;
}

/** The base sampling sets merged with each variant that matches the model. */
export function familySampling(family: ModelFamily, id: string, name?: string): FamilySampling {
	let off: ProfileSampling = { ...family.sampling.off };
	let on: ProfileSampling = { ...family.sampling.on };
	for (const variant of family.variants ?? []) {
		if (variant.sampling && matchesAny(variant.match, id, name)) {
			off = { ...off, ...variant.sampling.off };
			on = { ...on, ...variant.sampling.on };
		}
	}
	const result: FamilySampling = {};
	if (Object.keys(off).length > 0) result.off = off;
	if (Object.keys(on).length > 0) result.on = on;
	return result;
}

// ---------------------------------------------------------------------------
// Model kind
// ---------------------------------------------------------------------------

const SPEECH_TO_TEXT_NAME = /(^|[^a-z])(asr|stt)([^a-z]|$)|whisper|aligner/i;
const TEXT_TO_SPEECH_NAME = /(^|[^a-z])tts([^a-z]|$)/i;

/**
 * Find what a model does. The server value (oMLX `model_type` or
 * `engine_type`) decides when it is given. With no server value, the model id
 * and the model name decide.
 */
export function detectModelKind(id: string, name?: string, serverModelType?: string): ModelKind {
	const serverType = (serverModelType ?? "").trim().toLowerCase();
	if (serverType) {
		if (serverType === "llm" || serverType === "vlm") return "chat";
		if (serverType === "audio_stt" || serverType === "stt") return "speech-to-text";
		if (serverType === "audio_tts" || serverType === "tts") return "text-to-speech";
		if (serverType === "embedding") return "embedding";
		if (serverType === "reranker") return "reranker";
		return "other";
	}
	const texts = name !== undefined ? [id, name] : [id];
	const some = (regex: RegExp): boolean => texts.some((text) => regex.test(text));
	if (some(SPEECH_TO_TEXT_NAME)) return "speech-to-text";
	if (some(TEXT_TO_SPEECH_NAME)) return "text-to-speech";
	if (some(/embed/i)) return "embedding";
	if (some(/rerank/i)) return "reranker";
	return "chat";
}

// ---------------------------------------------------------------------------
// Thinking profile
// ---------------------------------------------------------------------------

export interface ThinkingProfile {
	/** The template reads `enable_thinking`. */
	toggle: boolean;
	/** The effort names that the template reads, in scale order. */
	efforts: string[];
	/** Send `preserve_thinking: true`. */
	preserveThinking: boolean;
	defaultOn: boolean;
	source: "server" | "template" | "family";
}

export interface ServerThinkingReport {
	thinkingDefault?: boolean | null;
	preserveThinkingDefault?: boolean | null;
	reasoningEfforts?: string[] | null;
	chatTemplate?: string;
}

/** The efforts to use when a template reads `reasoning_effort` but names no standard level. */
const UNNAMED_EFFORTS = ["low", "medium", "high"];

function inScaleOrder(efforts: readonly unknown[]): string[] {
	return EFFORT_SCALE.filter((effort) => efforts.includes(effort));
}

/** Read the thinking controls from the text of a chat template. */
export function parseTemplateThinking(template: string): {
	toggle: boolean;
	readsPreserve: boolean;
	efforts: string[] | null;
} {
	const toggle = template.includes("enable_thinking");
	const readsPreserve = template.includes("preserve_thinking");
	if (!template.includes("reasoning_effort")) return { toggle, readsPreserve, efforts: null };
	const found = new Set<string>();
	for (const statement of template.matchAll(/\{%([\s\S]*?)%\}/g)) {
		const body = statement[1];
		if (!body.includes("effort")) continue;
		for (const quoted of body.matchAll(/(['"])([a-z]+)\1/g)) found.add(quoted[2]);
	}
	return { toggle, readsPreserve, efforts: inScaleOrder([...found]) };
}

function profileFromFacts(
	facts: { toggle: boolean; efforts: readonly string[] | null; readsPreserve: boolean; sendWhenNoFamily: boolean },
	defaultOn: boolean,
	family: ModelFamily | undefined,
	source: "server" | "template",
): ThinkingProfile | undefined {
	let efforts: string[];
	if (facts.efforts === null) efforts = [];
	else if (facts.efforts.length > 0) efforts = inScaleOrder(facts.efforts);
	else efforts = family?.thinking?.efforts.length ? inScaleOrder(family.thinking.efforts) : [...UNNAMED_EFFORTS];
	if (!facts.toggle && efforts.length === 0) return undefined;
	const send = family?.thinking ? family.thinking.sendPreserve : facts.sendWhenNoFamily;
	return { toggle: facts.toggle, efforts, preserveThinking: facts.readsPreserve && send, defaultOn, source };
}

/**
 * Make the thinking profile of a model. The server report wins, then the chat
 * template text, then the family. The result is `undefined` when the model has
 * no thinking control.
 */
export function resolveThinkingProfile(
	report: ServerThinkingReport | undefined,
	family: ModelFamily | undefined,
): ThinkingProfile | undefined {
	const hasStatus =
		report !== undefined &&
		(report.thinkingDefault !== undefined ||
			report.preserveThinkingDefault !== undefined ||
			report.reasoningEfforts !== undefined);
	if (report && hasStatus) {
		// A list with only unknown names gives the same result as an empty list.
		const efforts = Array.isArray(report.reasoningEfforts) ? inScaleOrder(report.reasoningEfforts) : null;
		return profileFromFacts(
			{
				toggle: typeof report.thinkingDefault === "boolean",
				efforts,
				readsPreserve: typeof report.preserveThinkingDefault === "boolean",
				sendWhenNoFamily: report.preserveThinkingDefault === true,
			},
			report.thinkingDefault ?? family?.thinking?.defaultOn ?? true,
			family,
			"server",
		);
	}
	if (report?.chatTemplate) {
		const parsed = parseTemplateThinking(report.chatTemplate);
		return profileFromFacts(
			{ ...parsed, sendWhenNoFamily: parsed.readsPreserve },
			family?.thinking?.defaultOn ?? true,
			family,
			"template",
		);
	}
	if (family?.thinking) {
		const thinking = family.thinking;
		if (!thinking.toggle && thinking.efforts.length === 0) return undefined;
		return {
			toggle: thinking.toggle,
			efforts: inScaleOrder(thinking.efforts),
			preserveThinking: thinking.readsPreserve && thinking.sendPreserve,
			defaultOn: thinking.defaultOn,
			source: "family",
		};
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Level map
// ---------------------------------------------------------------------------

export interface LevelControl {
	enableThinking?: boolean;
	effort?: string;
}

export interface LevelMap {
	/** The control that each pi level sends. */
	controls: Record<ThinkingLevel, LevelControl>;
	/** The pi `thinkingLevelMap` of the model. A string makes pi offer the level. `null` hides it. */
	thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>>;
	/** The pi levels that the model offers. */
	offered: ThinkingLevel[];
}

/** The effort nearest to `target` on EFFORT_SCALE. A tie goes to the higher effort. */
export function nearestEffort(target: string, efforts: readonly string[]): string | undefined {
	const scale: readonly string[] = EFFORT_SCALE;
	const targetIndex = scale.indexOf(target);
	if (targetIndex < 0) return undefined;
	let best: string | undefined;
	let bestDistance = Infinity;
	let bestIndex = -1;
	for (const effort of efforts) {
		const index = scale.indexOf(effort);
		if (index < 0) continue;
		const distance = Math.abs(index - targetIndex);
		if (distance < bestDistance || (distance === bestDistance && index > bestIndex)) {
			best = effort;
			bestDistance = distance;
			bestIndex = index;
		}
	}
	return best;
}

/** Map the seven pi thinking levels to the controls of a thinking profile. */
export function mapLevels(profile: ThinkingProfile): LevelMap {
	const controls = {} as Record<ThinkingLevel, LevelControl>;
	const thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>> = {};
	const efforts = inScaleOrder(profile.efforts);

	if (efforts.length > 0) {
		for (const level of THINKING_LEVELS) {
			if (level === "off") {
				controls.off = profile.toggle ? { enableThinking: false } : { effort: efforts[0] };
				continue;
			}
			const effort = nearestEffort(level, efforts) as string;
			controls[level] = profile.toggle ? { enableThinking: true, effort } : { effort };
			thinkingLevelMap[level] = effort;
		}
		return { controls, thinkingLevelMap, offered: [...THINKING_LEVELS] };
	}

	for (const level of THINKING_LEVELS) {
		if (level === "off") {
			controls.off = { enableThinking: false };
			continue;
		}
		controls[level] = { enableThinking: true };
		thinkingLevelMap[level] = level === "high" ? "high" : null;
	}
	return { controls, thinkingLevelMap, offered: ["off", "high"] };
}

// ---------------------------------------------------------------------------
// Bundled presets and routing
// ---------------------------------------------------------------------------

/** The `chat_template_kwargs` that a control sends. */
export function levelKwargs(control: LevelControl, profile: ThinkingProfile): Record<string, unknown> {
	const kwargs: Record<string, unknown> = {};
	if (profile.toggle) kwargs.enable_thinking = control.enableThinking ?? true;
	if (control.effort !== undefined) kwargs.reasoning_effort = control.effort;
	if (profile.preserveThinking) kwargs.preserve_thinking = true;
	return kwargs;
}

/** The preset name of a control. */
export function controlSlug(control: LevelControl): string {
	if (control.enableThinking === false) return "instruct";
	if (control.effort !== undefined) return `thinking-${control.effort}`;
	return "thinking";
}

function makePreset(slug: string, kwargs: Record<string, unknown>, sampling: ProfileSampling | undefined): ModelProfile {
	const preset: ModelProfile = { slug };
	if (Object.keys(kwargs).length > 0) preset.chatTemplateKwargs = kwargs as ModelProfile["chatTemplateKwargs"];
	if (sampling && Object.keys(sampling).length > 0) preset.sampling = { ...sampling };
	preset.exposeAsModel = false;
	return preset;
}

/**
 * Make the bundled presets and the adaptive routing of a model. There is one
 * preset for each different control of the level map, then one preset for each
 * extra preset of the family.
 */
export function buildFamilyPresets(
	family: ModelFamily | undefined,
	profile: ThinkingProfile,
	id: string,
	name?: string,
): { presets: ModelProfile[]; routing: ModelProfileRouting; levelSlugs: Record<ThinkingLevel, string> } {
	const { controls } = mapLevels(profile);
	const sampling = family ? familySampling(family, id, name) : {};
	const levelSlugs = {} as Record<ThinkingLevel, string>;
	const bySlug = new Map<string, LevelControl>();
	for (const level of THINKING_LEVELS) {
		const slug = controlSlug(controls[level]);
		levelSlugs[level] = slug;
		if (!bySlug.has(slug)) bySlug.set(slug, controls[level]);
	}

	// Order: instruct, then the efforts in scale order, then plain thinking.
	const rank = (control: LevelControl): number => {
		if (control.enableThinking === false) return -1;
		if (control.effort === undefined) return EFFORT_SCALE.length;
		return (EFFORT_SCALE as readonly string[]).indexOf(control.effort);
	};
	const presets = [...bySlug.entries()]
		.sort((a, b) => rank(a[1]) - rank(b[1]))
		.map(([slug, control]) =>
			makePreset(slug, levelKwargs(control, profile), control.enableThinking === false ? sampling.off : sampling.on),
		);

	for (const extra of family?.extraPresets ?? []) {
		if (bySlug.has(extra.slug)) continue;
		const control = extra.thinking === "on" ? controls.high : controls.off;
		presets.push(makePreset(extra.slug, levelKwargs(control, profile), extra.sampling));
	}

	return { presets, routing: { enabled: true, aliasSlug: "adaptive", levels: levelSlugs }, levelSlugs };
}

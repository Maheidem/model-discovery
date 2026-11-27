/**
 * Tests for the pure family logic (families.ts) with the bundled family files.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	EFFORT_SCALE,
	buildFamilyPresets,
	controlSlug,
	detectModelKind,
	familyCapabilities,
	familySampling,
	levelKwargs,
	mapLevels,
	matchFamily,
	nearestEffort,
	parseTemplateThinking,
	resolveThinkingProfile,
	validateFamily,
	validateFamilyIndex,
	type ModelFamily,
	type ModelKind,
	type ThinkingProfile,
} from "../extensions/families.ts";
import { loadBundledFamilies } from "../extensions/family-store.ts";

const registry = loadBundledFamilies();

function family(id: string): ModelFamily {
	const found = registry.families.find((entry) => entry.id === id);
	assert.ok(found, `the bundled family ${id} exists`);
	return found;
}

// ---------------------------------------------------------------------------
// Match and kind
// ---------------------------------------------------------------------------

/** Model id, expected kind from the name only, expected family id. */
const MODELS: [string, ModelKind, string | undefined][] = [
	// llama-swap ids
	["embed-gemma2", "embedding", undefined],
	["embeddinggemma-2", "embedding", undefined],
	["gemma4-12b", "chat", "gemma4"],
	["gemma4-26b", "chat", "gemma4"],
	["gemma4-31b", "chat", "gemma4"],
	["gemma4-e2b", "chat", "gemma4"],
	["gemma4-e4b", "chat", "gemma4"],
	["llamacpp", "chat", undefined],
	["qwen3-asr-1.7b", "speech-to-text", undefined],
	["qwen3-tts-1.7b-customvoice", "text-to-speech", undefined],
	["qwen3.5-0.8b", "chat", "qwen3.5-small"],
	["qwen3.5-2b", "chat", "qwen3.5-small"],
	["qwen3.5-4b", "chat", "qwen3.5"],
	["qwen3.5-9b", "chat", "qwen3.5"],
	["qwen3.6-35b", "chat", "qwen3.6"],
	["qwen3.8-27b", "chat", "qwen3.8"],
	["stt-qwen3-asr", "speech-to-text", undefined],
	["vllm-omni-tts", "text-to-speech", undefined],
	// oMLX ids
	["Qwen3.8-27B", "chat", "qwen3.8"],
	["qwen3.8-flash", "chat", "qwen3.8"],
	["gemma-4-e4b", "chat", "gemma4"],
	["Inkling-2-Mini", "chat", "inkling2-mini"],
	["Qwen3-ASR", "speech-to-text", undefined],
	["Qwen3-Reranker", "reranker", undefined],
	["MarkItDown", "chat", undefined],
	["clef-flash", "chat", undefined],
	// Other names
	["Inkling-2-Small", "chat", "inkling2-small"],
	["Inkling", "chat", "inkling"],
	["Qwen3-8B", "chat", "qwen3"],
	["Qwen3.5-9B-MLX-4bit", "chat", "qwen3.5"],
	["Qwen3.6-35B-A3B-oQ4e-mtp", "chat", "qwen3.6"],
	["Huihui-Qwen3.8-27B-abliterated-mlx-4Bit", "chat", "qwen3.8"],
	["Qwen3.8-Flash-Next-UD-Q4_K_XL", "chat", "qwen3.8"],
	["Qwen3-ForcedAligner", "speech-to-text", undefined],
	["qwen-max", "chat", undefined],
	["Qwen2.5-7B", "chat", undefined],
];

test("each known model id gets the correct kind and family", () => {
	for (const [id, kind, familyId] of MODELS) {
		assert.equal(detectModelKind(id), kind, `kind of ${id}`);
		assert.equal(matchFamily(registry, id)?.id, familyId, `family of ${id}`);
	}
});

test("the model name is tested when the id does not match", () => {
	assert.equal(matchFamily(registry, "model-a", "Qwen3.8 27B")?.id, "qwen3.8");
	assert.equal(matchFamily(registry.families, "model-a", "Some Model"), undefined);
	assert.equal(detectModelKind("model-a", "Whisper Large"), "speech-to-text");
});

test("the server model type decides the kind before the name", () => {
	const cases: [string, ModelKind][] = [
		["llm", "chat"],
		["vlm", "chat"],
		["audio_stt", "speech-to-text"],
		["audio_tts", "text-to-speech"],
		["tts", "text-to-speech"],
		["embedding", "embedding"],
		["reranker", "reranker"],
		["markitdown", "other"],
		["decision", "other"],
	];
	for (const [serverType, kind] of cases) {
		assert.equal(detectModelKind("Qwen3-ASR", undefined, serverType), kind, serverType);
	}
	assert.equal(detectModelKind("Qwen3-ASR", undefined, ""), "speech-to-text");
});

test("a forced family id replaces the pattern match", () => {
	assert.equal(matchFamily(registry, "Qwen3.8-27B", undefined, "none"), undefined);
	assert.equal(matchFamily(registry, "my-model", undefined, "gemma4")?.id, "gemma4");
	assert.equal(matchFamily(registry, "Qwen3.8-27B", undefined, "not-a-family")?.id, "qwen3.8");
});

test("variants change the capabilities of a matching model only", () => {
	const gemma = family("gemma4");
	assert.equal(familyCapabilities(gemma, "gemma4-e4b").audio, true);
	assert.equal(familyCapabilities(gemma, "gemma-4-E2B-it").audio, true);
	assert.equal(familyCapabilities(gemma, "gemma4-e4b").contextWindow, 131072);
	assert.equal(familyCapabilities(gemma, "gemma4-31b").audio, false);
	assert.equal(familyCapabilities(gemma, "gemma4-31b").contextWindow, 262144);
	assert.equal(familyCapabilities(gemma, "gemma4-31b").image, true);
});

test("variants change the sampling of a matching model only", () => {
	const custom: ModelFamily = {
		...family("qwen3"),
		variants: [{ match: ["8b"], sampling: { on: { temperature: 0.5 } } }],
	};
	assert.deepEqual(familySampling(custom, "Qwen3-8B").on, { temperature: 0.5, topP: 0.95, topK: 20, minP: 0 });
	assert.deepEqual(familySampling(custom, "Qwen3-4B").on, { temperature: 0.6, topP: 0.95, topK: 20, minP: 0 });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("the bundled data is valid and has the approved values", () => {
	assert.deepEqual(registry.rejected, []);
	assert.equal(validateFamilyIndex(registry.index), null);
	for (const entry of registry.families) assert.equal(validateFamily(entry), null, entry.id);
	assert.deepEqual(family("qwen3.8").thinking?.efforts, ["low", "medium", "xhigh"]);
	assert.deepEqual(family("qwen3.8").sampling.off, {
		temperature: 0.7,
		topP: 0.8,
		topK: 20,
		minP: 0,
		presencePenalty: 1.5,
	});
	assert.equal(family("qwen3.5-small").thinking?.defaultOn, false);
	assert.equal(family("gemma4").thinking?.sendPreserve, false);
	assert.equal(family("qwen3.6").extraPresets?.[0].sampling.presencePenalty, 0);
	for (const entry of registry.families) assert.equal(entry.capabilities.tools, true, entry.id);
});

test("validateFamily refuses bad data", () => {
	const good = family("qwen3.8");
	const bad: [string, unknown][] = [
		["not an object", []],
		["unknown key", { ...good, extra: 1 }],
		["empty id", { ...good, id: "" }],
		["empty match", { ...good, match: [] }],
		["regex that does not compile", { ...good, match: ["("] }],
		["regex too long", { ...good, match: ["a".repeat(201)] }],
		["unknown effort", { ...good, thinking: { ...good.thinking, efforts: ["ultra"] } }],
		["bad sampling", { ...good, sampling: { on: { temperature: "hot" } } }],
		["unknown sampling key", { ...good, sampling: { on: { top_p: 1 } } }],
		["bad preset slug", { ...good, extraPresets: [{ slug: "no spaces", thinking: "on", sampling: {} }] }],
		["bad preset thinking", { ...good, extraPresets: [{ slug: "x", thinking: "maybe", sampling: {} }] }],
		["context not an integer", { ...good, capabilities: { contextWindow: 1.5 } }],
		["context not positive", { ...good, capabilities: { contextWindow: 0 } }],
		["variant with no match", { ...good, variants: [{ capabilities: { audio: true } }] }],
		["missing sampling", { ...good, sampling: undefined }],
	];
	for (const [label, value] of bad) assert.equal(typeof validateFamily(value), "string", label);
});

test("validateFamilyIndex refuses bad data", () => {
	const good = registry.index;
	const bad: [string, unknown][] = [
		["unknown schemaVersion", { ...good, schemaVersion: 2 }],
		["revision not an integer", { ...good, revision: 1.5 }],
		["bad date", { ...good, updated: "today" }],
		["file with a path", { ...good, files: ["../qwen3.json"] }],
		["file with a directory", { ...good, files: ["a/qwen3.json"] }],
		["file that is not JSON", { ...good, files: ["qwen3.txt"] }],
		["unknown key", { ...good, extra: true }],
		["bad server value", { ...good, servers: { Ollama: { thinking: "other" } } }],
	];
	for (const [label, value] of bad) assert.equal(typeof validateFamilyIndex(value), "string", label);
});

// ---------------------------------------------------------------------------
// Thinking profile
// ---------------------------------------------------------------------------

const QWEN38_TEMPLATE = `
{%- if enable_thinking is defined and enable_thinking is false %}<think></think>{%- endif %}
{%- if reasoning_effort is defined and reasoning_effort not in ['low', 'medium', 'xhigh'] %}
{{- raise_exception("bad effort") }}
{%- endif %}
{%- if preserve_thinking %}{{ message.reasoning_content }}{%- endif %}`;

const INKLING2_TEMPLATE = `
{%- set effort_map = {"none": 0.0, "minimal": 0.1, "low": 0.25, "medium": 0.5, "high": 0.75, "xhigh": 0.9, "max": 0.99} %}
{%- if reasoning_effort is string %}{%- set effort = effort_map[reasoning_effort] %}{%- endif %}`;

test("parseTemplateThinking reads the controls from the template text", () => {
	assert.deepEqual(parseTemplateThinking(QWEN38_TEMPLATE), {
		toggle: true,
		readsPreserve: true,
		efforts: ["low", "medium", "xhigh"],
	});
	assert.deepEqual(parseTemplateThinking(INKLING2_TEMPLATE), {
		toggle: false,
		readsPreserve: false,
		efforts: [...EFFORT_SCALE],
	});
	assert.deepEqual(parseTemplateThinking("{%- if enable_thinking %}{{ 'low' }}{%- endif %}"), {
		toggle: true,
		readsPreserve: false,
		efforts: null,
	});
	assert.deepEqual(parseTemplateThinking("{%- set effort = reasoning_effort | float %}").efforts, []);
});

test("the server report makes the profile of each live model", () => {
	// Qwen3.8-27B
	assert.deepEqual(
		resolveThinkingProfile(
			{ thinkingDefault: true, preserveThinkingDefault: true, reasoningEfforts: ["low", "medium", "xhigh"] },
			family("qwen3.8"),
		),
		{ toggle: true, efforts: ["low", "medium", "xhigh"], preserveThinking: true, defaultOn: true, source: "server" },
	);
	// qwen3.8-flash: the server efforts win over the family efforts
	assert.deepEqual(
		resolveThinkingProfile(
			{ thinkingDefault: true, preserveThinkingDefault: true, reasoningEfforts: ["xhigh", "low", "high", "medium"] },
			family("qwen3.8"),
		)?.efforts,
		["low", "medium", "high", "xhigh"],
	);
	// gemma-4-e4b: the template reads preserve_thinking, but the family does not send it
	assert.deepEqual(
		resolveThinkingProfile(
			{ thinkingDefault: false, preserveThinkingDefault: true, reasoningEfforts: null },
			family("gemma4"),
		),
		{ toggle: true, efforts: [], preserveThinking: false, defaultOn: false, source: "server" },
	);
	// Inkling-2-Mini: an empty effort list uses the family efforts
	assert.deepEqual(
		resolveThinkingProfile(
			{ thinkingDefault: null, preserveThinkingDefault: null, reasoningEfforts: [] },
			family("inkling2-mini"),
		),
		{ toggle: false, efforts: [...EFFORT_SCALE], preserveThinking: false, defaultOn: true, source: "server" },
	);
});

test("the server report without a family", () => {
	assert.deepEqual(
		resolveThinkingProfile({ thinkingDefault: null, preserveThinkingDefault: null, reasoningEfforts: [] }, undefined),
		{ toggle: false, efforts: ["low", "medium", "high"], preserveThinking: false, defaultOn: true, source: "server" },
	);
	assert.equal(
		resolveThinkingProfile({ thinkingDefault: true, preserveThinkingDefault: true }, undefined)?.preserveThinking,
		true,
	);
	assert.equal(
		resolveThinkingProfile({ thinkingDefault: true, preserveThinkingDefault: false }, undefined)?.preserveThinking,
		false,
	);
	assert.deepEqual(resolveThinkingProfile({ thinkingDefault: true, reasoningEfforts: ["ultra", "low"] }, undefined)?.efforts, [
		"low",
	]);
});

test("a server report with no control gives no profile, also with a family", () => {
	const report = { thinkingDefault: null, preserveThinkingDefault: null, reasoningEfforts: null };
	assert.equal(resolveThinkingProfile(report, undefined), undefined);
	assert.equal(resolveThinkingProfile(report, family("qwen3.8")), undefined);
});

test("the chat template makes the profile when the server has no status fields", () => {
	assert.deepEqual(resolveThinkingProfile({ chatTemplate: QWEN38_TEMPLATE }, undefined), {
		toggle: true,
		efforts: ["low", "medium", "xhigh"],
		preserveThinking: true,
		defaultOn: true,
		source: "template",
	});
	const gemma = resolveThinkingProfile(
		{ chatTemplate: "{% if enable_thinking %}{% endif %}{% if preserve_thinking %}{% endif %}" },
		family("gemma4"),
	);
	assert.deepEqual(gemma, { toggle: true, efforts: [], preserveThinking: false, defaultOn: false, source: "template" });
	assert.equal(resolveThinkingProfile({ chatTemplate: "{{ messages }}" }, family("qwen3.8")), undefined);
});

test("the family makes the profile when the server reports nothing", () => {
	assert.deepEqual(resolveThinkingProfile(undefined, family("qwen3.6")), {
		toggle: true,
		efforts: [],
		preserveThinking: true,
		defaultOn: true,
		source: "family",
	});
	assert.equal(resolveThinkingProfile({}, family("gemma4"))?.preserveThinking, false);
	assert.equal(resolveThinkingProfile({}, family("qwen3.5-small"))?.defaultOn, false);
	assert.equal(resolveThinkingProfile(undefined, undefined), undefined);
	assert.equal(resolveThinkingProfile({}, { ...family("qwen3"), thinking: undefined }), undefined);
});

// ---------------------------------------------------------------------------
// Level map
// ---------------------------------------------------------------------------

function profile(toggle: boolean, efforts: string[], preserveThinking = false): ThinkingProfile {
	return { toggle, efforts, preserveThinking, defaultOn: true, source: "family" };
}

function effortOf(map: ReturnType<typeof mapLevels>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(map.controls).map(([level, control]) => [
			level,
			control.enableThinking === false ? "off" : (control.effort ?? "on"),
		]),
	);
}

test("nearestEffort: a tie goes to the higher effort", () => {
	assert.equal(nearestEffort("high", ["low", "medium", "xhigh"]), "xhigh");
	assert.equal(nearestEffort("minimal", ["low", "medium", "xhigh"]), "low");
	assert.equal(nearestEffort("xhigh", ["none", "minimal", "low", "medium", "high", "max"]), "max");
	assert.equal(nearestEffort("medium", ["medium"]), "medium");
	assert.equal(nearestEffort("medium", []), undefined);
	assert.equal(nearestEffort("ultra", ["low"]), undefined);
});

test("mapLevels: Qwen 3.8 (toggle and low, medium, xhigh)", () => {
	const map = mapLevels(profile(true, ["low", "medium", "xhigh"]));
	assert.deepEqual(effortOf(map), {
		off: "off",
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "xhigh",
		xhigh: "xhigh",
		max: "xhigh",
	});
	assert.deepEqual(map.controls.off, { enableThinking: false });
	assert.deepEqual(map.controls.high, { enableThinking: true, effort: "xhigh" });
	assert.deepEqual(map.thinkingLevelMap, {
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "xhigh",
		xhigh: "xhigh",
		max: "xhigh",
	});
	assert.deepEqual(map.offered, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("mapLevels: Qwen 3.8 Flash (toggle and low, medium, high, xhigh)", () => {
	const map = effortOf(mapLevels(profile(true, ["low", "medium", "high", "xhigh"])));
	assert.equal(map.high, "high");
	assert.equal(map.max, "xhigh");
	assert.equal(map.minimal, "low");
});

test("mapLevels: Inkling (efforts only, no toggle)", () => {
	const map = mapLevels(profile(false, ["none", "minimal", "low", "medium", "high", "max"]));
	assert.deepEqual(effortOf(map), {
		off: "none",
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "max",
		max: "max",
	});
	assert.deepEqual(map.controls.off, { effort: "none" });
	assert.equal("off" in map.thinkingLevelMap, false);
});

test("mapLevels: Inkling 2 (all seven efforts, no toggle)", () => {
	const map = effortOf(mapLevels(profile(false, [...EFFORT_SCALE])));
	assert.deepEqual(map, {
		off: "none",
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	});
});

test("mapLevels: toggle only", () => {
	const map = mapLevels(profile(true, []));
	assert.deepEqual(map.controls.off, { enableThinking: false });
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		assert.deepEqual(map.controls[level], { enableThinking: true }, level);
	}
	assert.deepEqual(map.offered, ["off", "high"]);
	assert.deepEqual(map.thinkingLevelMap, { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null });
});

// ---------------------------------------------------------------------------
// Presets and routing
// ---------------------------------------------------------------------------

test("levelKwargs and controlSlug", () => {
	const qwen = profile(true, ["low", "medium", "xhigh"], true);
	assert.deepEqual(levelKwargs({ enableThinking: false }, qwen), { enable_thinking: false, preserve_thinking: true });
	assert.deepEqual(levelKwargs({ enableThinking: true, effort: "xhigh" }, qwen), {
		enable_thinking: true,
		reasoning_effort: "xhigh",
		preserve_thinking: true,
	});
	assert.deepEqual(levelKwargs({ effort: "none" }, profile(false, ["none"])), { reasoning_effort: "none" });
	assert.equal(controlSlug({ enableThinking: false }), "instruct");
	assert.equal(controlSlug({ enableThinking: true, effort: "low" }), "thinking-low");
	assert.equal(controlSlug({ effort: "none" }), "thinking-none");
	assert.equal(controlSlug({ enableThinking: true }), "thinking");
});

test("buildFamilyPresets: Qwen 3.8 gives the four known presets", () => {
	const qwen = family("qwen3.8");
	const thinking = resolveThinkingProfile(undefined, qwen);
	assert.ok(thinking);
	const { presets, routing, levelSlugs } = buildFamilyPresets(qwen, thinking, "Qwen3.8-27B");
	assert.deepEqual(
		presets.map((preset) => preset.slug),
		["instruct", "thinking-low", "thinking-medium", "thinking-xhigh"],
	);
	assert.deepEqual(presets[0], {
		slug: "instruct",
		chatTemplateKwargs: { enable_thinking: false, preserve_thinking: true },
		sampling: qwen.sampling.off,
		exposeAsModel: false,
	});
	assert.deepEqual(presets[3], {
		slug: "thinking-xhigh",
		chatTemplateKwargs: { enable_thinking: true, reasoning_effort: "xhigh", preserve_thinking: true },
		sampling: qwen.sampling.on,
		exposeAsModel: false,
	});
	assert.deepEqual(routing, { enabled: true, aliasSlug: "adaptive", levels: levelSlugs });
	assert.deepEqual(levelSlugs, {
		off: "instruct",
		minimal: "thinking-low",
		low: "thinking-low",
		medium: "thinking-medium",
		high: "thinking-xhigh",
		xhigh: "thinking-xhigh",
		max: "thinking-xhigh",
	});
});

test("buildFamilyPresets: a toggle family with an extra preset", () => {
	const qwen = family("qwen3.6");
	const thinking = resolveThinkingProfile(undefined, qwen);
	assert.ok(thinking);
	const { presets, levelSlugs } = buildFamilyPresets(qwen, thinking, "qwen3.6-35b");
	assert.deepEqual(
		presets.map((preset) => preset.slug),
		["instruct", "thinking", "thinking-general"],
	);
	assert.deepEqual(presets[2], {
		slug: "thinking-general",
		chatTemplateKwargs: { enable_thinking: true, preserve_thinking: true },
		sampling: { temperature: 1, topP: 0.95, topK: 20, presencePenalty: 0 },
		exposeAsModel: false,
	});
	assert.equal(levelSlugs.off, "instruct");
	assert.equal(levelSlugs.max, "thinking");
});

test("buildFamilyPresets: Inkling has no toggle and one sampling set", () => {
	const inkling = family("inkling");
	const thinking = resolveThinkingProfile(undefined, inkling);
	assert.ok(thinking);
	const { presets, levelSlugs } = buildFamilyPresets(inkling, thinking, "Inkling");
	assert.deepEqual(
		presets.map((preset) => preset.slug),
		["thinking-none", "thinking-minimal", "thinking-low", "thinking-medium", "thinking-high", "thinking-max"],
	);
	assert.deepEqual(presets[0].chatTemplateKwargs, { reasoning_effort: "none" });
	assert.deepEqual(presets[0].sampling, inkling.sampling.on);
	assert.equal(levelSlugs.off, "thinking-none");
	assert.equal(levelSlugs.xhigh, "thinking-max");
});

test("buildFamilyPresets: no family gives presets with no sampling", () => {
	const { presets } = buildFamilyPresets(undefined, profile(true, []), "unknown-model");
	assert.deepEqual(presets, [
		{ slug: "instruct", chatTemplateKwargs: { enable_thinking: false }, exposeAsModel: false },
		{ slug: "thinking", chatTemplateKwargs: { enable_thinking: true }, exposeAsModel: false },
	]);
});

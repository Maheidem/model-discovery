import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledFamilies } from "../extensions/family-store.ts";
import { resolveModel } from "../extensions/model-plan.ts";
import type { ModelConfig } from "../extensions/providers.ts";

const registry = loadBundledFamilies();

function config(id: string, patch: Partial<ModelConfig> = {}): ModelConfig {
	return {
		id,
		name: id,
		contextWindow: null,
		maxTokens: null,
		reasoning: null,
		input: null,
		source: "api",
		vision: null,
		modelType: null,
		thinking: null,
		...patch,
	};
}

test("Qwen 3.8 with the server profile: base model sends the bundled preset of each level", () => {
	const model = resolveModel(
		{},
		config("Qwen3.8-27B", {
			modelType: "vlm",
			vision: true,
			thinking: { thinkingDefault: true, preserveThinkingDefault: true, reasoningEfforts: ["low", "medium", "xhigh"] },
		}),
		registry,
		"oMLX",
	);
	assert.equal(model.family?.id, "qwen3.8");
	assert.equal(model.thinking?.source, "server");
	assert.equal(model.reasoning, true);
	assert.equal(model.visionSource, "server");
	assert.deepEqual(model.baseLevelParams?.off, {
		temperature: 0.7,
		top_p: 0.8,
		top_k: 20,
		min_p: 0,
		presence_penalty: 1.5,
		chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
	});
	assert.deepEqual(model.baseLevelParams?.high, {
		temperature: 1,
		top_p: 0.95,
		top_k: 20,
		min_p: 0,
		presence_penalty: 0,
		chat_template_kwargs: { enable_thinking: true, reasoning_effort: "xhigh", preserve_thinking: true },
	});
	assert.deepEqual(model.plan?.levelParams.minimal, {
		chat_template_kwargs: { enable_thinking: true, reasoning_effort: "low", preserve_thinking: true },
	});
	assert.deepEqual(
		model.defaults?.presets.map((preset) => preset.slug),
		["instruct", "thinking-low", "thinking-medium", "thinking-xhigh"],
	);
	assert.deepEqual(model.levelKinds, {
		off: "off", minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh",
	});
});

test("the server profile decides: a reduced effort list sends no rejected value", () => {
	const model = resolveModel(
		{},
		config("Qwen3.8-27B", { thinking: { thinkingDefault: true, preserveThinkingDefault: null, reasoningEfforts: ["low"] } }),
		registry,
		"oMLX",
	);
	for (const params of Object.values(model.baseLevelParams ?? {})) {
		const kwargs = params.chat_template_kwargs as Record<string, unknown>;
		assert.ok(kwargs.reasoning_effort === undefined || kwargs.reasoning_effort === "low");
		assert.equal(kwargs.preserve_thinking, undefined);
	}
});

test("Gemma 4: off and on only, no effort, no preserve", () => {
	const model = resolveModel(
		{},
		config("gemma-4-e4b", { thinking: { thinkingDefault: false, preserveThinkingDefault: true, reasoningEfforts: null } }),
		registry,
		"oMLX",
	);
	assert.deepEqual(model.levelMap?.offered, ["off", "high"]);
	assert.deepEqual(model.baseLevelParams?.high, {
		temperature: 1, top_p: 0.95, top_k: 64, chat_template_kwargs: { enable_thinking: true },
	});
	assert.deepEqual(model.baseLevelParams?.off.chat_template_kwargs, { enable_thinking: false });
	assert.equal(model.audio, true);
});

test("Inkling 2 Mini: the effort name of each level, no switch", () => {
	const model = resolveModel(
		{},
		config("Inkling-2-Mini", { thinking: { thinkingDefault: null, preserveThinkingDefault: null, reasoningEfforts: [] } }),
		registry,
		"oMLX",
	);
	assert.deepEqual(model.baseLevelParams?.off, { temperature: 1, chat_template_kwargs: { reasoning_effort: "none" } });
	assert.deepEqual(model.baseLevelParams?.xhigh, { temperature: 1, chat_template_kwargs: { reasoning_effort: "xhigh" } });
});

test("the family file is the fallback when the server reports nothing", () => {
	const model = resolveModel({ defaultMaxTokens: 4096 }, config("qwen3.6-35b"), registry, "OpenAI-compatible");
	assert.equal(model.thinking?.source, "family");
	assert.equal(model.reasoningSource, "family");
	assert.equal(model.vision, true);
	assert.equal(model.visionSource, "family");
	assert.equal(model.contextWindowSource, "family");
	assert.equal(model.maxTokensSource, "source default");
	assert.deepEqual(model.baseLevelParams?.high.chat_template_kwargs, { enable_thinking: true, preserve_thinking: true });
	assert.deepEqual(model.defaults?.presets.map((preset) => preset.slug), ["instruct", "thinking", "thinking-general"]);
});

test("a server fact wins over the family, and the user setting wins over the server", () => {
	const noVision = resolveModel({}, config("gemma-4-31b", { vision: false }), registry, "llama.cpp");
	assert.equal(noVision.vision, false);
	assert.equal(noVision.visionSource, "server");
	assert.deepEqual(noVision.input, ["text"]);
	const forced = resolveModel(
		{ modelOverrides: { "gemma-4-31b": { input: ["text", "image"], reasoning: false } } },
		config("gemma-4-31b", { vision: false }),
		registry,
		"llama.cpp",
	);
	assert.equal(forced.visionSource, "your setting");
	assert.equal(forced.vision, true);
	assert.equal(forced.reasoning, false);
});

test("recommended defaults off: the base model sends the switch only", () => {
	const model = resolveModel(
		{ modelOverrides: { "Qwen3.8-27B": { familyDefaults: false } } },
		config("Qwen3.8-27B", { thinking: { thinkingDefault: true, preserveThinkingDefault: true, reasoningEfforts: ["low", "medium", "xhigh"] } }),
		registry,
		"oMLX",
	);
	assert.deepEqual(model.baseLevelParams?.max, { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } });
	assert.deepEqual(model.baseLevelParams?.off, { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } });
	// The preset aliases still accept the full efforts of the model.
	assert.deepEqual(model.plan?.controls.efforts, ["low", "medium", "xhigh"]);
});

test("Ollama and LM Studio get a top-level reasoning_effort", () => {
	const model = resolveModel({}, config("qwen3.8:27b"), registry, "Ollama");
	assert.deepEqual(model.baseLevelParams?.off.reasoning_effort, "none");
	assert.equal(model.baseLevelParams?.off.chat_template_kwargs, undefined);
	assert.equal(model.baseLevelParams?.medium.reasoning_effort, "medium");
});

test("a model that is not a chat model is hidden, and the user can show it", () => {
	const asr = resolveModel({}, config("Qwen3-ASR", { modelType: "audio_stt" }), registry, "oMLX");
	assert.equal(asr.kind, "speech-to-text");
	assert.equal(asr.hidden, true);
	assert.equal(asr.family, undefined);
	assert.equal(resolveModel({}, config("embed-gemma2"), registry, "OpenAI-compatible").hidden, true);
	const shown = resolveModel({ modelOverrides: { "Qwen3-ASR": { hidden: false } } }, config("Qwen3-ASR", { modelType: "audio_stt" }), registry, "oMLX");
	assert.equal(shown.hidden, false);
	assert.equal(resolveModel({}, config("unknown-model"), registry, "oMLX").thinking, undefined);
});

test("an unknown family with a server profile gets a level map and no sampling", () => {
	const model = resolveModel(
		{},
		config("SenseNova-Loop-9B", { thinking: { thinkingDefault: true, preserveThinkingDefault: null, reasoningEfforts: null } }),
		registry,
		"oMLX",
	);
	assert.equal(model.family, undefined);
	assert.deepEqual(model.baseLevelParams?.high, { chat_template_kwargs: { enable_thinking: true } });
	assert.deepEqual(model.levelMap?.offered, ["off", "high"]);
});

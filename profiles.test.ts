import assert from "node:assert/strict";
import test from "node:test";
import {
	analyzeExplicitProfileRouting,
	applyThinkingProfileRoute,
	buildProfileSamplingParams,
	expandAdaptiveProfileRouters,
	expandModelProfiles,
	migrateLegacyProfileRouting,
	profileModelId,
	QWEN_NATIVE_CHAT_TEMPLATE_KWARGS,
	QWEN_NATIVE_THINKING_LEVEL_MAP,
	repetitionPenaltyKeyForServer,
	validateChatTemplateKwargs,
	validateModelProfile,
	validateProfileSampling,
	validateProfileSlug,
	type ModelProfile,
	type ModelProfileRouting,
} from "./profiles.ts";

const baseModel = {
	id: "Qwen3.8-27B",
	name: "Qwen3.8-27B",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 262_144,
	maxTokens: 32_768,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { thinkingFormat: "qwen-chat-template" },
};

test("validates profile names and the supported kwargs", () => {
	assert.equal(validateProfileSlug("xhigh"), null);
	assert.equal(validateProfileSlug("coding.fast_2"), null);
	assert.match(validateProfileSlug("bad name") ?? "", /letters, numbers/);

	assert.equal(
		validateChatTemplateKwargs({
			enable_thinking: true,
			reasoning_effort: "xhigh",
			preserve_thinking: false,
		}),
		null,
	);
	assert.match(validateChatTemplateKwargs({ reasoning_effort: "high" }) ?? "", /low.*medium.*xhigh/);
	assert.equal(validateChatTemplateKwargs({ enable_thinking: false, reasoning_effort: "low" }), null);
	assert.equal(validateChatTemplateKwargs({}), null);
	assert.match(validateChatTemplateKwargs({ temperature: 0.2 }) ?? "", /Unsupported/);
	assert.match(validateModelProfile({ slug: "empty", chatTemplateKwargs: {} }) ?? "", /at least one/);
	assert.equal(
		validateModelProfile({ slug: "low", chatTemplateKwargs: { reasoning_effort: "low" } }),
		null,
	);
});

test("maps every Pi native thinking level to Qwen chat-template controls", () => {
	assert.deepEqual(QWEN_NATIVE_THINKING_LEVEL_MAP, {
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "xhigh",
		xhigh: "xhigh",
		max: "xhigh",
	});
	assert.deepEqual(QWEN_NATIVE_CHAT_TEMPLATE_KWARGS, {
		enable_thinking: { $var: "thinking.enabled" },
		reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
		preserve_thinking: true,
	});
});

const routedProfiles: ModelProfile[] = [
	{ slug: "instruct", chatTemplateKwargs: { enable_thinking: false }, sampling: { temperature: 0.7 } },
	{ slug: "thinking-low", chatTemplateKwargs: { enable_thinking: true, reasoning_effort: "low" }, sampling: { topP: 0.95 } },
	{ slug: "thinking-low-creative", chatTemplateKwargs: { enable_thinking: true, reasoning_effort: "low" }, sampling: { temperature: 1.2 } },
	{ slug: "thinking-medium", chatTemplateKwargs: { enable_thinking: true, reasoning_effort: "medium" }, sampling: { topP: 0.95, presencePenalty: 0 } },
	{ slug: "thinking-xhigh", chatTemplateKwargs: { enable_thinking: true, reasoning_effort: "xhigh" }, sampling: { topP: 0.95 } },
];

const explicitRouting: ModelProfileRouting = {
	enabled: true,
	aliasSlug: "adaptive",
	levels: {
		off: "instruct",
		minimal: "thinking-low",
		low: "thinking-low-creative",
		medium: "thinking-medium",
		high: "thinking-xhigh",
		xhigh: "thinking-xhigh",
		max: "thinking-xhigh",
	},
};

test("explicit routing permits duplicate-effort presets and resolves all seven levels", () => {
	const analysis = analyzeExplicitProfileRouting(explicitRouting, routedProfiles);
	assert.deepEqual(analysis.errors, []);
	assert.ok(analysis.routes);
	assert.equal(analysis.routes.minimal.slug, "thinking-low");
	assert.equal(analysis.routes.low.slug, "thinking-low-creative");
	assert.equal(analysis.routes.medium.slug, "thinking-medium");

	assert.deepEqual(
		applyThinkingProfileRoute(
			{
				model: "Qwen3.8-27B",
				enable_thinking: false,
				reasoning_effort: "low",
				temperature: 0,
				top_k: 99,
				repeat_penalty: 1.2,
				frequency_penalty: 1,
				chat_template_kwargs: { enable_thinking: false },
				messages: [],
			},
			analysis.routes.medium,
			"repetition_penalty",
		),
		{
			model: "Qwen3.8-27B",
			top_p: 0.95,
			presence_penalty: 0,
			chat_template_kwargs: { enable_thinking: true, reasoning_effort: "medium" },
			messages: [],
		},
	);
});

test("explicit routing reports missing references and alias collisions", () => {
	const missing = analyzeExplicitProfileRouting(
		{ ...explicitRouting, aliasSlug: "instruct", levels: { ...explicitRouting.levels, max: "missing" } },
		routedProfiles,
	);
	assert.ok(missing.errors.some((error) => error.includes("collides")));
	assert.ok(missing.errors.some((error) => error.includes('max references missing preset "missing"')));
});

test("conservatively migrates the one legacy adaptive sampling alias", () => {
	const legacy = [
		...routedProfiles.filter((profile) => profile.slug !== "thinking-low-creative"),
		{ slug: "thinking", sampling: { temperature: 1 } },
	];
	const migration = migrateLegacyProfileRouting(legacy, undefined);
	assert.equal(migration.changed, true);
	assert.equal(migration.routing?.aliasSlug, "thinking");
	assert.equal(migration.routing?.levels.off, "instruct");
	assert.equal(migration.routing?.levels.medium, "thinking-medium");
	assert.equal(migration.profiles.some((profile) => profile.slug === "thinking"), false);
	assert.equal(migrateLegacyProfileRouting(legacy, explicitRouting).changed, false);
});

test("validates all supported sampling values and ranges", () => {
	assert.equal(
		validateProfileSampling({
			temperature: 0,
			topP: 1,
			topK: 0,
			minP: 0,
			repetitionPenalty: 1,
			presencePenalty: -2,
			frequencyPenalty: 2,
		}),
		null,
	);
	assert.match(validateProfileSampling({ temperature: 2.1 }) ?? "", /between 0 and 2/);
	assert.match(validateProfileSampling({ topP: -0.1 }) ?? "", /top_p/);
	assert.match(validateProfileSampling({ topK: 2.5 }) ?? "", /integer/);
	assert.match(validateProfileSampling({ minP: 1.1 }) ?? "", /min_p/);
	assert.match(validateProfileSampling({ repetitionPenalty: 0 }) ?? "", /greater than 0/);
	assert.match(validateProfileSampling({ presencePenalty: 2.1 }) ?? "", /presence_penalty/);
	assert.match(validateProfileSampling({ frequencyPenalty: -2.1 }) ?? "", /frequency_penalty/);
	assert.match(validateProfileSampling({ seed: 1 }) ?? "", /Unsupported/);
});

test("expands profiles into inherited aliases with exact request overrides", () => {
	const profile: ModelProfile = {
		slug: "xhigh",
		chatTemplateKwargs: {
			enable_thinking: true,
			reasoning_effort: "xhigh",
			preserve_thinking: false,
		},
		sampling: {
			temperature: 0.7,
			topP: 0.9,
			topK: 20,
			minP: 0.05,
			repetitionPenalty: 1.05,
			presencePenalty: 0.2,
			frequencyPenalty: -0.1,
		},
	};
	const result = expandModelProfiles([baseModel], { [baseModel.id]: [profile] });

	assert.equal(result.profileCount, 1);
	assert.deepEqual(result.warnings, []);
	assert.equal(result.models.length, 2);
	assert.deepEqual(result.models[0], baseModel);
	const alias = result.models[1];
	assert.equal(alias.id, "Qwen3.8-27B@xhigh");
	assert.equal(alias.name, "Qwen3.8-27B (xhigh)");
	assert.equal(alias.contextWindow, baseModel.contextWindow);
	assert.deepEqual(alias.input, baseModel.input);
	assert.equal(alias.reasoning, true);
	assert.deepEqual(alias.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: "xhigh",
		max: null,
	});
	assert.deepEqual(alias.compat, {
		thinkingFormat: "chat-template",
		chatTemplateKwargs: {},
		supportsReasoningEffort: false,
	});
	assert.deepEqual(alias.samplingParams, {
		model: "Qwen3.8-27B",
		temperature: 0.7,
		top_p: 0.9,
		top_k: 20,
		min_p: 0.05,
		repetition_penalty: 1.05,
		presence_penalty: 0.2,
		frequency_penalty: -0.1,
		chat_template_kwargs: profile.chatTemplateKwargs,
	});
});

test("registers only an explicit adaptive alias and leaves base/fixed aliases untouched", () => {
	const profiles = routedProfiles.map((profile) =>
		profile.slug === "thinking-low-creative" ? { ...profile, exposeAsModel: false } : profile,
	);
	const fixed = expandModelProfiles([baseModel], { [baseModel.id]: profiles });
	assert.equal(fixed.models[0].id, baseModel.id);
	assert.equal(fixed.models.some((model) => model.id === `${baseModel.id}@thinking-low-creative`), false);
	assert.equal(fixed.models.some((model) => model.id === `${baseModel.id}@adaptive`), false);

	const adaptive = expandAdaptiveProfileRouters(
		fixed.models,
		{ [baseModel.id]: profiles },
		{ [baseModel.id]: explicitRouting },
	);
	assert.deepEqual(adaptive.warnings, []);
	assert.equal(adaptive.routerCount, 1);
	assert.equal(adaptive.models[0].id, baseModel.id);
	assert.deepEqual(adaptive.models.find((model) => model.id === `${baseModel.id}@instruct`), fixed.models.find((model) => model.id === `${baseModel.id}@instruct`));
	const router = adaptive.models.find((model) => model.id === `${baseModel.id}@adaptive`);
	assert.ok(router);
	assert.equal(router.name, "Qwen3.8-27B (adaptive; adaptive)");
	assert.deepEqual(router.samplingParams, { model: baseModel.id });
	assert.deepEqual(adaptive.runtimeRoutes.get(`${baseModel.id}@adaptive`)?.low, profiles[2]);
});

test("maps repetition penalty by backend", () => {
	const sampling = { repetitionPenalty: 1.1 };
	assert.equal(repetitionPenaltyKeyForServer("oMLX"), "repetition_penalty");
	assert.equal(repetitionPenaltyKeyForServer("vLLM"), "repetition_penalty");
	assert.equal(repetitionPenaltyKeyForServer("SGLang"), "repetition_penalty");
	assert.equal(repetitionPenaltyKeyForServer("Ollama"), "repetition_penalty");
	assert.equal(repetitionPenaltyKeyForServer("OpenAI-compatible"), "repetition_penalty");
	assert.equal(repetitionPenaltyKeyForServer("unknown future server"), "repetition_penalty");
	assert.equal(repetitionPenaltyKeyForServer("llama.cpp"), "repeat_penalty");
	assert.equal(repetitionPenaltyKeyForServer("LM Studio"), "repeat_penalty");
	assert.deepEqual(buildProfileSamplingParams(sampling, "repetition_penalty"), { repetition_penalty: 1.1 });
	assert.deepEqual(buildProfileSamplingParams(sampling, "repeat_penalty"), { repeat_penalty: 1.1 });

	const llamaAlias = expandModelProfiles(
		[baseModel],
		{ [baseModel.id]: [{ slug: "llama", sampling }] },
		{ repetitionPenaltyKey: repetitionPenaltyKeyForServer("llama.cpp") },
	).models[1];
	assert.deepEqual(llamaAlias.samplingParams, { model: baseModel.id, repeat_penalty: 1.1 });
});

test("retains configured zero values while omitting unspecified sampling keys", () => {
	assert.deepEqual(
		buildProfileSamplingParams({
			temperature: 0,
			topP: 0,
			topK: 0,
			minP: 0,
			presencePenalty: 0,
			frequencyPenalty: 0,
		}),
		{
			temperature: 0,
			top_p: 0,
			top_k: 0,
			min_p: 0,
			presence_penalty: 0,
			frequency_penalty: 0,
		},
	);
});

test("sampling-only profiles preserve the base thinking behavior", () => {
	const result = expandModelProfiles([baseModel], {
		[baseModel.id]: [{ slug: "creative", sampling: { temperature: 1.2, topP: 0.95 } }],
	});
	const alias = result.models[1];
	assert.equal(alias.reasoning, baseModel.reasoning);
	assert.deepEqual(alias.compat, baseModel.compat);
	assert.equal(Object.hasOwn(alias.samplingParams ?? {}, "chat_template_kwargs"), false);
	assert.deepEqual(alias.samplingParams, { model: baseModel.id, temperature: 1.2, top_p: 0.95 });
});

test("locks Pi's visible thinking level to each fixed profile effort", () => {
	const profiles: ModelProfile[] = (["low", "medium", "xhigh"] as const).map((effort) => ({
		slug: effort,
		chatTemplateKwargs: { enable_thinking: true, reasoning_effort: effort },
	}));
	const result = expandModelProfiles([baseModel], { [baseModel.id]: profiles });

	for (const [index, effort] of (["low", "medium", "xhigh"] as const).entries()) {
		const map = result.models[index + 1].thinkingLevelMap;
		assert.equal(map?.[effort], effort);
		assert.deepEqual(
			Object.entries(map ?? {})
				.filter(([, mapped]) => mapped !== null)
				.map(([level]) => level),
			[effort],
		);
	}
});

test("disabled profiles expose reasoning as off", () => {
	const result = expandModelProfiles([baseModel], {
		[baseModel.id]: [{ slug: "fast", chatTemplateKwargs: { enable_thinking: false } }],
	});
	const alias = result.models[1];
	assert.equal(alias.reasoning, false);
	assert.equal(alias.thinkingLevelMap, undefined);
	assert.deepEqual(alias.samplingParams?.chat_template_kwargs, { enable_thinking: false });
});

test("skips invalid, duplicate, colliding, and orphaned profiles without dropping base models", () => {
	const collidingBase = { ...baseModel, id: profileModelId(baseModel.id, "server") };
	const profiles = {
		[baseModel.id]: [
			{ slug: "server", chatTemplateKwargs: { enable_thinking: true } },
			{ slug: "same", chatTemplateKwargs: { reasoning_effort: "low" } },
			{ slug: "same", chatTemplateKwargs: { reasoning_effort: "medium" } },
			{ slug: "bad name", chatTemplateKwargs: { enable_thinking: true } },
		],
		missing: [{ slug: "kept", chatTemplateKwargs: { preserve_thinking: false } }],
	} as Record<string, ModelProfile[]>;
	const result = expandModelProfiles([baseModel, collidingBase], profiles);

	assert.equal(result.models.length, 3);
	assert.equal(result.profileCount, 1);
	assert.ok(result.warnings.some((warning) => warning.includes("collides")));
	assert.ok(result.warnings.some((warning) => warning.includes("Invalid profile")));
	assert.ok(result.warnings.some((warning) => warning.includes('missing model "missing"')));
});

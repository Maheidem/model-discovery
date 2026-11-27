import assert from "node:assert/strict";
import test from "node:test";
import {
	buildDiagnosticsLines,
	buildHomeItems,
	buildHomeSummary,
	formatDiscoveryStatus,
	sourceAvailability,
	summarizeSources,
} from "../extensions/ui-model.ts";
import type { DiscoveredProvider } from "../extensions/storage.ts";
import { describeFamilyRegistry, loadBundledFamilies } from "../extensions/family-store.ts";
import { resolveModel } from "../extensions/model-plan.ts";
import { extractModelConfig, ENRICH_KEY } from "../extensions/providers.ts";
import { frameHeight } from "@maheidem/pi-panel-kit";
import {
	buildEndpointSnapshot,
	buildModelSnapshot,
	buildPresetSnapshot,
	buildPresetsSnapshot,
	buildRoutingSnapshot,
	describeThinkingProfile,
	MODEL_PANEL_ROWS,
	PRESET_FIELD_ORDER,
	PRESETS_PANEL_ROWS,
	type ModelPanelModel,
} from "../extensions/ui/endpoint-panel.ts";

const providers: DiscoveredProvider[] = [
	{
		name: "ready",
		baseUrl: "http://localhost:8080",
		serverType: "oMLX",
		apiKey: "never-render-this-secret",
		cachedModels: [{ id: "qwen" }],
		lastScanned: 1,
	},
	{
		name: "cached",
		baseUrl: "http://localhost:8081",
		serverType: "llama.cpp",
		apiKey: "never-render-this-secret",
		cachedModels: [{ id: "one" }, { id: "two" }],
		lastScanError: "connection refused for never-render-this-secret",
	},
	{
		name: "down",
		baseUrl: "http://localhost:8082",
		lastScanError: "unreachable",
	},
];

test("home model progressively discloses health and actions", () => {
	assert.deepEqual(sourceAvailability(providers[0]), "ready");
	assert.deepEqual(sourceAvailability(providers[1]), "degraded");
	assert.deepEqual(sourceAvailability(providers[2]), "unavailable");
	assert.deepEqual(summarizeSources(providers), {
		sourceCount: 3,
		modelCount: 3,
		readyCount: 1,
		degradedCount: 1,
		unavailableCount: 1,
		unscannedCount: 0,
	});
	assert.match(buildHomeSummary(providers).join("\n"), /1 ready · 1 cached · 1 unavailable/);
	const items = buildHomeItems(providers);
	assert.deepEqual(items.slice(-4).map((item) => item.value), ["add", "rescan-all", "diagnostics", "quit"]);
	assert.equal(buildHomeItems([])[0]?.value, "add");
});

test("status and diagnostics are useful but secret-safe", () => {
	const status = formatDiscoveryStatus(providers, { storagePath: "/tmp/home/.pi/agent/model-discovery.json", home: "/tmp/home" });
	assert.match(status, /^Model Discovery/m);
	assert.match(status, /Storage: ~\/\.pi\/agent\/model-discovery\.json/);
	assert.match(status, /cached\/degraded/);
	assert.doesNotMatch(status, /never-render-this-secret/);
	const diagnostics = buildDiagnosticsLines(providers).join("\n");
	assert.match(diagnostics, /authentication: API key configured/);
	assert.match(diagnostics, /latest error: connection refused/);
	assert.doesNotMatch(diagnostics, /never-render-this-secret/);
});

test("empty home makes the primary action obvious", () => {
	assert.deepEqual(buildHomeSummary([]), [
		"No sources configured",
		"Add a source to discover models from a local OpenAI-compatible endpoint.",
	]);
	assert.match(formatDiscoveryStatus([], { storagePath: "/tmp/config", home: "/tmp/home" }), /No sources configured/);
});

// ---------------------------------------------------------------------------
// Model families on the screens
// ---------------------------------------------------------------------------

const registry = loadBundledFamilies();

/** The model panel input that the host makes from `resolveModel()`. */
function panelModel(raw: Record<string, unknown>, serverType: string, override: Record<string, unknown> = {}): ModelPanelModel {
	const config = extractModelConfig(raw);
	const resolved = resolveModel({ modelOverrides: { [config.id]: override } }, config, registry, serverType);
	return {
		id: config.id,
		flags: "",
		serverContextWindow: config.contextWindow,
		serverMaxTokens: config.maxTokens,
		contextWindow: resolved.contextWindow,
		contextWindowSource: resolved.contextWindowSource,
		maxTokens: resolved.maxTokens,
		maxTokensSource: resolved.maxTokensSource,
		reasoning: resolved.reasoning,
		reasoningSource: resolved.reasoningSource,
		reasoningSetting: override.reasoning === undefined ? "auto" : override.reasoning ? "on" : "off",
		vision: resolved.vision,
		visionSource: resolved.visionSource,
		visionSetting: override.input === undefined ? "auto" : (override.input as string[]).includes("image") ? "on" : "off",
		familyLabel: resolved.family?.label,
		familySource: resolved.familySource,
		familySetting: (override.family as string | undefined) ?? "auto",
		familyChoices: registry.families.map((family) => family.id),
		thinking: resolved.thinking,
		audio: resolved.audio,
		tools: resolved.tools,
		defaultsOn: resolved.defaultsOn,
		hasDefaults: resolved.defaults !== undefined,
		hidden: resolved.hidden,
		kind: resolved.kind,
		reportSource: config.source,
		presetCount: 0,
		routingSummary: "not configured",
		overridden: Object.keys(override).length > 0,
	};
}

function modelPanelText(model: ModelPanelModel) {
	const built = buildModelSnapshot({ version: "0.0.0", sourceName: "local", model });
	const rows = Object.fromEntries(built.snapshot.sections.flatMap((section) => section.rows).map((row) => [row.key, row]));
	return { built, rows, lines: [...(built.snapshot.summaryLines ?? []), ...(built.snapshot.detailLines ?? [])].join("\n") };
}

test("the model panel shows the family, the thinking profile and the source of each value", () => {
	const qwen = panelModel(
		{
			id: "Qwen3.8-27B",
			owned_by: "omlx",
			[ENRICH_KEY]: { modelType: "vlm", vision: true, hasThinkingReport: true, thinkingDefault: true, preserveThinkingDefault: true, reasoningEfforts: ["low", "medium", "xhigh"] },
		},
		"oMLX",
	);
	const { built, rows, lines } = modelPanelText(qwen);
	assert.equal(frameHeight(built.snapshot), MODEL_PANEL_ROWS);
	assert.match(lines, /family: Qwen 3\.8 \(name\) \[tools\]/);
	assert.match(lines, /thinking: switch \+ efforts low, medium, xhigh · preserve · from server/);
	assert.equal(rows["model:Qwen3.8-27B:vision"].value, "yes (server)");
	assert.equal(rows["model:Qwen3.8-27B:reasoning"].value, "on (server)");
	assert.equal(rows["model:Qwen3.8-27B:family"].value, "Qwen 3.8 (name)");
	assert.equal(rows["model:Qwen3.8-27B:defaults"].value, "on · Qwen 3.8");
	assert.equal(rows["model:Qwen3.8-27B:hidden"].value, "no · kind chat");
	// The reasoning row and the vision row cycle on, off, auto. The stored setting is the raw value.
	for (const key of ["model:Qwen3.8-27B:vision", "model:Qwen3.8-27B:reasoning"]) {
		assert.equal(rows[key].kind, "cycle");
		assert.deepEqual(rows[key].choices, ["on", "off", "auto"]);
		assert.equal(rows[key].rawValue, "auto");
	}
	assert.deepEqual(rows["model:Qwen3.8-27B:family"].choices?.slice(0, 2), ["auto", "qwen3.8"]);
	assert.equal(rows["model:Qwen3.8-27B:family"].choices?.at(-1), "none");
});

test("the model panel shows a server fact that wins over the family, and a user setting that wins over the server", () => {
	// llama.cpp `/props` says that the loaded Gemma 4 has no vision part.
	const raw = { id: "gemma-4-e4b-it", [ENRICH_KEY]: { vision: false } };
	const server = modelPanelText(panelModel(raw, "llama.cpp"));
	assert.equal(server.rows["model:gemma-4-e4b-it:vision"].value, "no (server)");
	assert.match(server.lines, /family: Gemma 4 \(name\) \[audio\] \[tools\]/);
	assert.match(server.lines, /thinking: switch only · from family/);
	assert.equal(frameHeight(server.built.snapshot), MODEL_PANEL_ROWS);

	const forced = modelPanelText(panelModel(raw, "llama.cpp", { input: ["text", "image"], reasoning: false, family: "gemma4" }));
	assert.equal(forced.rows["model:gemma-4-e4b-it:vision"].value, "yes (your setting)");
	assert.equal(forced.rows["model:gemma-4-e4b-it:vision"].rawValue, "on");
	assert.equal(forced.rows["model:gemma-4-e4b-it:reasoning"].value, "off (your setting)");
	assert.equal(forced.rows["model:gemma-4-e4b-it:reasoning"].rawValue, "off");
	assert.equal(forced.rows["model:gemma-4-e4b-it:family"].value, "Gemma 4 (your setting)");

	const family = modelPanelText(panelModel({ id: "gemma-4-31b" }, "OpenAI-compatible"));
	assert.equal(family.rows["model:gemma-4-31b:vision"].value, "yes (family)");
});

test("the model panel shows a model with no family and a hidden model", () => {
	const plain = modelPanelText(panelModel({ id: "plain-model" }, "OpenAI-compatible", { family: "none" }));
	assert.match(plain.lines, /family: none \(your setting\)/);
	assert.match(plain.lines, /thinking: none/);
	assert.equal(plain.rows["model:plain-model:defaults"].disabled, true);
	assert.equal(frameHeight(plain.built.snapshot), MODEL_PANEL_ROWS);

	const hidden = modelPanelText(panelModel({ id: "embeddinggemma-2", model_type: "embedding" }, "oMLX"));
	assert.equal(hidden.rows["model:embeddinggemma-2:hidden"].value, "yes · kind embedding");
	assert.equal(hidden.rows["model:embeddinggemma-2:family"].value, "none");

	assert.equal(
		describeThinkingProfile({ toggle: false, efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], preserveThinking: false, source: "server" }),
		"efforts none…max · from server",
	);
});

test("the source panel lists hidden models after the other models, with the kind", () => {
	const built = buildEndpointSnapshot({
		version: "0.0.0",
		source: { name: "local", baseUrl: "http://localhost:8080", serverType: "oMLX", online: true, modelCount: 3, cachedCount: 3, hasApiKey: false },
		models: [
			{ id: "Qwen3-ASR", flags: "", summary: "s", presetCount: 0, hiddenKind: "speech-to-text" },
			{ id: "embeddinggemma-2", flags: "", summary: "s", presetCount: 0, hiddenKind: "embedding" },
			{ id: "Qwen3.8-27B", flags: " [vision]", summary: "s", presetCount: 0 },
		],
	});
	assert.deepEqual(
		built.snapshot.sections[0].rows.map((row) => row.label),
		["Qwen3.8-27B [vision]", "Qwen3-ASR · hidden (speech-to-text)", "embeddinggemma-2 · hidden (embedding)"],
	);
});

test("the presets panel has the row for the recommended presets, and arms it when it replaces a preset", () => {
	const base = { version: "0.0.0", sourceName: "local", modelId: "m", presets: [], routingSummary: "not configured" };
	const key = "preset:m:defaults";
	const rowOf = (input: Parameters<typeof buildPresetsSnapshot>[0]) => {
		const built = buildPresetsSnapshot(input);
		assert.equal(frameHeight(built.snapshot), PRESETS_PANEL_ROWS);
		return { row: built.snapshot.sections[1].rows.find((row) => row.key === key), detail: built.snapshot.detailLines?.[0] };
	};
	const none = rowOf(base);
	assert.equal(none.row?.disabled, true);
	assert.match(none.row?.value ?? "", /no thinking control/);

	const defaults = { label: "Qwen 3.8", presetCount: 4, aliasSlug: "adaptive", replaces: [] as string[] };
	const free = rowOf({ ...base, defaults });
	assert.equal(free.row?.label, "Customize recommended presets");
	assert.equal(free.row?.value, "copy 4 preset(s) of Qwen 3.8 ›");
	assert.equal(
		free.detail,
		"Copy the recommended presets of Qwen 3.8 into your config and turn on the @adaptive alias. You can then edit them.",
	);

	const replaces = { ...defaults, replaces: ["instruct"] };
	assert.match(rowOf({ ...base, defaults: replaces }).row?.value ?? "", /^arm… · replace "instruct"/);
	assert.match(rowOf({ ...base, defaults: replaces, armed: [key] }).row?.value ?? "", /press again · replace "instruct"/);
});

test("the preset editor offers only the thinking values that the model accepts", () => {
	const fields = Object.fromEntries(PRESET_FIELD_ORDER.map((field) => [field, ""])) as Record<(typeof PRESET_FIELD_ORDER)[number], string>;
	const base = { version: "0.0.0", sourceName: "local", modelId: "m", handle: "p", fields, aliasId: "m@p", exposeAsModel: true, issues: [], isNew: true };
	const rowsOf = (input: Parameters<typeof buildPresetSnapshot>[0]) =>
		Object.fromEntries([0, 1].flatMap((page) => buildPresetSnapshot({ ...input, page }).snapshot.sections[0].rows).map((row) => [row.key, row]));

	const unknown = rowsOf(base);
	assert.deepEqual(unknown["cfg:preset:m:p:reasoning_effort"].choices, ["", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);

	const qwen = rowsOf({ ...base, effortChoices: ["low", "medium", "xhigh"], hasToggle: true });
	assert.deepEqual(qwen["cfg:preset:m:p:reasoning_effort"].choices, ["", "low", "medium", "xhigh"]);
	assert.deepEqual(qwen["cfg:preset:m:p:enable_thinking"].choices, ["", "true", "false"]);

	// Inkling: efforts and no switch. Gemma 4: a switch and no effort.
	assert.equal(rowsOf({ ...base, effortChoices: ["none", "max"], hasToggle: false })["cfg:preset:m:p:enable_thinking"].disabled, true);
	assert.equal(rowsOf({ ...base, effortChoices: [], hasToggle: true })["cfg:preset:m:p:reasoning_effort"].disabled, true);

	// A stored value that the model does not accept stays visible. The user can remove it.
	const stale = rowsOf({ ...base, fields: { ...fields, reasoning_effort: "xhigh" }, effortChoices: ["low"], hasToggle: true });
	assert.deepEqual(stale["cfg:preset:m:p:reasoning_effort"].choices, ["", "low", "xhigh"]);
});

test("the routing panel names the preset kinds of the model", () => {
	const levels = { off: "", minimal: "", low: "", medium: "", high: "", xhigh: "", max: "" };
	const base = { version: "0.0.0", sourceName: "local", modelId: "m", aliasSlug: "adaptive", aliasId: "m@adaptive", enabled: true, levels, choices: [], issues: [] };
	const valueOf = (input: Parameters<typeof buildRoutingSnapshot>[0]) =>
		buildRoutingSnapshot(input).snapshot.sections[1].rows.find((row) => row.key === "routing:m:conventional")?.value;
	assert.equal(valueOf(base), "off/low/medium/xhigh → 7 levels");
	assert.equal(valueOf({ ...base, conventionalKinds: ["off", "on"] }), "off/on → 7 levels");
});

test("the doctor report has the family data lines", () => {
	const lines = buildDiagnosticsLines([], describeFamilyRegistry(registry));
	const text = lines.join("\n");
	assert.match(text, /Model family data\n  Family data layer: bundled\n  Revision: \d+\n  Updated: \d{4}-\d{2}-\d{2}/);
	assert.match(text, /Families: 9/);
	assert.match(buildDiagnosticsLines([], ["Rejected qwen3.8.json: bad"]).join("\n"), /Rejected qwen3\.8\.json: bad/);
});

/**
 * ui/endpoint-panel.ts — panel-native snapshots for the source → model →
 * preset → routing drill-down (slice 1b, `.planning/ui-alignment-2026-09-08`
 * §5/§7). Decision D1 retired `ui/wizard-shell.ts`, so these builders plus
 * `ui/home.ts` are the whole visual grammar of this extension.
 *
 * CONTRACT — every builder here is PURE:
 *   • no storage reads, no network, no `index.ts` import, no `ctx`;
 *   • the host (`index.ts`) hands in already-loaded domain state, so every
 *     screen is testable without a TTY and without touching `$HOME`;
 *   • every frame is FIXED HEIGHT at every width (`*_PANEL_ROWS`), padded
 *     INSIDE the border by `padToFrame` and windowed by `pageRows`: a growing
 *     catalogue shrinks the window, never the frame, never the footer;
 *   • builders return `BuiltPanel` so the host can page without re-deriving
 *     the arithmetic (one source of truth for the window, still in this file);
 *   • destructive rows are ARM-THEN-CONFIRM and always NAME the affected
 *     object (source name / preset slug / model id) — never a bare "remove";
 *   • secrets render as `configured`/`anonymous`/`••••`, never as a value, and
 *     are typed only in `ui/secret-field.ts` (a panel `input` row echoes).
 *
 * ROW KEY GRAMMAR (mirrors `tests/fixtures/discover-actions.ts`; `<…>` is
 * substituted at render):
 *   `source:<name>`                       open the source panel
 *   `source:<name>:rescan`              refetch + re-register
 *   `cfg:source:<name>:name`            input  → renameSource
 *   `cfg:source:<name>:apiKey`          masked field → setCredential
 *   `cfg:source:<name>:apiKey:clear`    arm    → setCredential(undefined)
 *   `cfg:source:<name>:defaultContextWindow|defaultMaxTokens` input → saveSource
 *   `source:<name>:remove`              arm    → removeSource
 *   `model:<id>`                        open model detail (also the picker key)
 *   `model:<id>:contextWindow|maxTokens`  input  → saveSource override
 *   `model:<id>:reasoning|vision`      toggle → saveSource override
 *   `model:<id>:clear`                 arm     → drop the overrides of <id>
 *   `model:<id>:presets`               preset list for <id>
 *   `preset:<modelId>:<slug>`          preset editor — storage reality is
 *                                      `provider.modelProfiles[modelId][]`, so a slug
 *                                      is never addressable without its model
 *   `cfg:preset:<modelId>:<handle>:<field>` · `preset:<modelId>:<handle>:save|clone|remove`
 *   `routing:<modelId>:level:<level>` cycle · `cfg:routing:<modelId>:alias` input ·
 *   `routing:<modelId>:enabled|conventional|save|remove`
 *   `back` · `page:prev` / `page:next`
 *
 * `<handle>` is the slug a preset had WHEN THE EDITOR OPENED. Renaming a draft
 * must not repaint every row key under the cursor, so the editor keys stay
 * stable and only the Save row writes the new slug.
 */

import { formatAge } from "./home.ts";
import { pageRows, padToFrame, type RowPage } from "./panel-frame.ts";
import type { PanelRow, PanelShortcut, PanelSnapshot, PanelValueStyle } from "./settings-panel.ts";

/** Fixed frame height — source detail. */
export const ENDPOINT_PANEL_ROWS = 23;
/** Fixed frame height — model detail. */
export const MODEL_PANEL_ROWS = 23;
/** Fixed frame height — source picker (browse / "pick a source"). */
export const SOURCE_PICKER_PANEL_ROWS = 23;
/** Fixed frame height — model picker ("pick a model" before presets/routing). */
export const MODEL_PICKER_PANEL_ROWS = 23;
/** Fixed frame height — preset list. */
export const PRESETS_PANEL_ROWS = 23;
/** Fixed frame height — preset editor. */
export const PRESET_PANEL_ROWS = 23;
/** Fixed frame height — adaptive routing editor. */
export const ROUTING_PANEL_ROWS = 23;

/** Key of the "return to the parent surface" row on every secondary panel. */
export const BACK_KEY = "back";

/** A rendered snapshot plus the window facts the host needs to page it. */
export interface BuiltPanel {
	snapshot: PanelSnapshot;
	/** 0-based page currently rendered. */
	page: number;
	/** Total pages (1 when the whole list fits). */
	pages: number;
}

/** `null` is "the server never said" — rendered `?`, never guessed. */
function num(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "?";
	return value.toLocaleString("en-US");
}

/** Arm-then-confirm wording: the second press must name the object it destroys. */
export function armCell(key: string, object: string, armed: readonly string[]): { value: string; style: PanelValueStyle } {
	return armed.includes(key)
		? { value: `⚠ press again · ${object}`, style: "error" }
		: { value: `arm… · ${object}`, style: "warning" };
}

/** Rows the host must arm before the second press is allowed to write. */
export const DESTRUCTIVE_SUFFIXES = [":remove", ":clear"] as const;

/** True when a key destroys stored state and therefore needs two presses. */
export function isDestructiveKey(key: string): boolean {
	return DESTRUCTIVE_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// source picker (home `browse`, and the first step of presets/routing)
// ---------------------------------------------------------------------------

export interface SourcePickerInput {
	version: string;
	sources: readonly { name: string; baseUrl: string; serverType: string; modelCount: number; availability: string; presetCount: number }[];
	/** What the user is picking, shown in the subtitle: "to browse", "for presets"… */
	purpose: string;
	page?: number;
}

export function buildSourcePickerSnapshot(input: SourcePickerInput): BuiltPanel {
	const shortcuts: PanelShortcut[] = [
		{ key: "a", label: "add source", action: "source:add" },
		{ key: "q", label: "back", action: BACK_KEY },
	];
	const actions: PanelRow[] = [
		{ key: "source:add", label: "Add provider…", value: "+ OpenAI-compatible endpoint", kind: "action" },
		{ key: BACK_KEY, label: "Back to Model Discovery", value: "esc", kind: "action", valueStyle: "muted" },
	];
	const chrome = 1 + 2 + 2 + actions.length + 1 + (shortcuts.length ? 1 : 0) + 1 + 1;
	const window: RowPage = pageRows(
		input.sources.map((source): PanelRow => ({
			key: `source:${source.name}`,
			label: source.name,
			value: `${source.availability} · ${source.serverType} · ${source.modelCount} model(s) · ${source.presetCount} preset(s) ›`,
			kind: "action",
			valueStyle: source.availability === "unavailable" ? "error" : source.availability === "degraded" ? "warning" : "muted",
		})),
		Math.max(1, SOURCE_PICKER_PANEL_ROWS - chrome),
		input.page ?? 0,
	);
	return {
		snapshot: padToFrame(
			{
				title: `Sources · ${input.purpose}`,
				summaryLines: [`Model Discovery v${input.version}`, `${input.sources.length} configured source(s) · ${input.purpose}`],
				sections: [
					{ title: `Sources (${input.sources.length})`, rows: window.rows },
					{ title: "Actions", rows: actions },
				],
				detailLines: ["newest scan first · enter opens", `page ${window.page + 1}/${window.pages}`],
				idleMessage: input.sources.length ? `pick a source ${input.purpose}` : "no sources yet · a adds one",
				shortcuts,
			},
			SOURCE_PICKER_PANEL_ROWS,
		),
		page: window.page,
		pages: window.pages,
	};
}

// ---------------------------------------------------------------------------
// model picker (second step of presets/routing)
// ---------------------------------------------------------------------------

export interface ModelPickerInput {
	version: string;
	sourceName: string;
	purpose: string;
	models: readonly { id: string; flags: string; summary: string; presetCount: number; routingSummary: string }[];
	page?: number;
}

export function buildModelPickerSnapshot(input: ModelPickerInput): BuiltPanel {
	const actions: PanelRow[] = [{ key: BACK_KEY, label: "Back to sources", value: "esc", kind: "action", valueStyle: "muted" }];
	const chrome = 1 + 2 + 2 + actions.length + 1 + 1 + 1 + 1;
	const window: RowPage = pageRows(
		input.models.map((model): PanelRow => ({
			key: `model:${model.id}`,
			label: `${model.id}${model.flags}`,
			value: `${model.summary} · ${model.presetCount} preset(s) · ${model.routingSummary} ›`,
			kind: "action",
			valueStyle: "muted",
		})),
		Math.max(1, MODEL_PICKER_PANEL_ROWS - chrome),
		input.page ?? 0,
	);
	return {
		snapshot: padToFrame(
			{
				title: `Models · ${input.purpose}`,
				summaryLines: [`Model Discovery v${input.version} · source ${input.sourceName}`, `${input.models.length} model(s) · ${input.purpose}`],
				sections: [
					{ title: `Models (${input.models.length})`, rows: window.rows },
					{ title: "Actions", rows: actions },
				],
				detailLines: [`page ${window.page + 1}/${window.pages}`, "the base model is never changed by a preset or a route"],
				idleMessage: `pick a model ${input.purpose}`,
				shortcuts: [{ key: "q", label: "back", action: BACK_KEY }],
			},
			MODEL_PICKER_PANEL_ROWS,
		),
		page: window.page,
		pages: window.pages,
	};
}

// ---------------------------------------------------------------------------
// source panel
// ---------------------------------------------------------------------------

/** Flattened source header. The host reads storage; this module derives rows. */
export interface EndpointPanelSource {
	name: string;
	baseUrl: string;
	serverType: string;
	online: boolean;
	/** Models offered right now (live when online, cached otherwise). */
	modelCount: number;
	/** Models retained from the last known-good scan. */
	cachedCount: number;
	hasApiKey: boolean;
	lastScanned?: number;
	/** Already redacted by the host — this module never receives a credential. */
	lastScanError?: string;
	defaultContextWindow?: number | null;
	defaultMaxTokens?: number | null;
}

/** One catalogue entry as the source panel shows it. */
export interface EndpointPanelModel {
	id: string;
	flags: string;
	summary: string;
	presetCount: number;
}

export interface EndpointPanelInput {
	version: string;
	source: EndpointPanelSource;
	models: readonly EndpointPanelModel[];
	page?: number;
	armed?: readonly string[];
}

/** Source actions: rescan · rename · API key (masked) · clear key · fallbacks · remove · back. */
export function endpointActionRows(source: EndpointPanelSource, armed: readonly string[] = []): PanelRow[] {
	const clearKey = `cfg:source:${source.name}:apiKey:clear`;
	const removeKey = `source:${source.name}:remove`;
	return [
		{ key: `source:${source.name}:rescan`, label: "Re-scan source", value: "↻ refetch + re-register", kind: "action" },
		{
			key: `cfg:source:${source.name}:name`,
			label: "Rename source",
			value: source.name,
			rawValue: source.name,
			kind: "input",
			inputHint: `New name for source "${source.name}" · Enter saves · Esc cancels`,
		},
		{
			key: `cfg:source:${source.name}:apiKey`,
			label: "API key",
			value: source.hasApiKey ? "•••• configured" : "enter a key (masked)",
			valueStyle: source.hasApiKey ? "success" : "muted",
			kind: "action",
		},
		{
			key: clearKey,
			label: "Clear API key",
			value: source.hasApiKey ? armCell(clearKey, `the key on "${source.name}"`, armed).value : "anonymous · nothing to clear",
			valueStyle: source.hasApiKey ? "warning" : "muted",
			kind: source.hasApiKey ? "action" : "info",
			disabled: !source.hasApiKey,
		},
		{
			key: `cfg:source:${source.name}:defaultContextWindow`,
			label: "Fallback context window",
			value: num(source.defaultContextWindow),
			rawValue: source.defaultContextWindow == null ? "" : String(source.defaultContextWindow),
			kind: "input",
			inputHint: `Fallback for source "${source.name}" when the server reports nothing · whole number > 0`,
		},
		{
			key: `cfg:source:${source.name}:defaultMaxTokens`,
			label: "Fallback max output",
			value: num(source.defaultMaxTokens),
			rawValue: source.defaultMaxTokens == null ? "" : String(source.defaultMaxTokens),
			kind: "input",
			inputHint: `Fallback for source "${source.name}" when the server reports nothing · whole number > 0`,
		},
		{ key: removeKey, label: "Remove source", ...armCell(removeKey, `remove "${source.name}"`, armed), kind: "action" },
		{ key: BACK_KEY, label: "Back to Model Discovery", value: "esc", kind: "action", valueStyle: "muted" },
	];
}

export function buildEndpointSnapshot(input: EndpointPanelInput): BuiltPanel {
	const armed = input.armed ?? [];
	const s = input.source;
	const summaryLines = [
		`Model Discovery v${input.version} · ${s.online ? "online" : "OFFLINE"}`,
		`${s.baseUrl} · ${s.online ? `${s.modelCount} live model(s)` : `${s.cachedCount} cached model(s)`}`,
		`authentication: ${s.hasApiKey ? "API key configured (never shown)" : "anonymous"}`,
	];
	const detailLines = [
		`last scan ${formatAge(s.lastScanned)} · presets and the last known-good catalogue stay saved`,
		s.online ? "catalogue is live" : `⚠ ${s.lastScanError ?? "no live scan succeeded"}`,
	];
	const actions = endpointActionRows(s, armed);
	const shortcuts: PanelShortcut[] = [
		{ key: "r", label: "rescan", action: `source:${s.name}:rescan` },
		{ key: "a", label: "API key", action: `cfg:source:${s.name}:apiKey` },
		{ key: "q", label: "back", action: BACK_KEY },
	];
	const chrome = 1 + summaryLines.length + 2 + actions.length + detailLines.length + 1 + (shortcuts.length ? 1 : 0) + 1 + 1;
	const window: RowPage = pageRows(
		input.models.map((model): PanelRow => ({
			key: `model:${model.id}`,
			label: `${model.id}${model.flags}`,
			value: `${model.summary}${model.presetCount ? ` · ${model.presetCount} preset(s)` : ""} ›`,
			kind: "action",
			valueStyle: "muted",
		})),
		Math.max(1, ENDPOINT_PANEL_ROWS - chrome),
		input.page ?? 0,
	);
	return {
		snapshot: padToFrame(
			{
				title: `Source: ${s.name}`,
				summaryLines,
				sections: [
					{ title: `Models · ${s.online ? "live" : "cached"} ${s.modelCount}`, rows: window.rows },
					{ title: "Source", rows: actions },
				],
				detailLines,
				idleMessage: `page ${window.page + 1}/${window.pages} · enter opens a model`,
				shortcuts,
			},
			ENDPOINT_PANEL_ROWS,
		),
		page: window.page,
		pages: window.pages,
	};
}

// ---------------------------------------------------------------------------
// model panel
// ---------------------------------------------------------------------------

export interface ModelPanelModel {
	id: string;
	flags: string;
	serverContextWindow: number | null;
	serverMaxTokens: number | null;
	serverReasoning: boolean | null;
	serverInput: readonly string[];
	effectiveContextWindow: number | null;
	effectiveMaxTokens: number | null;
	effectiveReasoning: boolean | null;
	effectiveInput: readonly string[];
	reportSource: string;
	presetCount: number;
	routingSummary: string;
	overridden: boolean;
}

export interface ModelPanelInput {
	version: string;
	sourceName: string;
	model: ModelPanelModel;
	armed?: readonly string[];
}

/** `effective · server reported` on one line, so an override never looks ineffective. */
export function modelOverrideRows(model: ModelPanelModel): PanelRow[] {
	const vision = model.effectiveInput.includes("image");
	return [
		{
			key: `model:${model.id}:contextWindow`,
			label: "Context window",
			value: `${num(model.effectiveContextWindow)} · server ${num(model.serverContextWindow)}`,
			rawValue: model.effectiveContextWindow === null ? "" : String(model.effectiveContextWindow),
			kind: "input",
			inputHint: `Override the context window of model "${model.id}" · whole number > 0 · Esc cancels`,
		},
		{
			key: `model:${model.id}:maxTokens`,
			label: "Max output tokens",
			value: `${num(model.effectiveMaxTokens)} · server ${num(model.serverMaxTokens)}`,
			rawValue: model.effectiveMaxTokens === null ? "" : String(model.effectiveMaxTokens),
			kind: "input",
			inputHint: `Override the max output of model "${model.id}" · whole number > 0 · Esc cancels`,
		},
		{
			key: `model:${model.id}:reasoning`,
			label: "Reasoning",
			value: `${model.effectiveReasoning === null ? "unknown (server silent)" : model.effectiveReasoning ? "on" : "off"} · server ${
				model.serverReasoning === null ? "?" : model.serverReasoning ? "on" : "off"
			}`,
			rawValue: String(model.effectiveReasoning ?? false),
			kind: "toggle",
		},
		{
			key: `model:${model.id}:vision`,
			label: "Vision (image input)",
			value: `${vision ? "on" : "off"} · server ${model.serverInput.includes("image") ? "on" : "off"}`,
			rawValue: String(vision),
			kind: "toggle",
		},
	];
}

export function buildModelSnapshot(input: ModelPanelInput): BuiltPanel {
	const armed = input.armed ?? [];
	const m = input.model;
	const clearKey = `model:${m.id}:clear`;
	const overrides = modelOverrideRows(m);
	const actions: PanelRow[] = [
		{ key: `model:${m.id}:presets`, label: "Thinking & presets", value: `${m.presetCount} preset(s) ›`, kind: "action" },
		{ key: `routing:${m.id}`, label: "Adaptive routing", value: `${m.routingSummary} ›`, kind: "action" },
		{ key: clearKey, label: "Clear overrides", ...armCell(clearKey, `overrides on "${m.id}"`, armed), kind: "action" },
		{ key: BACK_KEY, label: "Back to source", value: "esc", kind: "action", valueStyle: "muted" },
	];
	const summaryLines = [
		`Model Discovery v${input.version} · source ${input.sourceName}`,
		`server reports: ctx ${num(m.serverContextWindow)} · max ${num(m.serverMaxTokens)} · reasoning ${
			m.serverReasoning === null ? "unknown" : m.serverReasoning ? "on" : "off"
		} · input ${m.serverInput.join("+") || "?"} · ${m.reportSource}`,
		`effective: ctx ${num(m.effectiveContextWindow)} · max ${num(m.effectiveMaxTokens)} · input ${m.effectiveInput.join("+") || "text"}${
			m.overridden ? " · overridden" : ""
		}`,
	];
	const shortcuts: PanelShortcut[] = [
		{ key: "p", label: "presets", action: `model:${m.id}:presets` },
		{ key: "v", label: "vision", action: `model:${m.id}:vision` },
		{ key: "q", label: "back", action: BACK_KEY },
	];
	const chrome = 1 + summaryLines.length + 2 + overrides.length + actions.length + 2 + 1 + (shortcuts.length ? 1 : 0) + 1 + 1;
	return {
		snapshot: padToFrame(
			{
				title: `Model: ${m.id}${m.flags}`,
				summaryLines,
				sections: [
					{ title: "Overrides", rows: overrides },
					{ title: "Actions", rows: actions },
				],
				detailLines: [`adaptive routing: ${m.routingSummary}`, "an override never hides the server value — both are printed"],
				idleMessage: `edits save immediately for model "${m.id}"`,
				shortcuts,
			},
			MODEL_PANEL_ROWS,
		),
		page: 0,
		pages: 1,
	};
}

// ---------------------------------------------------------------------------
// presets list
// ---------------------------------------------------------------------------

export interface PresetsPanelInput {
	version: string;
	sourceName: string;
	modelId: string;
	presets: readonly { slug: string; summary: string }[];
	routingSummary: string;
	page?: number;
}

export function buildPresetsSnapshot(input: PresetsPanelInput): BuiltPanel {
	const actions: PanelRow[] = [
		{ key: `preset:${input.modelId}:add`, label: "Create preset", value: "new thinking/sampling bundle", kind: "action" },
		{ key: `routing:${input.modelId}`, label: "Adaptive routing", value: `${input.routingSummary} ›`, kind: "action" },
		{ key: BACK_KEY, label: "Back to model", value: "esc", kind: "action", valueStyle: "muted" },
	];
	const shortcuts: PanelShortcut[] = [
		{ key: "n", label: "new preset", action: `preset:${input.modelId}:add` },
		{ key: "r", label: "routing", action: `routing:${input.modelId}` },
		{ key: "q", label: "back", action: BACK_KEY },
	];
	const chrome = 1 + 2 + 2 + actions.length + 2 + 1 + (shortcuts.length ? 1 : 0) + 1 + 1;
	const window: RowPage = pageRows(
		input.presets.map((preset): PanelRow => ({
			key: `preset:${input.modelId}:${preset.slug}`,
			label: preset.slug,
			value: `${preset.summary} ›`,
			kind: "action",
			valueStyle: "muted",
		})),
		Math.max(1, PRESETS_PANEL_ROWS - chrome),
		input.page ?? 0,
	);
	return {
		snapshot: padToFrame(
			{
				title: `Presets: ${input.modelId}`,
				summaryLines: [
					`Model Discovery v${input.version} · source ${input.sourceName}`,
					`${input.presets.length} preset(s) on model "${input.modelId}" · a preset never changes the base model`,
				],
				sections: [
					{ title: `Presets (${input.presets.length})`, rows: window.rows },
					{ title: "Actions", rows: actions },
				],
				detailLines: [`routing: ${input.routingSummary}`, `page ${window.page + 1}/${window.pages}`],
				idleMessage: "enter edits a preset · n creates · r routing",
				shortcuts,
			},
			PRESETS_PANEL_ROWS,
		),
		page: window.page,
		pages: window.pages,
	};
}

// ---------------------------------------------------------------------------
// preset editor
// ---------------------------------------------------------------------------

/** The editable knobs of a preset, in the order the editor shows them. */
export const PRESET_FIELD_ORDER = [
	"enable_thinking",
	"reasoning_effort",
	"preserve_thinking",
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"repetition_penalty",
	"presence_penalty",
	"frequency_penalty",
] as const;

export type PresetField = (typeof PRESET_FIELD_ORDER)[number];

/** The fixed vocabularies cycle; every other field is a free numeric input. */
export const PRESET_CHOICES: Partial<Record<PresetField, string[]>> = {
	enable_thinking: ["", "true", "false"],
	preserve_thinking: ["", "true", "false"],
	reasoning_effort: ["", "low", "medium", "xhigh"],
};

export interface PresetPanelInput {
	version: string;
	sourceName: string;
	modelId: string;
	/** Slug the editor was opened with; the row-key handle (stable while editing). */
	handle: string;
	/** Draft values shown on the rows; `""` = omitted (server/model default). */
	fields: Record<PresetField, string>;
	/** Model alias this preset registers, e.g. `qwen3:thinking-medium`. */
	aliasId: string;
	exposeAsModel: boolean;
	/** Human-readable problems with the draft; empty means valid. */
	issues: readonly string[];
	isNew: boolean;
	armed?: readonly string[];
	page?: number;
}

export function presetKey(modelId: string, handle: string): string {
	return `preset:${modelId}:${handle}`;
}

export function presetFieldKey(modelId: string, handle: string, field: PresetField | string): string {
	return `cfg:preset:${modelId}:${handle}:${field}`;
}

export function presetFieldRows(input: PresetPanelInput): PanelRow[] {
	return PRESET_FIELD_ORDER.map((field): PanelRow => {
		const raw = input.fields[field] ?? "";
		const choices = PRESET_CHOICES[field];
		return {
			key: presetFieldKey(input.modelId, input.handle, field),
			label: field,
			value: raw === "" ? "omitted (server/model default)" : raw,
			rawValue: raw,
			valueStyle: raw === "" ? "muted" : "text",
			choices: choices ? [...choices] : undefined,
			kind: choices ? "cycle" : "input",
			inputHint: choices
				? `${field}: enter cycles omitted → value · Esc cancels`
				: `${field}: submit blank to keep it omitted · Esc cancels`,
		};
	});
}

export function buildPresetSnapshot(input: PresetPanelInput): BuiltPanel {
	const armed = input.armed ?? [];
	const base = presetKey(input.modelId, input.handle);
	const saveKey = `${base}:save`;
	const actions: PanelRow[] = [
		{
			key: saveKey,
			label: "Save preset",
			value: input.issues.length ? `⚠ ${input.issues.length} issue(s) · blocked` : `save "${input.handle}"`,
			valueStyle: input.issues.length ? "warning" : "accent",
			kind: "action",
		},
		{
			key: presetFieldKey(input.modelId, input.handle, "slug"),
			label: "Preset name",
			value: input.handle,
			rawValue: input.handle,
			kind: "input",
			inputHint: `Rename preset "${input.handle}" of model "${input.modelId}" · lower-case slug · Esc cancels`,
		},
		{
			key: `${base}:expose`,
			label: "Show as fixed model in /model",
			value: input.exposeAsModel ? "visible" : "hidden (routing only)",
			rawValue: String(input.exposeAsModel),
			kind: "toggle",
		},
		{ key: `${base}:clone`, label: "Clone preset", value: `"${input.handle}-copy" ›`, kind: "action", valueStyle: "muted" },
		{ key: `${base}:remove`, label: "Remove preset", ...armCell(`${base}:remove`, `remove "${input.handle}" from "${input.modelId}"`, armed), kind: "action" },
		{ key: BACK_KEY, label: "Back to presets", value: "esc", kind: "action", valueStyle: "muted" },
	];
	const shortcuts: PanelShortcut[] = [
		{ key: "s", label: "save", action: saveKey },
		{ key: "q", label: "back", action: BACK_KEY },
	];
	const chrome = 1 + 3 + 2 + actions.length + 2 + 1 + (shortcuts.length ? 1 : 0) + 1 + 1;
	const fields: RowPage = pageRows(presetFieldRows(input), Math.max(1, PRESET_PANEL_ROWS - chrome), input.page ?? 0);
	return {
		snapshot: padToFrame(
			{
				title: `Preset: ${input.handle}${input.isNew ? " · new" : ""}`,
				summaryLines: [
					`Model Discovery v${input.version} · ${input.aliasId} → ${input.modelId}`,
					`model "${input.modelId}" · source ${input.sourceName}`,
					"edits stay a draft until Save · omitted values use the server/model default",
				],
				sections: [
					{ title: `Thinking + sampling (${Object.keys(input.fields).length})`, rows: fields.rows },
					{ title: "Actions", rows: actions },
				],
				detailLines: [input.issues.length ? `⚠ ${input.issues[0] ?? "invalid draft"}` : "draft is valid", `page ${fields.page + 1}/${fields.pages}`],
				idleMessage: input.issues.length ? "Save is blocked until every issue is fixed" : `Save writes preset "${input.handle}" on model "${input.modelId}"`,
				shortcuts,
			},
			PRESET_PANEL_ROWS,
		),
		page: fields.page,
		pages: fields.pages,
	};
}

// ---------------------------------------------------------------------------
// routing editor
// ---------------------------------------------------------------------------

export interface RoutingPanelInput {
	version: string;
	sourceName: string;
	modelId: string;
	aliasSlug: string;
	aliasId: string;
	enabled: boolean;
	/** Pi level → preset slug ("" = unmapped). */
	levels: Record<string, string>;
	/** Preset slugs a level may cycle through, in display order. */
	choices: readonly string[];
	issues: readonly string[];
	armed?: readonly string[];
	page?: number;
}

export function routingLevelRows(input: RoutingPanelInput): PanelRow[] {
	return Object.entries(input.levels).map(([level, slug]): PanelRow => ({
		key: `routing:${input.modelId}:level:${level}`,
		label: `Pi ${level}`,
		value: slug ? `→ ${slug}` : "not selected",
		rawValue: slug,
		choices: [...input.choices],
		valueStyle: slug ? "text" : "warning",
		kind: "cycle",
		disabled: input.choices.length === 0,
	}));
}

export function buildRoutingSnapshot(input: RoutingPanelInput): BuiltPanel {
	const armed = input.armed ?? [];
	const removeKey = `routing:${input.modelId}:remove`;
	const saveKey = `routing:${input.modelId}:save`;
	const levels = routingLevelRows(input);
	const actions: PanelRow[] = [
		{
			key: `routing:${input.modelId}:enabled`,
			label: "Adaptive routing",
			value: input.enabled ? "enabled" : "disabled · mapping retained",
			rawValue: String(input.enabled),
			kind: "toggle",
		},
		{
			key: `cfg:routing:${input.modelId}:alias`,
			label: "Adaptive alias",
			value: input.aliasSlug,
			rawValue: input.aliasSlug,
			kind: "input",
			inputHint: `Rename the adaptive alias of model "${input.modelId}" · Esc cancels`,
		},
		{ key: `routing:${input.modelId}:conventional`, label: "Map four-preset layout", value: "off/low/medium/xhigh → 7 levels", kind: "action" },
		{
			key: saveKey,
			label: "Save routing",
			value: input.issues.length ? `⚠ ${input.issues.length} issue(s) · blocked` : `save "${input.aliasId}"`,
			valueStyle: input.issues.length ? "warning" : "accent",
			kind: "action",
		},
		{ key: removeKey, label: "Remove adaptive routing", ...armCell(removeKey, `remove "${input.aliasId}" on "${input.modelId}"`, armed), kind: "action" },
		{ key: BACK_KEY, label: "Back to presets", value: "esc", kind: "action", valueStyle: "muted" },
	];
	const shortcuts: PanelShortcut[] = [
		{ key: "c", label: "conventional", action: `routing:${input.modelId}:conventional` },
		{ key: "s", label: "save", action: saveKey },
		{ key: "q", label: "back", action: BACK_KEY },
	];
	const chrome = 1 + 3 + 2 + actions.length + 2 + 1 + (shortcuts.length ? 1 : 0) + 1 + 1;
	return {
		snapshot: padToFrame(
			{
				title: `Adaptive routing: ${input.aliasSlug}`,
				summaryLines: [
					`Model Discovery v${input.version} · ${input.aliasId} → ${input.modelId}`,
					`adaptive Shift-Tab routing: ${input.enabled ? `enabled as @${input.aliasSlug}` : "disabled · mapping retained"}`,
					input.issues.length ? `⚠ ${input.issues[0] ?? "invalid mapping"}` : "only this alias changes presets · base + fixed aliases stay",
				],
				sections: [
					{ title: `Mapping · ${Object.keys(input.levels).length} Pi levels`, rows: levels.map((row) => ({ ...row })) },
					{ title: "Actions", rows: actions },
				],
				detailLines: [`source ${input.sourceName}`, "enter cycles a level through the available presets; Save writes the map"],
				idleMessage: input.choices.length
					? `enter cycles each level through ${input.choices.length} preset(s)`
					: "create at least one preset before mapping levels",
				shortcuts,
			},
			ROUTING_PANEL_ROWS,
		),
		page: 0,
		pages: 1,
	};
}

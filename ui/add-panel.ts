/**
 * ui/add-panel.ts — panel-native "add a source" screen (slice 1b,
 * `.planning/ui-alignment-2026-09-08` §5/§7, decision D1).
 *
 * The old flow was a chain of six wizard steps (URL → auth mode → secret →
 * probe → name → per-model numbers → register). Here it is ONE fixed-height
 * panel with two stages that share the same frame budget:
 *
 *   form    — URL input row, optional name row, optional API key row (masked,
 *             opens `ui/secret-field.ts`), fallback defaults, `Connect + probe`.
 *   review  — what the server actually reported, per model; edit a model or a
 *             fallback, then `Register` (one `BorderedLoader` connect step).
 *
 * PURE BUILDERS ONLY: the host owns the probe (`runLoader`) and the write
 * (`app.saveSource`), so nothing here touches the socket, the disk, or `ctx`,
 * and every stage is testable without a TTY.
 *
 * SECRETS: the key row renders `•••• configured` / `enter a key` and never the
 * value; the value is typed in `ui/secret-field.ts` and handed to the host,
 * because a panel `input` row echoes what you type.
 */

import { pageRows, padToFrame } from "./panel-frame.ts";
import { BACK_KEY } from "./endpoint-panel.ts";
import type { PanelRow, PanelShortcut, PanelSnapshot } from "./settings-panel.ts";

/** Fixed frame height — the form and the review stage both render this tall. */
export const ADD_PANEL_ROWS = 23;
/** Fixed frame height — the per-model editor inside the review stage. */
export const ADD_MODEL_PANEL_ROWS = 15;

export const ADD_URL_KEY = "cfg:add:url";
export const ADD_NAME_KEY = "cfg:add:name";
export const ADD_KEY_KEY = "cfg:add:apiKey";
export const ADD_SCAN_KEY = "add:scan";
export const ADD_REGISTER_KEY = "add:register";
export const ADD_FALLBACK_CTX_KEY = "cfg:add:defaultContextWindow";
export const ADD_FALLBACK_MAX_KEY = "cfg:add:defaultMaxTokens";

/** The draft the panel edits. The host owns the probe and the write. */
export interface AddDraft {
	url: string;
	name: string;
	hasKey: boolean;
	defaultContextWindow?: number | null;
	defaultMaxTokens?: number | null;
}

/** One probed catalogue entry, as the review stage shows it. */
export interface AddModel {
	id: string;
	flags: string;
	summary: string;
	/** True when the server stayed silent about ctx/max. */
	unreported: boolean;
}

export interface AddPanelInput {
	version: string;
	stage: "form" | "review";
	draft: AddDraft;
	/** Probed catalogue (review stage). Empty in the form stage. */
	models?: readonly AddModel[];
	/** Why the probe failed or is incomplete. Never a credential. */
	note?: string;
	/** Validation message on the URL row, host-provided. */
	urlError?: string;
	page?: number;
}

/** Review rows: one per probed model, unreported values flagged. */
export function addModelRows(models: readonly AddModel[]): PanelRow[] {
	return models.map((model): PanelRow => ({
		key: `add:model:${model.id}`,
		label: `${model.id}${model.flags}`,
		value: `${model.summary}${model.unreported ? " · ⚠ unreported" : ""} ›`,
		kind: "action",
		valueStyle: model.unreported ? "warning" : "muted",
	}));
}

function num(value: number | null | undefined): string {
	return value == null || !Number.isFinite(value) ? "?" : value.toLocaleString("en-US");
}

/** The rows that exist in both stages (URL/name/key are form-only in part). */
function addValueRows(input: AddPanelInput): PanelRow[] {
	return [
		{
			key: ADD_FALLBACK_CTX_KEY,
			label: "Fallback context window",
			value: num(input.draft.defaultContextWindow),
			rawValue: input.draft.defaultContextWindow == null ? "" : String(input.draft.defaultContextWindow),
			kind: "input",
			valueStyle: "muted",
			inputHint: "Used only for models the server reports nothing about · whole number > 0 · Esc cancels",
		},
		{
			key: ADD_FALLBACK_MAX_KEY,
			label: "Fallback max output",
			value: num(input.draft.defaultMaxTokens),
			rawValue: input.draft.defaultMaxTokens == null ? "" : String(input.draft.defaultMaxTokens),
			kind: "input",
			valueStyle: "muted",
			inputHint: "Used only for models the server reports nothing about · whole number > 0 · Esc cancels",
		},
	];
}

export function buildAddSnapshot(input: AddPanelInput): PanelSnapshot {
	const review = input.stage === "review";
	const models = input.models ?? [];
	const missing = models.filter((model) => model.unreported).length;
	const summaryLines = [
		`Model Discovery v${input.version} · ${review ? "review + register" : "add a source"}`,
		`register as "${input.draft.name || "?"}" · ${input.draft.url || "no URL yet"}`,
		`authentication: ${input.draft.hasKey ? "API key configured (never shown)" : "anonymous"}`,
	];
	const detailLines = review
		? [
				missing
					? `⚠ ${missing} model(s) have unreported values · set a fallback or edit the model`
					: "every model reported its values",
				input.note ?? "nothing is written until you Register",
			]
		: [
				input.note ?? "the key is sent as an Authorization: Bearer header · it is never printed",
				"nothing is written until the probe succeeds and you Register",
			];
	const shortcuts: PanelShortcut[] = review
		? [
				{ key: "s", label: "register", action: ADD_REGISTER_KEY },
				{ key: "r", label: "re-probe", action: ADD_SCAN_KEY },
				{ key: "q", label: "cancel", action: BACK_KEY },
			]
		: [
				{ key: "c", label: "connect", action: ADD_SCAN_KEY },
				{ key: "k", label: "API key", action: ADD_KEY_KEY },
				{ key: "q", label: "cancel", action: BACK_KEY },
			];
	const fixedRows: PanelRow[] = review
		? [
				{
					key: ADD_REGISTER_KEY,
					label: "Register source",
					value: `${models.length} model(s) as "${input.draft.name || "?"}"`,
					kind: "action",
					valueStyle: "accent",
				},
				{ key: ADD_SCAN_KEY, label: "Probe again", value: "↻ refetch the catalogue", kind: "action" },
				...addValueRows(input),
				{ key: BACK_KEY, label: "Cancel", value: "esc · nothing is saved", kind: "action", valueStyle: "muted" },
			]
		: [
				{
					key: ADD_URL_KEY,
					label: "Endpoint URL",
					value: input.urlError ? `⚠ ${input.urlError}` : input.draft.url || "required",
					rawValue: input.draft.url,
					kind: "input",
					valueStyle: input.urlError ? "warning" : "text",
					inputHint: "http://host:port or https://host — the /v1 suffix is added for you · Esc cancels",
				},
				{
					key: ADD_NAME_KEY,
					label: "Source name",
					value: input.draft.name || "optional · suggested from the URL",
					rawValue: input.draft.name,
					kind: "input",
					valueStyle: "muted",
					inputHint: "This name identifies the provider and its models in /model · Esc cancels",
				},
				{
					key: ADD_KEY_KEY,
					label: "API key",
					value: input.draft.hasKey ? "•••• configured" : "optional · enter masked",
					valueStyle: input.draft.hasKey ? "success" : "muted",
					kind: "action",
				},
				...addValueRows(input),
				{
					key: ADD_SCAN_KEY,
					label: "Connect + probe",
					value: input.draft.url ? "↻ fetch /v1/models" : "enter a URL first",
					kind: "action",
					valueStyle: input.draft.url ? "accent" : "muted",
					disabled: !input.draft.url,
				},
				{ key: BACK_KEY, label: "Cancel", value: "esc · nothing is saved", kind: "action", valueStyle: "muted" },
			];

	// Chrome is everything except the elastic Models window; the budget is what
	// is left, so the frame is exactly ADD_PANEL_ROWS in BOTH stages.
	const chrome =
		1 +
		summaryLines.length +
		2 /* two section headers */ +
		fixedRows.length +
		detailLines.length +
		1 /* message */ +
		(shortcuts.length ? 1 : 0) +
		1 /* navigation */ +
		1 /* bottom border */;
	const window = pageRows(addModelRows(models), Math.max(1, ADD_PANEL_ROWS - chrome), input.page ?? 0);
	return padToFrame(
		{
			title: review ? `Review: ${input.draft.name || input.draft.url}` : "Add source",
			summaryLines,
			sections: review
				? [
						{ title: `Server reported (${models.length})`, rows: window.rows },
						{ title: "Register", rows: fixedRows },
					]
				: [
						{ title: "Endpoint", rows: fixedRows },
						{ title: "Models", rows: window.rows },
					],
			detailLines,
			idleMessage: review
				? `page ${window.page + 1}/${window.pages} · enter edits a model · s registers`
				: "enter edits a row · c connects · esc cancels",
			shortcuts,
		},
		ADD_PANEL_ROWS,
	);
}

export interface AddModelPanelInput {
	version: string;
	draftName: string;
	model: {
		id: string;
		flags: string;
		serverContextWindow: number | null;
		serverMaxTokens: number | null;
		contextWindow: number | null;
		maxTokens: number | null;
	};
}

/** Per-model overrides inside the add flow (the source is not in storage yet). */
export function buildAddModelSnapshot(input: AddModelPanelInput): PanelSnapshot {
	const m = input.model;
	const rows: PanelRow[] = [
		{
			key: `cfg:add:model:${m.id}:contextWindow`,
			label: "Context window",
			value: `${num(m.contextWindow)} · server ${num(m.serverContextWindow)}`,
			rawValue: m.contextWindow == null ? "" : String(m.contextWindow),
			kind: "input",
			inputHint: `Override the context window of model "${m.id}" before registering · Esc cancels`,
		},
		{
			key: `cfg:add:model:${m.id}:maxTokens`,
			label: "Max output tokens",
			value: `${num(m.maxTokens)} · server ${num(m.serverMaxTokens)}`,
			rawValue: m.maxTokens == null ? "" : String(m.maxTokens),
			kind: "input",
			inputHint: `Override the max output of model "${m.id}" before registering · Esc cancels`,
		},
		{ key: BACK_KEY, label: "Back to review", value: "esc", kind: "action", valueStyle: "muted" },
	];
	return padToFrame(
		{
			title: `Model: ${m.id}${m.flags}`,
			summaryLines: [`Model Discovery v${input.version} · not registered yet`, `source "${input.draftName || "?"}" · edits apply on Register`],
			sections: [{ title: "Overrides", rows: rows }],
			detailLines: ["values stay in this panel until the source is registered"],
			idleMessage: `editing model "${m.id}" of a source that does not exist yet`,
			shortcuts: [{ key: "q", label: "back", action: BACK_KEY }],
		},
		ADD_MODEL_PANEL_ROWS,
	);
}

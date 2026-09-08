/**
 * Advanced configuration panel (pure builder).
 *
 * Home `Configure advanced…` lands here. It is deliberately maintenance-shaped:
 * global actions (re-scan everything, diagnostics, paths, verb cheat-sheet)
 * plus one entry per source into the endpoint panel, where the real config
 * fields live (`cfg:source:<name>:…`). This module never sees credentials —
 * the host passes `hasApiKey` only, same contract as the endpoint panel.
 *
 * Fixed frame (`ADVANCED_PANEL_ROWS`) so the composer never moves; sources
 * window through the shared `pageRows` controls and never grow the frame.
 */
import { pageRows, padToFrame } from "./panel-frame.ts";
import { BACK_KEY } from "./endpoint-panel.ts";
import type { PanelRow, PanelShortcut, PanelSnapshot } from "./settings-panel.ts";

/** Fixed frame height — advanced config hub. */
export const ADVANCED_PANEL_ROWS = 23;

export interface AdvancedPanelSource {
	name: string;
	serverType: string;
	hasApiKey: boolean;
	cachedCount: number;
}

export interface AdvancedPanelInput {
	version: string;
	/** Already redacted (`~/.pi/...`) — the host formats the path. */
	storagePath: string;
	sources: readonly AdvancedPanelSource[];
	/** Optional storage warning from `getStorageDiagnostic()`. */
	notes?: readonly string[];
	page?: number;
}

export const ADVANCED_MAINTENANCE_ROWS: PanelRow[] = [
	{ key: "rescan-all", label: "Re-scan every source", value: "↻ refetch + re-register all", kind: "action" },
	{ key: "doctor", label: "Diagnostics", value: "actionable health report ›", kind: "action" },
	{ key: "paths", label: "Storage location", value: "show file path ›", kind: "action" },
	{ key: "help-verbs", label: "Command reference", value: "every nested /discover verb ›", kind: "action" },
];

export function advancedSourceRows(sources: readonly AdvancedPanelSource[]): PanelRow[] {
	return sources.map(
		(source): PanelRow => ({
			key: `cfg:source:${source.name}:advanced`,
			label: source.name,
			value: `${source.serverType} · ${source.hasApiKey ? "key ••••" : "anonymous"} · ${source.cachedCount} cached · rename/fallbacks/key ›`,
			kind: "action",
			valueStyle: "muted",
		}),
	);
}

const ADVANCED_SHORTCUTS: PanelShortcut[] = [
	{ key: "r", label: "re-scan all", action: "rescan-all" },
	{ key: "d", label: "doctor", action: "doctor" },
	{ key: "q", label: "back", action: BACK_KEY },
];

export function buildAdvancedSnapshot(input: AdvancedPanelInput): { snapshot: PanelSnapshot; page: number; pages: number } {
	const backRow: PanelRow = { key: BACK_KEY, label: "Back to Model Discovery", value: "esc", kind: "action", valueStyle: "muted" };
	// frameHeight grammar: 1 title + 3 summary + 2 section titles + 4 maintenance
	// + (window ≤6 + back) + 2 detail + idle + shortcuts + navigation + border = 23.
	const window = pageRows(advancedSourceRows(input.sources), 6, input.page ?? 0);
	const diagnostic = input.notes?.[0];
	return {
		snapshot: padToFrame(
			{
				title: "Advanced configuration",
				summaryLines: [
					`Model Discovery v${input.version}`,
					`storage: ${input.storagePath}`,
					"secrets only via masked entry or --key-from-env · never in chat",
				],
				sections: [
					{ title: "Maintenance", rows: ADVANCED_MAINTENANCE_ROWS },
					{
						title: `Sources (${input.sources.length}) · config fields live on each source`,
						rows: [...window.rows, backRow],
					},
				],
				detailLines: [
					diagnostic ?? "renaming a source re-registers it · presets and catalogues stay saved",
					"destructive rows need two presses · the base model is never removed here",
				],
				idleMessage: input.sources.length ? "pick a source to edit its configuration" : "no sources yet · /discover add",
				shortcuts: ADVANCED_SHORTCUTS,
			},
			ADVANCED_PANEL_ROWS,
		),
		page: window.page,
		pages: window.pages,
	};
}

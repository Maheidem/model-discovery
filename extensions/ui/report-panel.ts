/**
 * ui/report-panel.ts — read-only reports as a fixed-height panel (slice 1b).
 *
 * `status`, `doctor`, `paths`, `help` and the routed-request preview used to
 * open a bespoke scrollable text viewer (`ui/wizard-shell.ts`, retired by
 * decision D1). They now share the vendored panel grammar: one title, one
 * window of info lines, real page controls, one footer. Same fixed frame as
 * every other surface, so switching screens never moves the terminal cursor.
 *
 * PURE: the host formats the report text (or passes the version line in) and
 * owns the page index; this module only lays it out.
 */

import { PAGE_NEXT_KEY, PAGE_PREV_KEY, padToFrame } from "./panel-frame.ts";
import { BACK_KEY } from "./endpoint-panel.ts";
import type { PanelRow, PanelSnapshot } from "./settings-panel.ts";

/** Fixed frame height for every report screen. */
export const REPORT_PANEL_ROWS = 23;

export interface ReportPanelInput {
	title: string;
	/** Version provenance line (OPERATIONAL §6.2 — every header carries it). */
	version: string;
	/** Subtitle/context line, e.g. the storage path. */
	subtitle?: string;
	lines: readonly string[];
	page?: number;
}

/** Rows for one page of report text, plus the pagination controls. */
export function reportRows(lines: readonly string[], budget: number, page: number): { rows: PanelRow[]; page: number; pages: number } {
	const pageSize = Math.max(1, budget - 2);
	const pages = Math.max(1, Math.ceil(lines.length / pageSize));
	const safe = Math.min(Math.max(0, page), pages - 1);
	const start = safe * pageSize;
	const body = lines.slice(start, start + pageSize);
	const rows: PanelRow[] = [];
	if (pages > 1) rows.push({ key: PAGE_PREV_KEY, label: "‹ previous page", value: `${safe + 1}/${pages}`, kind: "action", valueStyle: "muted" });
	for (const [index, line] of body.entries()) {
		rows.push({ key: `info:line:${start + index}`, label: line === "" ? " " : line, value: "", kind: "info", valueStyle: "muted" });
	}
	while (rows.length < budget - (pages > 1 ? 1 : 0)) rows.push({ key: `info:pad:${rows.length}`, label: " ", value: "", kind: "info" });
	if (pages > 1) rows.push({ key: PAGE_NEXT_KEY, label: "next page ›", value: `${safe + 2}/${pages}`, kind: "action", valueStyle: "muted" });
	return { rows: rows.slice(0, budget), page: safe, pages };
}

export function buildReportSnapshot(input: ReportPanelInput): PanelSnapshot {
	const summaryLines = [
		`Model Discovery v${input.version}`,
		input.subtitle ? input.subtitle : "read-only report",
		`${input.lines.length} line(s) of output`,
	];
	const detailLines = ["n / p page · esc back"];
	const chrome = 1 + summaryLines.length + 1 + detailLines.length + 1 + 1 + 1;
	const body = reportRows(input.lines, Math.max(1, REPORT_PANEL_ROWS - chrome), input.page ?? 0);
	return padToFrame(
		{
			title: input.title,
			summaryLines,
			sections: [{ title: "Report", rows: body.rows }],
			detailLines,
			idleMessage: `page ${body.page + 1}/${body.pages} · nothing here is editable`,
			shortcuts: [{ key: "q", label: "back", action: BACK_KEY }],
		},
		REPORT_PANEL_ROWS,
	);
}

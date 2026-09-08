/**
 * ui/panel-frame.ts — one fixed-height frame grammar for every secondary
 * panel screen (slice 1b, `.planning/ui-alignment-2026-09-08` §5/§7).
 *
 * WHY THIS EXISTS
 * `ui/settings-panel.ts` is the canonical vendored panel and must stay
 * byte-identical (guard: `node skills/pi-extension-builder/scripts/check-vendored.mjs`),
 * and it never pads: what it renders is exactly the SUM of the blocks it is
 * handed. The OPERATIONAL §1 rule ("fixed frame, growing content *window*")
 * therefore has to be enforced by the code that BUILDS snapshots — and it has
 * to be enforced in one place, otherwise every screen re-invents the arithmetic
 * and the frames drift (the exact failure this migration is about).
 *
 * FRAME GRAMMAR (mirrors `SettingsPanel.render()`, same order):
 *   1   top border
 *   N   summaryLines
 *   Σ   per section: 1 header + rows.length
 *   N   detailLines      ← blank padding lives here, INSIDE the border
 *   1   messageLine      (always rendered by the panel)
 *   0|1 shortcutLine     (iff shortcuts.length)
 *   1   navigationLine   (always rendered by the panel)
 *   1   bottom border
 */

import type { PanelRow, PanelSnapshot, PanelShortcut } from "./settings-panel.ts";

/** Rendered height of a snapshot under the vendored panel's frame grammar. */
export function frameHeight(snapshot: PanelSnapshot): number {
	const rows = snapshot.sections.reduce((total, section) => total + 1 + section.rows.length, 0);
	return (
		1 +
		(snapshot.summaryLines?.length ?? 0) +
		rows +
		(snapshot.detailLines?.length ?? 0) +
		1 +
		(snapshot.shortcuts?.length ? 1 : 0) +
		1 +
		1
	);
}

/**
 * Blank-pad a snapshot inside the border until it renders exactly `rows` tall.
 * Padding is additive only: content that does not FIT must be windowed by the
 * builder (`paginateRows`), never smuggled in by growing the frame.
 */
export function padToFrame<T extends PanelSnapshot>(snapshot: T, rows: number): T {
	const pad = Math.max(0, rows - frameHeight(snapshot));
	return {
		...snapshot,
		detailLines: [...(snapshot.detailLines ?? []), ...Array.from({ length: pad }, () => "")],
	};
}

/** Row keys of the pagination controls. Stable, inventory-visible, no magic. */
export const PAGE_PREV_KEY = "page:prev";
export const PAGE_NEXT_KEY = "page:next";

export interface RowPage {
	/** The rows that fit this page (controls included when paging is active). */
	rows: PanelRow[];
	/** 0-based page index actually rendered. */
	page: number;
	/** Total pages (1 when everything fits). */
	pages: number;
	/** Rows hidden behind the current page's `next` control. */
	hidden: number;
}

/**
 * Window rows into a fixed slot count. When the list overflows, two slots are
 * spent on `‹ prev` / `next ›` action rows so the window is always reachable
 * with the panel's own navigation — the frame never grows and the footer is
 * never cut. The two control slots are reserved on EVERY page (including the
 * first and last) so the frame height is identical across pages.
 */
export function paginateRows(rows: readonly PanelRow[], budget: number): RowPage {
	if (budget <= 0) return { rows: [], page: 0, pages: 1, hidden: rows.length };
	if (rows.length <= budget) return { rows: rows.map((row) => ({ ...row })), page: 0, pages: 1, hidden: 0 };

	const pageSize = Math.max(1, budget - 2);
	const pages = Math.max(1, Math.ceil(rows.length / pageSize));
	return { rows: [], page: 0, pages, hidden: Math.max(0, rows.length - pageSize) };
}

/**
 * Rows for one page of a windowed section, including the pagination controls.
 * `page` is clamped, so a stale index (after a delete) can never blank the
 * frame: the window always renders the same number of slots.
 */
export function pageRows(rows: readonly PanelRow[], budget: number, page: number): RowPage {
	const sizing = paginateRows(rows, budget);
	if (sizing.pages === 1) return sizing;
	const pageSize = Math.max(1, budget - 2);
	const safe = Math.min(Math.max(0, page), sizing.pages - 1);
	const start = safe * pageSize;
	const items = rows.slice(start, start + pageSize).map((row) => ({ ...row }));
	const out: PanelRow[] = [];
	if (safe > 0) {
		out.push({
			key: PAGE_PREV_KEY,
			label: "‹ previous page",
			value: `${safe + 1}/${sizing.pages}`,
			kind: "action",
			valueStyle: "muted",
		});
	}
	out.push(...items);
	const next = safe + 1 < sizing.pages;
	while (out.length < budget) out.push({ key: `info:pad:${out.length}`, label: "", value: "", kind: "info", valueStyle: "muted" });
	if (next) {
		out[budget - 1] = {
			key: PAGE_NEXT_KEY,
			label: "next page ›",
			value: `${safe + 2}/${sizing.pages}`,
			kind: "action",
			valueStyle: "muted",
		};
	}
	return { rows: out.slice(0, budget), page: safe, pages: sizing.pages, hidden: Math.max(0, rows.length - (start + pageSize)) };
}

/** Footer shortcuts, rendered by the panel as one unwrapped dim line. */
export function shortcuts(list: readonly [string, string, string][]): PanelShortcut[] {
	return list.map(([key, label, action]) => ({ key: key as PanelShortcut["key"], label, action }));
}

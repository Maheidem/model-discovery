/**
 * ui/home.ts — home dashboard snapshot model (slice 1a, `.planning/ui-alignment-2026-09-08` §5).
 *
 * Pure derivation: domain state goes in, `PanelSnapshot` comes out. No storage
 * reads, no network, no `index.ts` imports — the host (`index.ts`) hands this
 * module an already-loaded slice of state, so the shape is testable without a
 * TTY and without touching `$HOME`.
 *
 * ---------------------------------------------------------------------------
 * RENDER CONTRACT (copied from the vendored panel, `ui/settings-panel.ts`
 * `render()` — the frame height is the SUM of these blocks, in this order):
 *
 *   1  top border                       `╭─ Model Discovery ─…╮`
 *   2  summaryLines                    one row each (status dim)
 *   3  sections                       `1 header + N rows` per section
 *   4  detailLines                    one row each (dim)
 *   5  messageLine                   ALWAYS present (flash, edit hint, idle)
 *   6  shortcutLine                  present iff `shortcuts.length`
 *   7  navigationLine               ALWAYS present (`↑↓/jk move · enter …`)
 *   8  bottom border
 *
 * The vendored panel never pads and never wraps the shortcut footer, and it
 * is byte-identical canonical kit (guarded by `scripts/check-vendored.mjs`)
 * — so the FIXED-HEIGHT contract is this module's job:
 *   • `HOME_PANEL_ROWS = 23` is the frame budget (OPERATIONAL §1: fixed
 *     frame, growing content *window*);
 *   • the Sources section is the elastic window — newest-first, overflow
 *     collapsed into a non-selectable `+N more` info row counted INSIDE the
 *     budget, so adding a provider never grows the frame nor cuts the footer;
 *   • any leftover rows are blank-padded through `detailLines`, which the
 *     renderer draws as ordinary in-frame rows. Padding is therefore inside
 *     the border, and the frame is exactly `HOME_PANEL_ROWS` tall at every
 *     width (borders/padding stay UNSTYLED per the kit; only text is tinted).
 *
 * SHORTCUT FOOTER BUDGET: the footer is a single unwrapped line, so it
 * carries only the five keys that fit the narrowest supported width (62 cols
 * ⇒ 60 visible): `d discover · b browse · p presets · a add · q close`.
 * `doctor` cannot share `d` with `discover` (collision) — it is reached as a
 * row, not a letter. `r`/`x`/`i`/`s` were the other candidates and are
 * deliberately NOT advertised here; their rows stay selectable.
 */

import type { PanelRow, PanelSection, PanelShortcut, PanelSnapshot, PanelValueStyle } from "./settings-panel.ts";

/** Fixed frame height for the home dashboard (rows, including both borders). */
export const HOME_PANEL_ROWS = 23;

export type HomeAvailability = "ready" | "degraded" | "unavailable" | "unscanned";

/** One configured provider, already flattened by the host from storage. */
export interface HomeSourceInput {
	name: string;
	baseUrl: string;
	serverType: string;
	modelCount: number;
	availability: HomeAvailability;
}

/** Everything the home snapshot needs; the host reads storage once. */
export interface HomeSnapshotInput {
	version: string;
	sources: readonly HomeSourceInput[];
	/** Already home-relative, e.g. `~/.pi/agent/model-discovery.json`. */
	storageLine: string;
	/** e.g. `last scan 12m ago` / `never scanned`. */
	scanLine: string;
	/** Adaptive/preset line; omitted when the state is not reachable. */
	adaptiveLine?: string;
	/** Storage warning from `getStorageDiagnostic()`, if any. */
	diagnostic?: string;
}

/** Glyph + word pairs: status is never colour-alone (UX-STANDARD §2). */
const AVAILABILITY: Record<HomeAvailability, { glyph: string; style: PanelValueStyle }> = {
	ready: { glyph: "✓", style: "success" },
	degraded: { glyph: "⚠", style: "warning" },
	unavailable: { glyph: "✗", style: "error" },
	unscanned: { glyph: "○", style: "muted" },
};

/** Non-selectable overflow marker for the Sources window (not an action key). */
export const HOME_OVERFLOW_KEY = "source:more";

/**
 * The Actions section, in canonical order. Every key is the inventory key
 * (`tests/fixtures/discover-actions.ts`): `browse`/`presets`/`routing`/
 * `configure-advanced` are TRANSITIONAL in slice 1a — they close the panel and
 * run the pre-alignment flow, then the host reopens the home panel.
 */
export const HOME_ACTION_ROWS: readonly PanelRow[] = [
	{ key: "discover", label: "Discover now (all sources)", value: "↻", kind: "action" },
	{ key: "browse", label: "Browse tree…", value: "›", kind: "action" },
	{ key: "presets", label: "Presets…", value: "›", kind: "action" },
	{ key: "routing", label: "Routing…", value: "›", kind: "action" },
	{ key: "source:add", label: "Add provider…", value: "+", kind: "action" },
	{ key: "configure-advanced", label: "Configure advanced…", value: "›", kind: "action" },
	{ key: "doctor", label: "Doctor", value: "", kind: "action" },
	{ key: "status", label: "Status", value: "", kind: "action" },
	{ key: "paths", label: "Paths", value: "", kind: "action" },
	{ key: "help", label: "Help", value: "", kind: "action" },
];

/** Shortcut footer — five keys, fits the 62-column minimum width. */
export const HOME_SHORTCUTS: readonly PanelShortcut[] = [
	{ key: "d", label: "discover", action: "discover" },
	{ key: "b", label: "browse", action: "browse" },
	{ key: "p", label: "presets", action: "presets" },
	{ key: "a", label: "add", action: "source:add" },
	{ key: "q", label: "close", action: "close" },
];

export function formatAge(timestamp: number | undefined, now = Date.now()): string {
	if (!timestamp || !Number.isFinite(timestamp)) return "never scanned";
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return new Date(timestamp).toLocaleDateString();
}

export function sourceRow(source: HomeSourceInput): PanelRow {
	const status = AVAILABILITY[source.availability] ?? AVAILABILITY.unscanned;
	const models = `${source.modelCount} model${source.modelCount === 1 ? "" : "s"}`;
	return {
		key: `source:${source.name}`,
		label: source.name,
		value: `${status.glyph} ${source.availability} · ${source.serverType} · ${models} ›`,
		valueStyle: status.style,
		kind: "action",
	};
}

/** Rows consumed by everything except the Sources window and the padding. */
export function homeChromeRows(input: HomeSnapshotInput): number {
	const summaryCount = 2 + (input.diagnostic ? 1 : 0);
	const detailCount = input.adaptiveLine ? 1 : 0;
	const sectionHeaders = 2; // Sources + Actions
	return (
		1 /* top border */ +
		summaryCount +
		sectionHeaders +
		HOME_ACTION_ROWS.length +
		detailCount +
		1 /* message line */ +
		(HOME_SHORTCUTS.length ? 1 : 0) +
		1 /* navigation line */ +
		1 /* bottom border */
	);
}

/** Rows left for the Sources window inside the fixed frame. */
export function homeSourceWindow(input: HomeSnapshotInput, rows = HOME_PANEL_ROWS): number {
	return Math.max(1, rows - homeChromeRows(input));
}

/**
 * Newest-first window of source rows, `+N more` counted INSIDE the budget:
 * when the providers do not all fit, the last visible slot becomes the
 * overflow marker, so the window never costs more than `budget` rows.
 */
export function homeSourceRows(sources: readonly HomeSourceInput[], budget: number): PanelRow[] {
	if (budget <= 0) return [];
	if (sources.length <= budget) return sources.map(sourceRow);
	const visible = Math.max(0, budget - 1);
	return [...sources.slice(0, visible).map(sourceRow), overflowRow(sources.length - visible)];
}

function overflowRow(hidden: number): PanelRow {
	return {
		key: HOME_OVERFLOW_KEY,
		label: `+${hidden} more source${hidden === 1 ? "" : "s"}`,
		value: "b browse",
		kind: "info",
		valueStyle: "muted",
	};
}

/**
 * The home dashboard snapshot. Frame height is always exactly
 * `HOME_PANEL_ROWS`; the Sources window shrinks before the frame grows.
 */
export function buildHomeSnapshot(input: HomeSnapshotInput): PanelSnapshot {
	const ready = input.sources.filter((s) => s.availability === "ready").length;
	const degraded = input.sources.filter((s) => s.availability === "degraded").length;
	const unavailable = input.sources.filter((s) => s.availability === "unavailable").length;
	const unscanned = input.sources.filter((s) => s.availability === "unscanned").length;
	const models = input.sources.reduce((total, s) => total + s.modelCount, 0);

	const summaryLines = [
		`Model Discovery v${input.version} · ${input.sources.length} provider${
			input.sources.length === 1 ? "" : "s"
		} · ${models} model${models === 1 ? "" : "s"}`,
		`${input.storageLine} · ${input.scanLine}`,
		...(input.diagnostic ? [`⚠ ${input.diagnostic}`] : []),
	];

	const sources: PanelSection = { title: "Sources", rows: [] };
	if (!input.sources.length) {
		sources.rows.push({
			key: "source:none",
			label: "No providers configured",
			value: "a add",
			kind: "info",
			valueStyle: "muted",
		});
	} else {
		sources.rows.push(...homeSourceRows(input.sources, homeSourceWindow(input)));
	}

	const sections: PanelSection[] = [sources, { title: "Actions", rows: HOME_ACTION_ROWS.map((row) => ({ ...row })) }];

	// Health in words as well as colour, so the frame reads without colour.
	const snapshot: PanelSnapshot = {
		title: "Model Discovery",
		summaryLines,
		sections,
		detailLines: [],
		idleMessage: `${ready} ready · ${degraded} cached · ${unavailable} unavailable · ${unscanned} not scanned`,
		shortcuts: HOME_SHORTCUTS.map((shortcut) => ({ ...shortcut })),
	};

	// Blank-pad INSIDE the frame: pad = budget − (chrome + window + adaptive).
	const natural = homeChromeRows(input) + sources.rows.length;
	const pad = Math.max(0, HOME_PANEL_ROWS - natural);
	snapshot.detailLines = [...(input.adaptiveLine ? [input.adaptiveLine] : []), ...Array.from({ length: pad }, () => "")];
	return snapshot;
}

/** Natural rendered height for a snapshot — the fixed-height invariant under test. */
export function homePanelRowCount(input: HomeSnapshotInput): number {
	const snapshot = buildHomeSnapshot(input);
	const rows = snapshot.sections.reduce((total, section) => total + section.rows.length, 0);
	return (
		1 /* top */ +
		(snapshot.summaryLines?.length ?? 0) +
		snapshot.sections.length /* one header per section */ +
		rows +
		(snapshot.detailLines?.length ?? 0) +
		1 /* message */ +
		(snapshot.shortcuts?.length ? 1 : 0) +
		1 /* navigation */ +
		1 /* bottom */
	);
}

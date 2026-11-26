/**
 * canonical tool-result-card renderer (v1) — vendored byte-identical;
 * consumers: extensions/ui/tool-card.ts; guard: scripts/check-vendored.mjs
 *
 * The model-path card skeleton every tool shares (pi-panel-kit S1):
 *
 *   call card   `→ <title> · <subject><qualifier>` — one accent line
 *   result card optional accent header · severity-styled state headline
 *               (`<lead> <glyph> <word> <bits…>`) · plain summary lines ·
 *               dim detail lines · trailing next-action line
 *
 * Severity comes ONLY from the explicit state key, never from content
 * (OPERATIONAL-EXTENSIONS §2.9), and follows the ladder literally (§2.10):
 * normal states stay neutral (success/muted), `warning` is reserved for
 * degraded outcomes (timeout, online-but-empty), `error` for failed ones.
 * The glyph+word pairing always survives the styling (never color-alone).
 *
 * Callers own the domain specifics — bit composition, truncation, and the
 * no-details fallback (`renderToolPlainCard`) — so behavior-neutral
 * adoption stays possible. This kit copy imports only `@earendil-works/
 * pi-tui` (peer, same pattern as settings-panel.ts) and the vendored
 * `./format.ts` primitive.
 */
import { Text } from "@earendil-works/pi-tui";

import { stateGlyph } from "./format.ts";

/** Theme subset a tool card needs; `fg` is optional in headless/print modes. */
export interface ToolCardTheme {
	fg?: (kind: string, text: string) => string;
}

/** Severity ladder values — also the `theme.fg` kinds used to style lines. */
export type ToolCardSeverity = "success" | "warning" | "error" | "muted";

/** Line kinds a card can style; detail lines default to muted (dim). */
export type ToolCardLineKind = ToolCardSeverity | "accent";

export interface ToolCardStateInfo {
	glyph: string;
	word: string;
	severity: ToolCardSeverity;
}

/**
 * Terminal card states that are not live-run states: `registered` is a
 * success with a domain word, `no-models` is degraded (online but empty
 * catalogue). Everything else — and the failed fallback for unknown keys —
 * comes from `format.ts` `stateGlyph` unchanged.
 */
const TOOL_CARD_STATES: Record<string, ToolCardStateInfo> = {
	registered: { glyph: "✓", word: "registered", severity: "success" },
	"no-models": { glyph: "⊘", word: "online · no models", severity: "warning" },
};

/** Glyph + state word + severity for an explicit state key (never content). */
export function toolCardState(state: string): ToolCardStateInfo {
	const own = TOOL_CARD_STATES[state];
	if (own) return own;
	const g = stateGlyph(state);
	return { glyph: g.glyph, word: g.word, severity: g.color };
}

/** `theme.fg` with identity fallback so headless modes render plain text. */
export function themed(theme: ToolCardTheme | undefined, kind: string, text: string): string {
	return theme?.fg ? theme.fg(kind, text) : text;
}

export interface ToolCallCardSpec {
	/** Tool name shown after the arrow ("delegate", "discover"). */
	title: string;
	/** Primary subject (the role, the URL). */
	subject: string;
	/** Already-punctuated tail (` · model: task`, ` as "name"`); optional. */
	qualifier?: string;
}

/** One-line accent call card: `→ title · subject<qualifier>`. */
export function renderToolCallCard(theme: ToolCardTheme | undefined, spec: ToolCallCardSpec): Text {
	const text = `→ ${spec.title} · ${spec.subject}${spec.qualifier ?? ""}`;
	return new Text(themed(theme, "accent", text), 0, 0);
}

/** A pre-composed detail line (indentation included); `kind` defaults muted. */
export interface ToolCardLine {
	text: string;
	kind?: ToolCardLineKind;
}

export interface ToolResultCardSpec {
	/** Accent header line above the headline (e.g. `→ <run-id tail>`). */
	header?: string;
	/** Headline lead before the glyph ("discover", the run role). */
	lead: string;
	/** Explicit state key — severity comes from `toolCardState`, never content. */
	state: string;
	/** Info bits appended after the state word (duration, tokens, …). */
	stateBits?: string[];
	/** Joiner between headline segments; default `" "`. */
	bitJoiner?: string;
	/** Lines rendered verbatim (no styling) — canonical summaries. */
	plainLines?: string[];
	/** Dim detail lines (partial handoff, first error line, resume hint). */
	detailLines?: ToolCardLine[];
	/** Trailing next-action hint, always muted. */
	nextLine?: string;
}

/**
 * Result card skeleton: header · state headline · plain lines · dim details ·
 * next action. All glyph/word/severity styling derives from `spec.state`.
 */
export function renderToolResultCard(theme: ToolCardTheme | undefined, spec: ToolResultCardSpec): Text {
	const s = toolCardState(spec.state);
	const joiner = spec.bitJoiner ?? " ";
	const headline = [`${spec.lead} ${s.glyph} ${s.word}`, ...(spec.stateBits ?? [])].join(joiner);
	const lines: string[] = [];
	if (spec.header !== undefined) lines.push(themed(theme, "accent", spec.header));
	lines.push(themed(theme, s.severity, headline));
	for (const line of spec.plainLines ?? []) lines.push(line);
	for (const line of spec.detailLines ?? []) lines.push(themed(theme, line.kind ?? "muted", line.text));
	if (spec.nextLine !== undefined) lines.push(themed(theme, "muted", spec.nextLine));
	return new Text(lines.join("\n"), 0, 0);
}

/** Fallback for results without structured details — plain text, never bare. */
export function renderToolPlainCard(text: string): Text {
	return new Text(text || "(no output)", 0, 0);
}

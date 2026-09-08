/**
 * canonical kit formatting primitive (v1) — vendored byte-identical;
 * consumers: extensions/ui/format.ts; guard: scripts/check-vendored.mjs
 *
 * ONE module all views import so tokens/durations/sizes/model render
 * identically across home, live strip, inline tool card, and peek.
 *
 * This kit copy is deliberately SELF-CONTAINED (zero imports): the canonical
 * `formatDuration` is inlined verbatim from the delegate `config.ts` so a
 * generated panel can vendor the whole primitive without importing
 * `../config.ts`. Consumers re-export it (`export { formatDuration }`) to
 * keep the historical public surface of `ui/format.ts` unchanged. The
 * delegate keeps its own `formatDuration` in `config.ts` for existing
 * importers; both copies descend from the same code and must stay
 * behaviorally identical — locked by
 * `custom-extensions/delegate/tests/format.test.ts`.
 *
 * Registered vendored target: `custom-extensions/delegate/ui/format.ts`
 * (`required: true`). Never hand-edit a vendored copy: edit this canonical
 * source, then `node scripts/check-vendored.mjs --fix`.
 */

/** Human-readable duration for TUI display and prefilled inputs. */
function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	const totalSec = Math.round(ms / 1_000);
	if (totalSec < 60) return `${totalSec}s`;
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
	const h = Math.floor(m / 60);
	const remM = m % 60;
	if (h < 24) return remM ? `${h}h ${remM}m` : `${h}h`;
	const d = Math.floor(h / 24);
	const remH = h % 24;
	return remH ? `${d}d ${remH}h` : `${d}d`;
}

/** Token count: 0 if falsy; raw <1000; else `X.Yk`; else `X.YM`. */
export function formatTokens(n: number | undefined): string {
	if (!n || n < 0) return "0";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 100) / 10}k`;
	return `${Math.round(n / 100_000) / 10}M`;
}

/**
 * Project-layer config cell for dashboard rows. The project FILE is the
 * source of truth for presence: a value equal to the user layer renders as
 * `2h (= user)` instead of reading as unset, and "not set" appears ONLY when
 * the key is absent from the file. `undefined` means absent.
 */
export function projectValueCell(value: number | undefined, userValue: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "not set";
	const text = formatDuration(value);
	if (userValue !== undefined && Number.isFinite(userValue) && value === userValue) return `${text} (= user)`;
	return text;
}

/** Cost as `$X.YZ` (2 dp) or `$0.00`. Never emoji. */
export function formatCost(cost: number | undefined): string {
	return `$${(cost ?? 0).toFixed(2)}`;
}

/** Bytes → binary size, 0–1 decimal ("51200"→"50 KB"). */
export function formatSize(bytes: number | undefined): string {
	const b = bytes ?? 0;
	if (b < 1024) return `${b} B`;
	const kb = b / 1024;
	if (kb < 1024) return `${kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb)} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
	const gb = mb / 1024;
	return `${gb < 10 ? Math.round(gb * 10) / 10 : Math.round(gb)} GB`;
}

/** "zai/glm-5.3" → "glm-5.3" for compact rows; full id for peek headers. */
export function shortModel(model: string | undefined): string {
	if (!model) return "";
	const slash = model.lastIndexOf("/");
	return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * State glyph + word (never color-alone, FIELDS §3.6). Returns the glyph and
 * the word separately so the caller colors them together.
 */
export function stateGlyph(state: string): { glyph: string; word: string; color: "success" | "warning" | "error" | "muted" } {
	switch (state) {
		case "created":
		case "starting":
			return { glyph: "◐", word: "starting", color: "muted" };
		case "running":
			return { glyph: "●", word: "running", color: "success" };
		case "succeeded":
			return { glyph: "✓", word: "done", color: "success" };
		case "cancelled":
			return { glyph: "⊘", word: "cancelled", color: "muted" };
		case "timed_out_idle":
			return { glyph: "⏱", word: "timeout · idle", color: "warning" };
		case "timed_out_hard":
			return { glyph: "⏱", word: "timeout · hard", color: "warning" };
		case "queued":
			return { glyph: "○", word: "queued", color: "muted" };
		default:
			return { glyph: "✗", word: state || "unknown", color: "error" };
	}
}

/** Progress bar: `filled(█) + empty(░)` + "NN%" text (never shape-alone). */
export function progressBar(frac: number, width: number): string {
	const f = Math.max(0, Math.min(1, frac));
	const w = Math.max(4, Math.floor(width));
	const filled = Math.round(f * w);
	return `${"█".repeat(filled)}${"░".repeat(Math.max(0, w - filled))} ${Math.round(f * 100)}%`;
}

/** Canonical duration (ms → "41s"/"30m 22s"/"2h"). */
export { formatDuration };

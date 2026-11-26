/**
 * ui/secret-field.ts — the ONE masked credential field (slice 1b).
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A SHELL
 * The vendored `ui/settings-panel.ts` is canonical and byte-identical, and its
 * `input` rows render an ordinary `Input` — every keystroke echoes. Secrets
 * must never echo (UX-STANDARD §"Secrets are masked … never render their
 * contents in a normal row"), and the wizard shell that used to own masked
 * entry (`ui/wizard-shell.ts`) is retired by decision D1. So masked entry
 * needs a home: this single-purpose FIELD.
 *
 * It is deliberately not a navigation surface: one prompt, one masked buffer,
 * one fixed frame. It owns no list, no filter, no page, no selection grammar —
 * those live in the vendored panel. The host opens it as its own overlay
 * (one surface at a time), then applies the value through the same
 * `application.ts` method the old wizard used.
 *
 * FIXED HEIGHT: `SECRET_FIELD_ROWS` rows at every width (borders included);
 * the value is replaced by `•` and the raw buffer never reaches `render()`.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";

/** Frame budget: top border + prompt + masked field + footer + bottom border. */
export const SECRET_FIELD_ROWS = 5;

export interface SecretFieldHost {
	theme: Theme;
	keybindings: KeybindingsManager;
	/** What the user is being asked for, e.g. `API key for omx-local`. */
	prompt: string;
	requestRender(): void;
	/** `undefined` means the user cancelled (esc) — no value was captured. */
	done(value: string | undefined): void;
}

function bindingText(keys: readonly string[], fallback: string): string {
	const first = keys[0];
	if (!first) return fallback;
	return first
		.replace(/^escape$/, "esc")
		.replace(/^return$/, "enter");
}

export class SecretField implements Component, Focusable {
	private readonly host: SecretFieldHost;
	private readonly input = new Input();
	private error?: string;

	constructor(host: SecretFieldHost) {
		this.host = host;
		this.input.focused = true;
		this.input.onSubmit = (value) => {
			if (!value.trim()) {
				// A blank submit is almost always a mistake; keep the field open and
				// say why. Clearing a credential is an explicit, named row instead.
				this.error = "Value is empty · paste a key, or press esc to go back";
				this.host.requestRender();
				return;
			}
			this.host.done(value);
		};
		this.input.onEscape = () => this.host.done(undefined);
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	handleInput(data: string): void {
		if (this.error) this.error = undefined;
		this.input.handleInput(data);
		this.host.requestRender();
	}

	/**
	 * Exactly `SECRET_FIELD_ROWS` rows at every width:
	 *   border · prompt · masked field · footer (or the reason it stayed open) · border
	 */
	render(width: number): string[] {
		const t = this.host.theme;
		const innerWidth = Math.max(1, width - 4);
		const prompt = wrapTextWithAnsi(this.host.prompt, innerWidth)[0] ?? "";
		const submit = bindingText(this.host.keybindings.getKeys("tui.input.submit"), "enter");
		const cancel = bindingText(this.host.keybindings.getKeys("tui.select.cancel"), "esc");
		const footer = this.error
			? t.fg("error", ` ${this.error}`)
			: t.fg("dim", ` ${innerWidth < 28 ? `${submit} · ${cancel}` : `${submit} save · ${cancel} back · value is masked`}`);
		return [
			this.topBorder(width),
			this.boxLine(t.fg("muted", ` ${prompt}`), width),
			this.boxLine(`${t.fg("accent", "> ")}${this.maskedField(Math.max(1, width - 6))}`, width),
			this.boxLine(footer, width),
			this.bottomBorder(width),
		];
	}

	/** Dots only: the raw buffer is never part of the rendered output. */
	private maskedField(width: number): string {
		const characters = [...this.input.getValue()];
		const cursorOffset = (this.input as unknown as { cursor: number }).cursor;
		const cursorIndex = Math.min(characters.length, Math.max(0, cursorOffset));
		const reserveEndCursor = cursorIndex === characters.length ? 1 : 0;
		const visibleCapacity = Math.max(0, width - reserveEndCursor);
		let start = Math.max(0, cursorIndex - Math.floor(visibleCapacity / 2));
		start = Math.min(start, Math.max(0, characters.length - visibleCapacity));
		const end = Math.min(characters.length, start + visibleCapacity);
		const visible = characters.slice(start, end).map(() => "•");
		if (start > 0 && visible.length) visible[0] = "…";
		if (end < characters.length && visible.length) visible[visible.length - 1] = "…";
		const relativeCursor = Math.max(0, Math.min(visible.length, cursorIndex - start));
		const before = visible.slice(0, relativeCursor).join("");
		const atCursor = visible[relativeCursor] ?? " ";
		const after = visible.slice(relativeCursor + 1).join("");
		const marker = this.input.focused ? CURSOR_MARKER : "";
		return `${before}${marker}\x1b[7m${atCursor}\x1b[27m${after}`;
	}

	private boxLine(content: string, width: number): string {
		const t = this.host.theme;
		if (width <= 1) return truncateToWidth(content, Math.max(1, width), "", true);
		const innerWidth = Math.max(0, width - 2);
		const clipped = truncateToWidth(content, innerWidth, "…", true);
		const padded = clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
		return t.fg("border", "│") + padded + t.fg("border", "│");
	}

	private topBorder(width: number): string {
		const t = this.host.theme;
		if (width <= 1) return t.fg("borderAccent", "─".repeat(Math.max(1, width)));
		const title = truncateToWidth(t.fg("accent", t.bold(" secret · masked ")), Math.max(0, width - 2), "", false);
		const tail = "─".repeat(Math.max(0, width - 2 - visibleWidth(title)));
		return `${t.fg("border", "╭")}${title}${t.fg("border", `${tail}╮`)}`;
	}

	private bottomBorder(width: number): string {
		const t = this.host.theme;
		if (width <= 1) return t.fg("border", "─".repeat(Math.max(1, width)));
		return t.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}
}

/** Masked rendering of a stored credential: `configured` plus a dot hint. */
export function maskedCredentialCell(hasApiKey: boolean): { value: string; style: "success" | "muted" } {
	return hasApiKey ? { value: "•••• configured", style: "success" } : { value: "anonymous", style: "muted" };
}

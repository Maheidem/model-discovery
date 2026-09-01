import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Input,
	SelectList,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type SelectItem,
} from "@earendil-works/pi-tui";

export interface WizardSelectHost {
	theme: Theme;
	keybindings: KeybindingsManager;
	title: string;
	items: readonly SelectItem[];
	headerLines?: readonly string[];
	initialValue?: string;
	requestRender(): void;
	done(value: string | null): void;
}

export interface WizardTextHost {
	theme: Theme;
	keybindings: KeybindingsManager;
	title: string;
	lines: readonly string[];
	requestRender(): void;
	done(): void;
}

export interface WizardInputHost {
	theme: Theme;
	keybindings: KeybindingsManager;
	title: string;
	description?: string;
	initialValue?: string;
	validate?(value: string): string | null;
	requestRender(): void;
	done(value: string | undefined): void;
}

export interface WizardSecretHost {
	theme: Theme;
	keybindings: KeybindingsManager;
	title: string;
	description: string;
	requestRender(): void;
	done(value: string | undefined): void;
}

function bindingText(keys: readonly string[], fallback: string): string {
	const first = keys[0];
	if (!first) return fallback;
	return first
		.replace(/^up$/, "↑")
		.replace(/^down$/, "↓")
		.replace(/^left$/, "←")
		.replace(/^right$/, "→")
		.replace(/^escape$/, "esc")
		.replace(/^return$/, "enter")
		.replace(/^pageUp$/, "pgup")
		.replace(/^pageDown$/, "pgdn");
}

function boxLine(theme: Theme, content: string, width: number): string {
	if (width <= 1) return truncateToWidth(content, Math.max(1, width), "", true);
	const innerWidth = Math.max(0, width - 2);
	const clipped = truncateToWidth(content, innerWidth, "…", true);
	const padded = clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return theme.fg("border", "│") + padded + theme.fg("border", "│");
}

function topBorder(theme: Theme, width: number, title: string): string {
	if (width <= 1) return theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
	const innerWidth = Math.max(0, width - 2);
	const styledTitle = theme.fg("accent", theme.bold(` ${title} `));
	const clippedTitle = truncateToWidth(styledTitle, innerWidth, "", false);
	const tail = "─".repeat(Math.max(0, innerWidth - visibleWidth(clippedTitle)));
	return theme.fg("border", "╭") + clippedTitle + theme.fg("border", `${tail}╮`);
}

function bottomBorder(theme: Theme, width: number): string {
	if (width <= 1) return theme.fg("border", "─".repeat(Math.max(1, width)));
	return theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function semanticHeader(theme: Theme, line: string): string {
	const lower = line.toLowerCase();
	if (lower.includes("failed") || lower.includes("offline") || lower.includes("warning") || lower.includes("invalid")) {
		return theme.fg("warning", ` ${line}`);
	}
	if (lower.includes("online") || lower.includes("ready") || lower.includes("saved")) {
		return theme.fg("success", ` ${line}`);
	}
	return theme.fg("muted", ` ${line}`);
}

function isPrintableInput(data: string): boolean {
	if (!data || data.includes("\x1b")) return false;
	return [...data].every((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code >= 0x20 && code !== 0x7f;
	});
}

/**
 * Reusable wizard step around Pi's SelectList. It adds the shared bordered
 * shell, injected-keybinding navigation, responsive footer, and real filtering.
 */
export class WizardSelect implements Component {
	private readonly host: WizardSelectHost;
	private query = "";
	private filteredItems: SelectItem[] = [];
	private selectedIndex = 0;
	private selectList!: SelectList;
	private readonly maxVisible = 10;

	constructor(host: WizardSelectHost) {
		this.host = host;
		this.rebuildList(host.initialValue);
	}

	render(width: number): string[] {
		const t = this.host.theme;
		const lines = [topBorder(t, width, this.host.title)];
		const headers = this.host.headerLines ?? [];
		const visibleHeaders = headers.slice(0, 6);
		for (const line of visibleHeaders) lines.push(boxLine(t, semanticHeader(t, line), width));
		if (headers.length > visibleHeaders.length) {
			lines.push(boxLine(t, t.fg("dim", ` … ${headers.length - visibleHeaders.length} more detail lines`), width));
		}

		const innerWidth = Math.max(1, width - 2);
		if (width < 6) {
			lines.push(boxLine(t, t.fg("accent", "…"), width));
		} else {
			for (const line of this.selectList.render(innerWidth)) lines.push(boxLine(t, line, width));
		}
		if (this.query) {
			lines.push(boxLine(t, t.fg("accent", ` Filter: ${this.query}`), width));
		}
		lines.push(boxLine(t, t.fg("dim", ` ${this.navigationFooter(innerWidth)}`), width));
		lines.push(bottomBorder(t, width));
		return lines;
	}

	invalidate(): void {
		this.selectList.invalidate();
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.done(null);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.filteredItems[this.selectedIndex];
			if (selected) this.host.done(selected.value);
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.move(-this.maxVisible, false);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.move(this.maxVisible, false);
			return;
		}
		if (data === "\x7f" || data === "\b") {
			if (this.query) {
				this.query = [...this.query].slice(0, -1).join("");
				this.rebuildList();
				this.host.requestRender();
			}
			return;
		}
		if (data === "\x15") {
			if (this.query) {
				this.query = "";
				this.rebuildList();
				this.host.requestRender();
			}
			return;
		}
		if (isPrintableInput(data)) {
			this.query += data;
			this.rebuildList();
			this.host.requestRender();
		}
	}

	private move(delta: number, wrap = true): void {
		const count = this.filteredItems.length;
		if (!count) return;
		this.selectedIndex = wrap
			? (this.selectedIndex + delta + count) % count
			: Math.max(0, Math.min(count - 1, this.selectedIndex + delta));
		this.selectList.setSelectedIndex(this.selectedIndex);
		this.host.requestRender();
	}

	private rebuildList(preferredValue?: string): void {
		const previousValue = preferredValue ?? this.filteredItems[this.selectedIndex]?.value;
		const needle = this.query.trim().toLocaleLowerCase();
		this.filteredItems = this.host.items.filter((item) => {
			if (!needle) return true;
			return [item.label, item.value, item.description]
				.filter((value): value is string => typeof value === "string")
				.some((value) => value.toLocaleLowerCase().includes(needle));
		});
		const preferredIndex = previousValue
			? this.filteredItems.findIndex((item) => item.value === previousValue)
			: -1;
		this.selectedIndex = preferredIndex >= 0 ? preferredIndex : 0;
		this.selectList = new SelectList(
			this.filteredItems,
			Math.min(Math.max(1, this.filteredItems.length), this.maxVisible),
			{
				selectedPrefix: (text: string) => this.host.theme.fg("accent", text),
				selectedText: (text: string) => this.host.theme.fg("accent", text),
				description: (text: string) => this.host.theme.fg("muted", text),
				scrollInfo: (text: string) => this.host.theme.fg("dim", text),
				noMatch: (text: string) => this.host.theme.fg("warning", text),
			},
			{ minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 48 },
		);
		this.selectList.setSelectedIndex(this.selectedIndex);
	}

	private navigationFooter(innerWidth: number): string {
		const kb = this.host.keybindings;
		const up = bindingText(kb.getKeys("tui.select.up"), "↑");
		const down = bindingText(kb.getKeys("tui.select.down"), "↓");
		const confirm = bindingText(kb.getKeys("tui.select.confirm"), "enter");
		const cancel = bindingText(kb.getKeys("tui.select.cancel"), "esc");
		if (innerWidth < 24) return `${up}/${down} ${confirm} ${cancel}`;
		if (innerWidth < 34) return `${up}/${down} · ${confirm} · ${cancel}`;
		if (innerWidth < 58) return `${up}/${down} move · ${confirm} select · ${cancel} back`;
		return `${up}/${down} move · ${confirm} select · ${cancel} back · type to filter`;
	}
}

/** Scrollable, width-safe secondary screen for diagnostics and request previews. */
export class WizardTextView implements Component {
	private readonly host: WizardTextHost;
	private offset = 0;
	private wrappedCount = 0;
	private readonly viewportRows = 14;

	constructor(host: WizardTextHost) {
		this.host = host;
	}

	render(width: number): string[] {
		const t = this.host.theme;
		const innerWidth = Math.max(1, width - 4);
		const wrapped = this.host.lines.flatMap((line) => line ? wrapTextWithAnsi(line, innerWidth) : [""]);
		this.wrappedCount = wrapped.length;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, wrapped.length - this.viewportRows)));
		const visible = wrapped.slice(this.offset, this.offset + this.viewportRows);
		const lines = [topBorder(t, width, this.host.title)];
		const rangeEnd = Math.min(wrapped.length, this.offset + visible.length);
		lines.push(boxLine(t, t.fg("muted", ` Lines ${wrapped.length ? this.offset + 1 : 0}–${rangeEnd} of ${wrapped.length}`), width));
		for (const line of visible) lines.push(boxLine(t, ` ${line}`, width));
		if (!visible.length) lines.push(boxLine(t, t.fg("muted", " No details available"), width));
		lines.push(boxLine(t, t.fg("dim", ` ${this.footer(Math.max(1, width - 2))}`), width));
		lines.push(bottomBorder(t, width));
		return lines;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm")) {
			this.host.done();
			return;
		}
		if (kb.matches(data, "tui.select.up")) this.scroll(-1);
		else if (kb.matches(data, "tui.select.down")) this.scroll(1);
		else if (kb.matches(data, "tui.select.pageUp")) this.scroll(-this.viewportRows);
		else if (kb.matches(data, "tui.select.pageDown")) this.scroll(this.viewportRows);
	}

	private scroll(delta: number): void {
		this.offset = Math.max(0, Math.min(Math.max(0, this.wrappedCount - this.viewportRows), this.offset + delta));
		this.host.requestRender();
	}

	private footer(innerWidth: number): string {
		const kb = this.host.keybindings;
		const up = bindingText(kb.getKeys("tui.select.up"), "↑");
		const down = bindingText(kb.getKeys("tui.select.down"), "↓");
		const pageUp = bindingText(kb.getKeys("tui.select.pageUp"), "pgup");
		const pageDown = bindingText(kb.getKeys("tui.select.pageDown"), "pgdn");
		const cancel = bindingText(kb.getKeys("tui.select.cancel"), "esc");
		return innerWidth < 34 ? `${up}/${down} scroll · ${cancel}` : `${up}/${down} scroll · ${pageUp}/${pageDown} page · ${cancel} back`;
	}
}

/** Focusable text/number wizard step with retained inline validation. */
export class WizardInput implements Component, Focusable {
	private readonly host: WizardInputHost;
	private readonly input = new Input();
	private error?: string;

	constructor(host: WizardInputHost) {
		this.host = host;
		this.input.focused = true;
		if (host.initialValue) {
			this.input.setValue(host.initialValue);
			// Input.setValue() puts the cursor at the start; End keeps edits intuitive.
			this.input.handleInput("\x1b[F");
		}
		this.input.onSubmit = (value) => {
			const error = this.host.validate?.(value) ?? null;
			if (error) {
				this.error = error;
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

	render(width: number): string[] {
		const t = this.host.theme;
		const lines = [topBorder(t, width, this.host.title)];
		if (this.host.description) {
			for (const line of wrapTextWithAnsi(this.host.description, Math.max(1, width - 4)).slice(0, 3)) {
				lines.push(boxLine(t, t.fg("muted", ` ${line}`), width));
			}
		}
		for (const line of this.input.render(Math.max(1, width - 4))) lines.push(boxLine(t, ` ${line}`, width));
		if (this.error) lines.push(boxLine(t, t.fg("error", ` ${this.error}`), width));
		const innerWidth = Math.max(1, width - 2);
		const submit = bindingText(this.host.keybindings.getKeys("tui.input.submit"), "enter");
		const cancel = bindingText(this.host.keybindings.getKeys("tui.select.cancel"), "esc");
		lines.push(boxLine(t, t.fg("dim", ` ${innerWidth < 24 ? `${submit} ${cancel}` : `${submit} submit · ${cancel} cancel`}`), width));
		lines.push(bottomBorder(t, width));
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	handleInput(data: string): void {
		if (this.error) this.error = undefined;
		this.input.handleInput(data);
		this.host.requestRender();
	}
}

/** Focusable masked secret step. The raw value is never included in render output. */
export class WizardSecretInput implements Component, Focusable {
	private readonly host: WizardSecretHost;
	private readonly input = new Input();

	constructor(host: WizardSecretHost) {
		this.host = host;
		this.input.focused = true;
		this.input.onSubmit = (value) => this.host.done(value);
		this.input.onEscape = () => this.host.done(undefined);
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	render(width: number): string[] {
		const t = this.host.theme;
		const lines = [topBorder(t, width, this.host.title)];
		const descriptionWidth = Math.max(1, width - 4);
		for (const line of wrapTextWithAnsi(this.host.description, descriptionWidth).slice(0, 3)) {
			lines.push(boxLine(t, t.fg("muted", ` ${line}`), width));
		}
		const available = Math.max(1, width - 6);
		lines.push(boxLine(t, ` ${t.fg("accent", "> ")}${this.maskedInputLine(available)}`, width));
		const innerWidth = Math.max(1, width - 2);
		const submit = bindingText(this.host.keybindings.getKeys("tui.input.submit"), "enter");
		const cancel = bindingText(this.host.keybindings.getKeys("tui.select.cancel"), "esc");
		lines.push(boxLine(t, t.fg("dim", ` ${innerWidth < 34 ? `${submit} · ${cancel} · masked` : `${submit} submit · ${cancel} cancel · value is masked`}`), width));
		lines.push(bottomBorder(t, width));
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	private maskedInputLine(width: number): string {
		const value = this.input.getValue();
		const characters = [...value];
		const cursorOffset = (this.input as unknown as { cursor: number }).cursor;
		const cursorIndex = [...value.slice(0, cursorOffset)].length;
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

	handleInput(data: string): void {
		this.input.handleInput(data);
		this.host.requestRender();
	}
}

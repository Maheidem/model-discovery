import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import { WizardInput, WizardSecretInput, WizardSelect, WizardTextView } from "./ui/wizard-shell.ts";

function theme(): Theme {
	return {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

function keybindings(overrides: Partial<Record<string, string>> = {}): KeybindingsManager {
	const defaults: Record<string, string> = {
		"tui.select.up": "up",
		"tui.select.down": "down",
		"tui.select.pageUp": "pageUp",
		"tui.select.pageDown": "pageDown",
		"tui.select.confirm": "return",
		"tui.select.cancel": "escape",
		"tui.input.submit": "return",
	};
	const keys = { ...defaults, ...overrides };
	const input: Record<string, string> = {
		up: "\x1b[A",
		down: "\x1b[B",
		pageUp: "\x1b[5~",
		pageDown: "\x1b[6~",
		return: "\r",
		escape: "\x1b",
	};
	return {
		getKeys: (id: string) => [keys[id] ?? id],
		matches: (data: string, id: string) => {
			const key = keys[id] ?? id;
			return data === (input[key] ?? key);
		},
	} as unknown as KeybindingsManager;
}

function assertWidthSafe(lines: string[], width: number): void {
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
}

function items(count = 14): SelectItem[] {
	return Array.from({ length: count }, (_, index) => ({
		value: `source:${index}`,
		label: index === 1 ? "Beta workstation" : `Source ${index}`,
		description: `ready · local endpoint ${index} with a deliberately long descriptive value`,
	}));
}

test("wizard selector is width-safe and stays within the primary height budget", () => {
	const component = new WizardSelect({
		theme: theme(),
		keybindings: keybindings(),
		title: "Model Discovery › Sources with an unusually long title",
		items: items(),
		headerLines: ["14 sources · 20 cached models", "12 ready · 2 cached"],
		requestRender: () => {},
		done: () => {},
	});
	for (const width of [80, 62, 20, 1]) {
		const lines = component.render(width);
		assertWidthSafe(lines, width);
		assert.ok(lines.length <= 23, `height ${lines.length} exceeds 23 at width ${width}`);
		if (width === 20) assert.match(lines.join("\n"), /enter esc/);
	}
});

test("wizard selector honors configured navigation and cancel bindings", () => {
	let result: string | null | undefined;
	let renders = 0;
	const component = new WizardSelect({
		theme: theme(),
		keybindings: keybindings({
			"tui.select.up": "p",
			"tui.select.down": "n",
			"tui.select.confirm": "y",
			"tui.select.cancel": "x",
		}),
		title: "Sources",
		items: items(3),
		requestRender: () => { renders++; },
		done: (value) => { result = value; },
	});
	assert.match(component.render(62).join("\n"), /p\/n move · y select · x back/);
	component.handleInput("n");
	component.handleInput("y");
	assert.equal(result, "source:1");
	assert.ok(renders > 0);
	result = undefined;
	component.handleInput("x");
	assert.equal(result, null);
});

test("wizard selector filters labels and retains a useful no-match state", () => {
	let result: string | null | undefined;
	const component = new WizardSelect({
		theme: theme(),
		keybindings: keybindings(),
		title: "Sources",
		items: items(4),
		requestRender: () => {},
		done: (value) => { result = value; },
	});
	component.handleInput("beta");
	assert.match(component.render(62).join("\n"), /Filter: beta/);
	component.handleInput("\r");
	assert.equal(result, "source:1");

	const empty = new WizardSelect({
		theme: theme(), keybindings: keybindings(), title: "Sources", items: items(2),
		requestRender: () => {}, done: () => {},
	});
	empty.handleInput("zzzz");
	assert.match(empty.render(62).join("\n"), /No matching commands/);
});

test("text viewer has a tested scrolling viewport", () => {
	let closed = false;
	const component = new WizardTextView({
		theme: theme(),
		keybindings: keybindings(),
		title: "Diagnostics",
		lines: Array.from({ length: 40 }, (_, index) => `Diagnostic line ${index + 1}`),
		requestRender: () => {},
		done: () => { closed = true; },
	});
	const first = component.render(62);
	assertWidthSafe(first, 62);
	assert.ok(first.length <= 18);
	assert.match(first.join("\n"), /Lines 1–14 of 40/);
	component.handleInput("\x1b[6~");
	assert.match(component.render(62).join("\n"), /Lines 15–28 of 40/);
	component.handleInput("\x1b");
	assert.equal(closed, true);
});

test("text input starts at the end and retains invalid edits inline", () => {
	let submitted: string | undefined;
	const component = new WizardInput({
		theme: theme(),
		keybindings: keybindings(),
		title: "Context window",
		description: "Enter a positive whole number.",
		initialValue: "128000",
		validate: (value) => /^\d+$/.test(value) ? null : "Use digits only.",
		requestRender: () => {},
		done: (value) => { submitted = value; },
	});
	component.handleInput("x");
	component.handleInput("\r");
	assert.equal(submitted, undefined, "invalid input stays open");
	const invalid = component.render(62);
	assert.match(invalid.join("\n"), /128000x/);
	assert.match(invalid.join("\n"), /Use digits only/);
	for (const width of [80, 62, 20, 1]) assertWidthSafe(component.render(width), width);
	component.handleInput("\x7f");
	component.handleInput("\r");
	assert.equal(submitted, "128000", "prefilled cursor was at the end");

	const cancelled = new WizardInput({
		theme: theme(), keybindings: keybindings(), title: "Name", initialValue: "keep-me", requestRender: () => {},
		done: (value) => { submitted = value; },
	});
	submitted = "sentinel";
	cancelled.handleInput("\x1b");
	assert.equal(submitted, undefined);
});

test("secret input is focusable, masked, width-safe, and cancellable", () => {
	let submitted: string | undefined;
	const component = new WizardSecretInput({
		theme: theme(),
		keybindings: keybindings(),
		title: "API key",
		description: "Paste a provider credential. It is saved only in the private configuration.",
		requestRender: () => {},
		done: (value) => { submitted = value; },
	});
	assert.equal(component.focused, true);
	component.handleInput("top-secret-value");
	for (const width of [80, 62, 20, 1]) {
		const lines = component.render(width);
		assertWidthSafe(lines, width);
		assert.doesNotMatch(lines.join("\n"), /top-secret-value/);
	}
	component.handleInput("\x1b[D");
	assert.ok(component.render(80).join("\n").includes(`${CURSOR_MARKER}\x1b[7m•`), "masked cursor follows the built-in Input cursor");
	component.handleInput("\r");
	assert.equal(submitted, "top-secret-value");

	const cancelled = new WizardSecretInput({
		theme: theme(), keybindings: keybindings(), title: "API key", description: "Masked", requestRender: () => {},
		done: (value) => { submitted = value; },
	});
	submitted = "sentinel";
	cancelled.handleInput("\x1b");
	assert.equal(submitted, undefined);
});

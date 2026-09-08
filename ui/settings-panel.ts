/** pi-extension-builder SettingsPanel v0.1.0 — canonical source and vendored primitive. */
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type KeyId,
} from "@earendil-works/pi-tui";

export type PanelRowKind = "toggle" | "input" | "cycle" | "action" | "info";
export type PanelValueStyle = "accent" | "success" | "warning" | "error" | "muted" | "text";

export interface PanelRow {
  key: string;
  label: string;
  value: string;
  kind: PanelRowKind;
  rawValue?: string;
  choices?: string[];
  inputHint?: string;
  valueStyle?: PanelValueStyle;
  disabled?: boolean;
}

export interface PanelSection {
  title: string;
  rows: PanelRow[];
}

export interface PanelShortcut {
  key: KeyId;
  label: string;
  action: string;
}

export interface PanelSnapshot {
  title: string;
  summaryLines?: string[];
  sections: PanelSection[];
  detailLines?: string[];
  idleMessage?: string;
  shortcuts?: PanelShortcut[];
}

export type PanelActionResult =
  | { kind: "updated"; message?: string }
  | { kind: "close"; action: string }
  | { kind: "error"; message: string }
  | { kind: "none" };

export interface PanelResult {
  action?: string;
}

export interface SettingsPanelHost {
  theme: Theme;
  keybindings: KeybindingsManager;
  initialKey?: string;
  snapshot(): PanelSnapshot;
  /** Apply a canonical setting value. Return an error string or null. */
  apply(key: string, rawValue: string): string | null;
  activate(key: string): PanelActionResult | void;
  requestRender(): void;
  done(result: PanelResult): void;
}

type FlashKind = "error" | "success" | "info";
interface Flash {
  kind: FlashKind;
  text: string;
}

/**
 * Reusable, synchronous control panel.
 *
 * Business logic stays in the host. The panel owns only navigation, editing,
 * rendering, and transient feedback. Async or destructive actions should
 * close with an action result and be handled by the command adapter.
 */
export class SettingsPanel implements Component, Focusable {
  private readonly host: SettingsPanelHost;
  private snapshotValue: PanelSnapshot;
  private cursor = 0;
  private editingKey: string | null = null;
  private input: Input | null = null;
  private flash: Flash | null = null;
  private _focused = false;

  constructor(host: SettingsPanelHost) {
    this.host = host;
    this.snapshotValue = host.snapshot();
    if (host.initialKey) this.focusRow(host.initialKey);
    this.clampCursor();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.input) this.input.focused = value;
  }

  invalidate(): void {
    this.input?.invalidate();
  }

  handleInput(data: string): void {
    if (this.input) {
      this.input.handleInput(data);
      this.host.requestRender();
      return;
    }

    const kb = this.host.keybindings;
    if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
      this.host.done({});
      return;
    }

    if (kb.matches(data, "tui.select.up") || matchesKey(data, "k")) {
      this.move(-1);
    } else if (kb.matches(data, "tui.select.down") || matchesKey(data, "j")) {
      this.move(1);
    } else if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "space")) {
      this.activateCurrent();
    } else {
      const shortcut = this.snapshotValue.shortcuts?.find((candidate) => matchesKey(data, candidate.key));
      if (!shortcut) return;
      this.runAction(shortcut.action, shortcut.label);
    }

    this.host.requestRender();
  }

  render(width: number): string[] {
    const t = this.host.theme;
    const lines: string[] = [this.topBorder(width, this.snapshotValue.title)];

    for (const line of this.snapshotValue.summaryLines ?? []) {
      lines.push(this.boxLine(t.fg("muted", ` ${line}`), width));
    }

    const selectedKey = this.selectableRows()[this.cursor]?.key;
    for (const section of this.snapshotValue.sections) {
      lines.push(this.boxLine(t.fg("accent", t.bold(` ${section.title}`)), width));
      for (const row of section.rows) {
        lines.push(this.renderRow(row, row.key === selectedKey, width));
      }
    }

    for (const line of this.snapshotValue.detailLines ?? []) {
      lines.push(this.boxLine(t.fg("dim", ` ${line}`), width));
    }

    lines.push(this.boxLine(this.renderMessageLine(), width));
    const shortcutLine = this.renderShortcutLine();
    if (shortcutLine) lines.push(this.boxLine(t.fg("dim", ` ${shortcutLine}`), width));
    lines.push(this.boxLine(t.fg("dim", ` ${this.renderNavigationLine()}`), width));
    lines.push(this.bottomBorder(width));
    return lines;
  }

  private allRows(): PanelRow[] {
    return this.snapshotValue.sections.flatMap((section) => section.rows);
  }

  private selectableRows(): PanelRow[] {
    return this.allRows().filter((row) => row.kind !== "info" && !row.disabled);
  }

  private focusRow(key: string): void {
    const index = this.selectableRows().findIndex((row) => row.key === key);
    if (index >= 0) this.cursor = index;
  }

  private clampCursor(): void {
    const rows = this.selectableRows();
    this.cursor = Math.max(0, Math.min(this.cursor, Math.max(0, rows.length - 1)));
  }

  /** Refresh derived rows while preserving the current selection when possible. */
  refresh(preferredKey?: string): void {
    const currentKey = preferredKey ?? this.selectableRows()[this.cursor]?.key;
    this.snapshotValue = this.host.snapshot();
    if (currentKey) this.focusRow(currentKey);
    this.clampCursor();
  }

  private move(delta: number): void {
    const rows = this.selectableRows();
    if (!rows.length) return;
    this.cursor = (this.cursor + delta + rows.length) % rows.length;
    this.flash = null;
  }

  private activateCurrent(): void {
    const row = this.selectableRows()[this.cursor];
    if (!row) return;

    if (row.kind === "input") {
      this.startEdit(row.key, row.rawValue ?? "");
      return;
    }

    if (row.kind === "toggle") {
      this.applyValue(row, row.rawValue === "true" ? "false" : "true");
      return;
    }

    if (row.kind === "cycle") {
      const choices = row.choices ?? [];
      if (!choices.length) return;
      const current = Math.max(0, choices.indexOf(row.rawValue ?? ""));
      this.applyValue(row, choices[(current + 1) % choices.length] ?? choices[0] ?? "");
      return;
    }

    if (row.kind === "action") this.runAction(row.key, row.label);
  }

  private applyValue(row: PanelRow, value: string): void {
    const error = this.host.apply(row.key, value);
    if (error) {
      this.flash = { kind: "error", text: error };
      return;
    }

    this.refresh(row.key);
    const fresh = this.allRows().find((candidate) => candidate.key === row.key);
    this.flash = { kind: "success", text: `${row.label}: ${fresh?.value ?? value}` };
  }

  private runAction(key: string, label: string): void {
    const result = this.host.activate(key) ?? { kind: "none" as const };
    if (result.kind === "close") {
      this.host.done({ action: result.action });
      return;
    }
    if (result.kind === "error") {
      this.flash = { kind: "error", text: result.message };
      return;
    }
    if (result.kind === "updated") {
      this.refresh(key);
      this.flash = { kind: "success", text: result.message ?? `${label} updated` };
      return;
    }
    this.flash = { kind: "info", text: label };
  }

  private startEdit(key: string, initialValue: string): void {
    this.editingKey = key;
    this.input = new Input();
    this.input.focused = this._focused;
    this.input.setValue(initialValue);
    // A fresh Input keeps its cursor at 0 after setValue(); move to End so a
    // prefilled setting edits naturally.
    this.input.handleInput("\x1b[F");
    this.flash = null;

    this.input.onSubmit = (value) => {
      const row = this.allRows().find((candidate) => candidate.key === key);
      if (!row) {
        this.cancelEdit();
        return;
      }
      const canonical = value.trim();
      const error = this.host.apply(key, canonical);
      if (error) {
        this.flash = { kind: "error", text: error };
        this.host.requestRender();
        return;
      }
      this.input = null;
      this.editingKey = null;
      this.refresh(key);
      const fresh = this.allRows().find((candidate) => candidate.key === key);
      this.flash = { kind: "success", text: `${row.label}: ${fresh?.value ?? canonical}` };
      this.host.requestRender();
    };

    this.input.onEscape = () => {
      this.cancelEdit();
      this.host.requestRender();
    };
  }

  private cancelEdit(): void {
    this.input = null;
    this.editingKey = null;
    this.flash = { kind: "info", text: "Edit cancelled" };
  }

  private renderRow(row: PanelRow, selected: boolean, width: number): string {
    const t = this.host.theme;
    const innerWidth = Math.max(1, width - 2);
    const selectable = row.kind !== "info" && !row.disabled;
    const prefix = selected ? t.fg("accent", " › ") : "   ";
    const labelColor = row.disabled ? "dim" : selected ? "accent" : row.kind === "info" ? "muted" : "text";
    const label = t.fg(labelColor, row.label);

    if (this.editingKey === row.key && this.input) {
      const left = `${prefix}${label}: `;
      const available = Math.max(1, innerWidth - visibleWidth(left) - 1);
      this.input.focused = this._focused;
      const inputLine = this.input.render(available)[0] ?? "";
      return this.boxLine(`${left}${inputLine}`, width);
    }

    const value = t.fg(this.valueColor(row), row.value);
    const left = `${selectable ? prefix : "   "}${label}`;
    const gap = Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(value) - 2);
    return this.boxLine(`${left}${" ".repeat(gap)}${value} `, width);
  }

  private renderMessageLine(): string {
    const t = this.host.theme;
    if (this.flash) {
      const color = this.flash.kind === "error" ? "error" : this.flash.kind === "success" ? "success" : "muted";
      return t.fg(color, ` ${this.flash.text}`);
    }
    if (this.editingKey) {
      const row = this.allRows().find((candidate) => candidate.key === this.editingKey);
      return t.fg("muted", ` ${row?.inputHint ?? "Enter saves · Esc cancels"}`);
    }
    return t.fg("dim", ` ${this.snapshotValue.idleMessage ?? "Changes save immediately"}`);
  }

  private renderShortcutLine(): string | null {
    const shortcuts = this.snapshotValue.shortcuts ?? [];
    if (!shortcuts.length) return null;
    return shortcuts.map((shortcut) => `${shortcut.key} ${shortcut.label}`).join(" · ");
  }

  private renderNavigationLine(): string {
    const kb = this.host.keybindings;
    const up = this.bindingText(kb.getKeys("tui.select.up"), "↑");
    const down = this.bindingText(kb.getKeys("tui.select.down"), "↓");
    const confirm = this.bindingText(kb.getKeys("tui.select.confirm"), "enter");
    const cancel = this.bindingText(kb.getKeys("tui.select.cancel"), "esc");
    return `${up}/${down}/jk move · ${confirm} select · ${cancel}/q close`;
  }

  private bindingText(keys: readonly string[], fallback: string): string {
    const first = keys[0];
    if (!first) return fallback;
    return first
      .replace(/^up$/, "↑")
      .replace(/^down$/, "↓")
      .replace(/^left$/, "←")
      .replace(/^right$/, "→")
      .replace(/^escape$/, "esc")
      .replace(/^return$/, "enter");
  }

  private valueColor(row: PanelRow): Parameters<Theme["fg"]>[0] {
    if (row.valueStyle) return row.valueStyle;
    if (row.disabled) return "dim";
    if (row.kind === "toggle") return row.rawValue === "true" ? "success" : "muted";
    if (row.kind === "action") return "accent";
    return "text";
  }

  private boxLine(content: string, width: number): string {
    const t = this.host.theme;
    if (width <= 1) return truncateToWidth(content, Math.max(1, width), "", true);
    const innerWidth = Math.max(0, width - 2);
    const clipped = truncateToWidth(content, innerWidth, "…", true);
    const padded = clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    return t.fg("border", "│") + padded + t.fg("border", "│");
  }

  private topBorder(width: number, title: string): string {
    const t = this.host.theme;
    if (width <= 1) return t.fg("borderAccent", "─".repeat(Math.max(1, width)));
    const innerWidth = Math.max(0, width - 2);
    const styledTitle = t.fg("accent", t.bold(` ${title} `));
    const clippedTitle = truncateToWidth(styledTitle, innerWidth, "", false);
    const tail = "─".repeat(Math.max(0, innerWidth - visibleWidth(clippedTitle)));
    return t.fg("border", "╭") + clippedTitle + t.fg("border", `${tail}╮`);
  }

  private bottomBorder(width: number): string {
    const t = this.host.theme;
    if (width <= 1) return t.fg("border", "─".repeat(Math.max(1, width)));
    return t.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  }
}

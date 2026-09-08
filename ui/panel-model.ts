import { CONFIG_PATH, MODES } from "../config.ts";
import { ExtensionController, formatSize } from "../application.ts";
import { EXTENSION_TITLE } from "../metadata.ts";
import type { PanelSnapshot } from "./settings-panel.ts";

/** Describe domain state as UI rows. This is derived data, never storage. */
export function buildPanelSnapshot(controller: ExtensionController): PanelSnapshot {
  const config = controller.config();
  return {
    title: EXTENSION_TITLE,
    summaryLines: [
      `State: ${config.enabled ? "enabled" : "disabled"} · mode: ${config.mode}`,
    ],
    sections: [
      {
        title: "General",
        rows: [
          {
            key: "enabled",
            label: "Extension",
            value: config.enabled ? "enabled" : "disabled",
            rawValue: String(config.enabled),
            kind: "toggle",
          },
          {
            key: "mode",
            label: "Mode",
            value: config.mode,
            rawValue: config.mode,
            choices: [...MODES],
            kind: "cycle",
          },
        ],
      },
      {
        title: "Limits",
        rows: [
          {
            key: "itemLimit",
            label: "Item limit",
            value: String(config.itemLimit),
            rawValue: String(config.itemLimit),
            inputHint: "Enter an integer from 1 to 100 · Esc cancels",
            kind: "input",
          },
          {
            key: "thresholdBytes",
            label: "Threshold",
            value: formatSize(config.thresholdBytes),
            rawValue: formatSize(config.thresholdBytes),
            inputHint: "Enter bytes, KB, or MB · Esc cancels",
            kind: "input",
          },
        ],
      },
      {
        title: "Maintenance",
        rows: [
          {
            key: "configPath",
            label: "Config path",
            value: CONFIG_PATH,
            valueStyle: "muted",
            kind: "info",
          },
          {
            key: "reset",
            label: "Reset settings",
            value: "confirm…",
            valueStyle: "warning",
            kind: "action",
          },
        ],
      },
    ],
    idleMessage: "Changes save immediately",
    shortcuts: [
      { key: "p", label: "paths", action: "paths" },
      { key: "r", label: "reset", action: "reset" },
    ],
  };
}

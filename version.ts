/**
 * model-discovery — loaded-version provenance (slice 0 of the UI alignment plan).
 *
 * A running Pi session keeps whatever extension code it loaded at startup;
 * this repo is loaded BY PATH from `~/.pi/agent/settings.json`, so a stale
 * in-process copy is indistinguishable from a fresh one without a version
 * line. Every panel summary, report header, and tool card therefore carries
 * the version actually executing, so "stale copy in this process" is
 * self-evident instead of mysterious.
 *
 * Thin wrapper (S2) over the canonical helper vendored at `ui/version.ts`
 * (kit source: `skills/pi-extension-builder/assets/control-panel/…`),
 * mirroring `custom-extensions/delegate/version.ts`: read once from the
 * `package.json` beside this module, cached, never hard-coded — public name
 * and return string unchanged.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { extensionVersion } from "./ui/version.ts";

export function modelDiscoveryVersion(): string {
	return extensionVersion({
		packageJsonPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json"),
	});
}

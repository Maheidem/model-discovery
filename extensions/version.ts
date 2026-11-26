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
 * Thin wrapper over `extensionVersion` of `@maheidem/pi-panel-kit`.
 * It reads the `package.json` one folder up from this module (the package
 * root), once, cached, never hard-coded. The public name and the return
 * string do not change.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { extensionVersion } from "@maheidem/pi-panel-kit";

export function modelDiscoveryVersion(): string {
	return extensionVersion({
		packageJsonPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
	});
}

/**
 * model-discovery — loaded-version provenance (slice 0 of the UI alignment plan).
 *
 * A running pi session keeps the extension code that it loaded at startup.
 * pi can load this extension from the npm store or from a local path. Each
 * panel summary, report header and tool card shows the version that runs,
 * so an old copy in the process is easy to see.
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

/**
 * model-discovery — loaded-version provenance (slice 0 of the UI alignment plan).
 *
 * A running Pi session keeps whatever extension code it loaded at startup;
 * this repo is loaded BY PATH from `~/.pi/agent/settings.json`, so a stale
 * in-process copy is indistinguishable from a fresh one without a version
 * line. Every panel summary, report header, and tool card (wired in slices
 * 1–2) therefore carries the version actually executing, so "stale copy in
 * this process" is self-evident instead of mysterious.
 *
 * Mirrors `custom-extensions/delegate/version.ts`: read once from the
 * `package.json` beside this module, cached, never hard-coded.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function modelDiscoveryVersion(): string {
	if (cached) return cached;
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8")) as {
			version?: string;
		};
		cached = pkg.version ?? "unknown";
	} catch {
		cached = "unknown";
	}
	return cached;
}

/**
 * ui/version.ts — canonical loaded-version provenance (S2, pi-panel-kit
 * stage 1).
 *
 * WHY THIS EXISTS
 * A running Pi session keeps whatever extension code it loaded at startup;
 * newer installs (npm store or by-path) only apply after `/reload`. A stale
 * in-process copy is indistinguishable from a fresh one unless every status
 * line, panel summary, and tool card carries the version actually EXECUTING.
 * This helper reads that version from the extension's own `package.json` —
 * never hard-coded, never baked at build time.
 *
 * Vendored byte-identically into consumers (guard: `node
 * skills/pi-extension-builder/scripts/check-vendored.mjs`); each extension
 * keeps a thin wrapper (`version.ts` at its package root) that exports its
 * original function name and passes the `package.json` path resolved from
 * THE WRAPPER'S module URL — a vendored copy sits in `ui/` and cannot find
 * the package root by itself, which is exactly why the path is a parameter.
 *
 * Pi-free by design: node built-ins only, no imports from sibling modules.
 */

import * as fs from "node:fs";

export interface ExtensionVersionOptions {
	/**
	 * Absolute path to the extension's `package.json`. Resolve it from the
	 * wrapper's own module URL (`path.join(dirname(fileURLToPath(import.meta.url)), "package.json")`)
	 * so the string is anchored to the code actually executing, not the cwd.
	 */
	packageJsonPath: string;
	/**
	 * Short extension name for composed headers. When set, the result is
	 * `label vX.Y.Z` (the `[delegate v0.3.2 …]` pattern used in result
	 * headers). Default: no label, bare version (status lines and panel
	 * summaries render their own prefixes).
	 */
	label?: string;
	/**
	 * Verbatim suffix appended after the version, e.g.
	 * `" (loaded at session start; /reload picks up newer installs)"`.
	 * Default: none. Call sites that interpolate the suffix themselves keep
	 * passing nothing — identical output either way.
	 */
	suffix?: string;
	/** Returned when `package.json` is unreadable/unparsable or lacks `version`. Default `"unknown"`. */
	fallback?: string;
}

/** Raw versions keyed by resolved package.json path; read once per process. */
const cache = new Map<string, string>();

/** The `version` field of the extension's package.json (never a hardcoded string). */
export function extensionVersion(options: ExtensionVersionOptions): string {
	const fallback = options.fallback ?? "unknown";
	let version = cache.get(options.packageJsonPath);
	if (version === undefined) {
		try {
			const pkg = JSON.parse(fs.readFileSync(options.packageJsonPath, "utf8")) as {
				version?: string;
			};
			version = pkg.version ?? fallback;
		} catch {
			version = fallback;
		}
		cache.set(options.packageJsonPath, version);
	}
	return `${options.label ? `${options.label} v` : ""}${version}${options.suffix ?? ""}`;
}

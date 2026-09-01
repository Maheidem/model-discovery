export type DiscoveryIntent =
	| { kind: "open" }
	| { kind: "status" }
	| { kind: "doctor" }
	| { kind: "paths" }
	| { kind: "help" }
	| { kind: "add"; url?: string; providerName?: string }
	| { kind: "remove"; name: string; confirmed: boolean }
	| { kind: "invalid"; message: string };

export const DISCOVER_USAGE = [
	"/discover                         open the source wizard (status outside TUI)",
	"/discover <url>                   add a source (existing shorthand)",
	"/discover status                  show source and catalogue health",
	"/discover doctor                  show actionable diagnostics",
	"/discover paths                   show the configuration path",
	"/discover source list             list configured sources",
	"/discover source add <url>         add an unauthenticated source or open its TUI wizard",
	"/discover source remove <name>     remove with TUI confirmation",
	"/discover source remove <name> --yes  remove non-interactively",
	"/discover help                    show this help",
].join("\n");

const URL_SHORTHAND = /^(?:https?:\/\/|localhost(?::|\/|$)|\[[0-9a-f:]+\]:\d+|(?:\d{1,3}\.){3}\d{1,3}(?::|\/|$)|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|$)|[^\s/:]+:\d+)/i;

export function parseDiscoverArgs(args?: string): DiscoveryIntent {
	const raw = (args ?? "").trim();
	if (!raw) return { kind: "open" };
	if (raw === "status" || raw === "source list") return { kind: "status" };
	if (raw === "doctor") return { kind: "doctor" };
	if (raw === "paths") return { kind: "paths" };
	if (raw === "help") return { kind: "help" };
	if (raw === "source add") return { kind: "add" };
	if (raw.startsWith("source add ")) {
		const tokens = raw.slice("source add ".length).trim().split(/\s+/);
		const url = tokens.shift();
		if (!url) return { kind: "invalid", message: "Missing source URL." };
		if (!tokens.length) return { kind: "add", url };
		if (tokens[0] === "--name" && tokens[1] && tokens.length === 2) {
			return { kind: "add", url, providerName: tokens[1] };
		}
		return { kind: "invalid", message: `Invalid source add arguments: ${tokens.join(" ")}` };
	}
	if (raw === "source remove") return { kind: "invalid", message: "Missing source name." };
	if (raw.startsWith("source remove ")) {
		let specification = raw.slice("source remove ".length).trim();
		const confirmed = specification.endsWith(" --yes");
		if (confirmed) specification = specification.slice(0, -" --yes".length).trim();
		if (!specification) return { kind: "invalid", message: "Missing source name." };
		return { kind: "remove", name: specification, confirmed };
	}
	if (URL_SHORTHAND.test(raw)) return { kind: "add", url: raw };
	return { kind: "invalid", message: `Unknown /discover input: ${raw}` };
}

export function completeDiscoverArgs(prefix: string, sourceNames: readonly string[]): Array<{ value: string; label: string }> | null {
	const values = [
		"status",
		"doctor",
		"paths",
		"help",
		"source list",
		"source add ",
		"source remove ",
		...sourceNames.map((name) => `source remove ${name}`),
		...sourceNames.map((name) => `source remove ${name} --yes`),
	];
	const matches = values.filter((value) => value.startsWith(prefix));
	return matches.length ? matches.map((value) => ({ value, label: value })) : null;
}

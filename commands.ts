export type DiscoveryIntent =
	| { kind: "open" }
	| { kind: "status" }
	| { kind: "doctor" }
	| { kind: "paths" }
	| { kind: "help" }
	| { kind: "add"; url?: string; providerName?: string }
	| { kind: "remove"; name: string; confirmed: boolean }
	| { kind: "rescan-all" }
	// --- nested mutation verbs (slice 3, D3 all-mutations parity) ---------
	| { kind: "source-open"; name: string }
	| { kind: "source-rename"; oldName: string; newName: string }
	| { kind: "source-auth"; name: string; keyFromEnv?: string }
	| { kind: "source-defaults"; name: string; contextWindow?: number; maxTokens?: number }
	| { kind: "source-rescan"; name: string }
	| { kind: "model-set"; modelId: string; field: "vision" | "reasoning" | "contextWindow" | "maxTokens"; value: string; source?: string }
	| { kind: "preset-set"; source: string; modelId: string; slug: string; field: string; value: string }
	| { kind: "preset-remove"; source: string; modelId: string; slug: string; confirmed: boolean }
	| { kind: "routing-set"; source: string; modelId: string; level: string; slug: string }
	| { kind: "routing-conventional"; source: string; modelId: string }
	| { kind: "routing-remove"; source: string; modelId: string; confirmed: boolean }
	| { kind: "invalid"; message: string };

export const DISCOVER_USAGE = [
	"/discover                          open the home dashboard (status outside TUI)",
	"/discover <url>                    add a source (shorthand for source add)",
	"/discover status                   show source and catalogue health",
	"/discover doctor                   show actionable diagnostics",
	"/discover rescan-all              refetch + re-register every source",
	"/discover paths                    show the configuration path",
	"/discover help                     show this help",
	"",
	"sources",
	"/discover source list                     list configured sources",
	"/discover source add <url> [--name n]   add a source (TUI probe flow / headless probe+register)",
	"/discover source open <name>            open a source panel (TUI)",
	"/discover source rename <old> <new>     rename a source (re-registers it)",
	"/discover source auth <name> --key-from-env ENV   set the API key from an environment variable",
	"/discover source auth <name>            set the API key via the masked TUI field",
	"/discover source defaults <name> ctx <n> [max <n>] fallback defaults for unreported values",
	"/discover source rescan <name>          refetch + re-register one source",
	"/discover source remove <name>          remove with TUI confirmation",
	"/discover source remove <name> --yes    remove non-interactively",
	"",
	"models (add --source <name> when the id exists on several sources)",
	"/discover model <id> vision on|off             toggle image input",
	"/discover model <id> reasoning on|off          toggle reasoning",
	"/discover model <id> ctx <n> | max <n>        override context window / max output",
	"",
	"presets and adaptive routing",
	"/discover preset set <source> <modelId> <slug> <field> <value>",
	"/discover preset remove <source> <modelId> <slug> [--yes]",
	"/discover routing set <source> <modelId> <level> <slug>",
	"/discover routing remove <source> <modelId> [--yes]",
].join("\n");

const URL_SHORTHAND = /^(?:https?:\/\/|localhost(?::|\/|$)|\[[0-9a-f:]+\]:\d+|(?:\d{1,3}\.){3}\d{1,3}(?::|\/|$)|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|$)|[^\s/:]+:\d+)/i;

function positiveInt(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const normalized = raw.trim().replace(/[,._\s]/g, "");
	if (!/^\d+$/.test(normalized)) return undefined;
	const n = Number(normalized);
	return n > 0 ? n : undefined;
}

function flagValue(tokens: string[], flag: string): string | undefined {
	const i = tokens.indexOf(flag);
	return i >= 0 ? tokens[i + 1] : undefined;
}

export function parseDiscoverArgs(args?: string): DiscoveryIntent {
	const raw = (args ?? "").trim();
	if (!raw) return { kind: "open" };
	if (raw === "status" || raw === "source list") return { kind: "status" };
	if (raw === "doctor") return { kind: "doctor" };
	if (raw === "rescan-all" || raw === "rescan all") return { kind: "rescan-all" };
	if (raw === "paths") return { kind: "paths" };
	if (raw === "help") return { kind: "help" };
	if (raw === "source add") return { kind: "add" };
	if (raw.startsWith("source add ")) {
		const tokens = raw.slice("source add ".length).trim().split(/\s+/);
		const url = tokens.shift();
		if (!url) return { kind: "invalid", message: "Missing source URL." };
		const providerName = flagValue(tokens, "--name");
		const rest = tokens.filter((t) => t !== "--name").filter((t) => t !== providerName);
		if (rest.length) return { kind: "invalid", message: `Invalid source add arguments: ${rest.join(" ")}` };
		return { kind: "add", url, providerName };
	}
	if (raw === "source remove") return { kind: "invalid", message: "Missing source name." };
	if (raw.startsWith("source remove ")) {
		let specification = raw.slice("source remove ".length).trim();
		const confirmed = specification.endsWith(" --yes");
		if (confirmed) specification = specification.slice(0, -" --yes".length).trim();
		if (!specification) return { kind: "invalid", message: "Missing source name." };
		return { kind: "remove", name: specification, confirmed };
	}
	if (raw.startsWith("source open ")) {
		const name = raw.slice("source open ".length).trim();
		return name ? { kind: "source-open", name } : { kind: "invalid", message: "Missing source name." };
	}
	if (raw.startsWith("source rename ")) {
		const tokens = raw.slice("source rename ".length).trim().split(/\s+/);
		if (tokens.length !== 2 || !tokens[0] || !tokens[1]) {
			return { kind: "invalid", message: "Usage: /discover source rename <old> <new>" };
		}
		return { kind: "source-rename", oldName: tokens[0], newName: tokens[1] };
	}
	if (raw.startsWith("source auth ")) {
		const tokens = raw.slice("source auth ".length).trim().split(/\s+/);
		const name = tokens.shift();
		if (!name) return { kind: "invalid", message: "Missing source name." };
		const hasFlag = tokens.includes("--key-from-env");
		const keyFromEnv = flagValue(tokens, "--key-from-env");
		if (!hasFlag) {
			return tokens.length ? { kind: "invalid", message: "Secrets are accepted only via --key-from-env ENV (never inline)." } : { kind: "source-auth", name };
		}
		if (!keyFromEnv) return { kind: "invalid", message: "Missing environment variable name after --key-from-env." };
		if (tokens.length !== 2) return { kind: "invalid", message: "Usage: /discover source auth <name> --key-from-env ENV" };
		return { kind: "source-auth", name, keyFromEnv };
	}
	if (raw.startsWith("source rescan ")) {
		const name = raw.slice("source rescan ".length).trim();
		return name ? { kind: "source-rescan", name } : { kind: "invalid", message: "Missing source name." };
	}
	if (raw.startsWith("source defaults ")) {
		const tokens = raw.slice("source defaults ".length).trim().split(/\s+/);
		const name = tokens.shift();
		if (!name) return { kind: "invalid", message: "Missing source name." };
		let contextWindow: number | undefined;
		let maxTokens: number | undefined;
		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i] === "ctx" || tokens[i] === "defaultContextWindow") {
				contextWindow = positiveInt(tokens[++i]);
				if (contextWindow === undefined) return { kind: "invalid", message: "ctx must be a positive whole number." };
			} else if (tokens[i] === "max" || tokens[i] === "defaultMaxTokens") {
				maxTokens = positiveInt(tokens[++i]);
				if (maxTokens === undefined) return { kind: "invalid", message: "max must be a positive whole number." };
			} else {
				return { kind: "invalid", message: `Invalid source defaults arguments: ${tokens.slice(i).join(" ")}` };
			}
		}
		if (contextWindow === undefined && maxTokens === undefined) {
			return { kind: "invalid", message: "Nothing to change — pass ctx <n> and/or max <n>." };
		}
		return { kind: "source-defaults", name, contextWindow, maxTokens };
	}
	if (raw.startsWith("model ") && !URL_SHORTHAND.test(raw)) {
		const tokens = raw.slice("model ".length).trim().split(/\s+/);
		const modelId = tokens.shift();
		const sub = tokens.shift();
		if (!modelId || !sub) return { kind: "invalid", message: "Usage: /discover model <id> vision|reasoning on|off | ctx|max <n> [--source <name>]" };
		const source = flagValue(tokens, "--source");
		if (sub === "vision" || sub === "reasoning") {
			const value = tokens.find((t) => t === "on" || t === "off");
			if (!value) return { kind: "invalid", message: `Usage: /discover model <id> ${sub} on|off` };
			return { kind: "model-set", modelId, field: sub, value, source };
		}
		if (sub === "ctx" || sub === "max") {
			const field = sub === "ctx" ? "contextWindow" : "maxTokens";
			const n = positiveInt(tokens.find((t) => !t.startsWith("--") && t !== source));
			if (n === undefined) return { kind: "invalid", message: "Value must be a positive whole number." };
			return { kind: "model-set", modelId, field, value: String(n), source };
		}
		return { kind: "invalid", message: `Unknown model field: ${sub}` };
	}
	if (raw.startsWith("preset set ")) {
		const tokens = raw.slice("preset set ".length).trim().split(/\s+/);
		if (tokens.length < 5) return { kind: "invalid", message: "Usage: /discover preset set <source> <modelId> <slug> <field> <value>" };
		const [source, modelId, slug, field, ...valueTokens] = tokens;
		const value = valueTokens.join(" ");
		if (!source || !modelId || !slug || !field || value === "") return { kind: "invalid", message: "Usage: /discover preset set <source> <modelId> <slug> <field> <value>" };
		return { kind: "preset-set", source, modelId, slug, field, value };
	}
	if (raw.startsWith("preset remove ")) {
		let rest = raw.slice("preset remove ".length).trim();
		const confirmed = rest.endsWith(" --yes");
		if (confirmed) rest = rest.slice(0, -" --yes".length).trim();
		const tokens = rest.split(/\s+/);
		if (tokens.length !== 3) return { kind: "invalid", message: "Usage: /discover preset remove <source> <modelId> <slug> [--yes]" };
		return { kind: "preset-remove", source: tokens[0], modelId: tokens[1], slug: tokens[2], confirmed };
	}
	if (raw.startsWith("routing set ")) {
		const tokens = raw.slice("routing set ".length).trim().split(/\s+/);
		if (tokens.length !== 4) return { kind: "invalid", message: "Usage: /discover routing set <source> <modelId> <level> <slug>" };
		return { kind: "routing-set", source: tokens[0], modelId: tokens[1], level: tokens[2], slug: tokens[3] };
	}
	if (raw.startsWith("routing conventional ")) {
		const tokens = raw.slice("routing conventional ".length).trim().split(/\s+/);
		if (tokens.length !== 2) return { kind: "invalid", message: "Usage: /discover routing conventional <source> <modelId>" };
		return { kind: "routing-conventional", source: tokens[0], modelId: tokens[1] };
	}
	if (raw.startsWith("routing remove ")) {
		let rest = raw.slice("routing remove ".length).trim();
		const confirmed = rest.endsWith(" --yes");
		if (confirmed) rest = rest.slice(0, -" --yes".length).trim();
		const tokens = rest.split(/\s+/);
		if (tokens.length !== 2) return { kind: "invalid", message: "Usage: /discover routing remove <source> <modelId> [--yes]" };
		return { kind: "routing-remove", source: tokens[0], modelId: tokens[1], confirmed };
	}
	if (URL_SHORTHAND.test(raw)) return { kind: "add", url: raw };
	return { kind: "invalid", message: `Unknown /discover input: ${raw}` };
}

export function completeDiscoverArgs(prefix: string, sourceNames: readonly string[]): Array<{ value: string; label: string }> | null {
	const values = [
		"status",
		"doctor",
		"rescan-all",
		"paths",
		"help",
		"source list",
		"source add ",
		"source open ",
		"source rename ",
		"source auth ",
		"source defaults ",
		"source rescan ",
		"source remove ",
		"model ",
		"preset set ",
		"preset remove ",
		"routing set ",
		"routing conventional ",
		"routing remove ",
		...sourceNames.map((name) => `source remove ${name}`),
		...sourceNames.map((name) => `source remove ${name} --yes`),
		...sourceNames.map((name) => `source open ${name}`),
		...sourceNames.map((name) => `source rename ${name} `),
		...sourceNames.map((name) => `source auth ${name}`),
		...sourceNames.map((name) => `source auth ${name} --key-from-env `),
		...sourceNames.map((name) => `source defaults ${name} `),
		...sourceNames.map((name) => `source rescan ${name}`),
		...sourceNames.map((name) => `preset set ${name} `),
		...sourceNames.map((name) => `preset remove ${name} `),
		...sourceNames.map((name) => `routing set ${name} `),
		...sourceNames.map((name) => `routing conventional ${name} `),
		...sourceNames.map((name) => `routing remove ${name} `),
	];
	const matches = values.filter((value) => value.startsWith(prefix));
	return matches.length ? matches.map((value) => ({ value, label: value })) : null;
}

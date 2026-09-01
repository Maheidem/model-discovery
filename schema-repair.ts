/**
 * Tool-schema repair for self-hosted OpenAI-compatible backends.
 *
 * WHY THIS EXISTS
 * ---------------
 * llama.cpp's `json_schema_to_grammar` (the converter behind llama.cpp, llama-swap,
 * LM Studio, and LiteLLM routes that forward to them) resolves `$ref` pointers
 * **only against the root of the tool schema document**. MCP servers commonly build
 * tool schemas by nesting Pydantic `model_json_schema()` output inside a hand-written
 * parent schema, which leaves `$defs` sitting on an inner node while the `$ref`s
 * inside it stay root-relative:
 *
 *   { "properties": { "patch": {
 *       "$defs": { "GuidelineMetricInput": { ... } },        // defs live HERE
 *       "properties": { "metrics": { "items": { "$ref": "#/$defs/GuidelineMetricInput" } } }
 *   }}}
 *
 * The pointer says "document root", but `$defs` is not at the root, so llama.cpp
 * rejects the whole request:
 *
 *   HTTP 400 {"code":400,"message":"JSON schema conversion failed:
 *             Error resolving ref #/$defs/GuidelineMetricInput: $defs not in {...}"}
 *
 * The broken tool rides along in the tool list, so *every* message in the session
 * fails — which looks like the endpoint, the proxy, or model discovery is broken.
 *
 * Verified live against llama-swap v251 -> llama.cpp b10612:
 *   nested `$defs` + root-relative `$ref` -> HTTP 400 (the failure above)
 *   `$defs` hoisted to document root      -> HTTP 200 (~15 s grammar compile)
 *   `$ref`s fully inlined, no `$defs`    -> HTTP 200 (fast; what this module does)
 *
 * That build has a second, exact converter bug: a string with `maxLength: 2000`
 * below an array's `items` schema produces "Failed to initialize samplers: failed
 * to parse grammar". The neighbouring values 1999 and 2001, and even 65536, work.
 * The wire schema therefore uses 2001 at that exact position; the MCP server remains
 * the source of truth and still validates the real 2000-character limit.
 *
 * BEHAVIOUR
 * ---------
 * `repairRequestToolSchemas(payload)` normalises every tool schema in an outgoing
 * /chat/completions payload:
 *   1. `$defs` / `definitions` found at ANY depth are hoisted to a root registry
 *      (name collisions are de-duplicated, local refs rewritten to match);
 *   2. every `$ref` is inlined, iteratively, so refs-to-refs collapse;
 *   3. unresolvable or cyclic refs become permissive nodes instead of a hard 400;
 *   4. `$defs` / `definitions` / `$ref` never reach the wire;
 *   5. nested-array `maxLength: 2000` is changed to 2001 for llama.cpp grammar
 *      compatibility (only that exact, proven-broken value).
 *
 * No-op (original object identity, zero cloning) when nothing needs repairing.
 */

export interface ToolSchemaRepairReport {
	/** Names of tools whose parameters schema was rewritten. */
	repairedTools: string[];
	/** `$ref` targets that could not be resolved; loosened to accept anything. */
	droppedRefs: string[];
	/** `$ref` targets forming a cycle; loosened to accept anything. */
	cyclicRefs: string[];
	/** Exact nested-array maxLength=2000 occurrences changed to 2001. */
	adjustedGrammarLimits: number;
	/** True when the payload was replaced (false = original identity kept). */
	changed: boolean;
}

const EMPTY_REPORT: ToolSchemaRepairReport = {
	repairedTools: [],
	droppedRefs: [],
	cyclicRefs: [],
	adjustedGrammarLimits: 0,
	changed: false,
};

const NOTICE_LIMIT = 6;
const MAX_DEPTH = 512;
export const LLAMA_CPP_BROKEN_NESTED_MAX_LENGTH = 2000;
export const LLAMA_CPP_SAFE_NESTED_MAX_LENGTH = 2001;

const DEFS_KEYWORDS = ["$defs", "definitions"];
const REF_KEYWORDS = ["$ref"];

/** Keywords whose value is a single subschema. */
const SCHEMA_KEYWORDS = new Set([
	"items",
	"additionalItems",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
	"contains",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
]);

/** Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAY_KEYWORDS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

/** Keywords whose value is a map of name -> subschema. */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "dependentSchemas"]);

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fingerprint(value: unknown): string {
	return JSON.stringify(value) ?? "";
}

// ---------------------------------------------------------------------------
// Detection (fast path)
// ---------------------------------------------------------------------------

export function schemaNeedsRepair(node: unknown, depth = 0, insideArrayItem = false): boolean {
	if (depth > MAX_DEPTH) return false;
	if (Array.isArray(node)) {
		for (const item of node) if (schemaNeedsRepair(item, depth + 1, insideArrayItem)) return true;
		return false;
	}
	if (!isRecord(node)) return false;
	if (insideArrayItem && node.maxLength === LLAMA_CPP_BROKEN_NESTED_MAX_LENGTH) return true;
	for (const key of REF_KEYWORDS) if (typeof node[key] === "string") return true;
	for (const key of DEFS_KEYWORDS) if (isRecord(node[key])) return true;
	for (const [key, value] of Object.entries(node)) {
		const childInsideArrayItem = insideArrayItem || (key === "items" && node.type === "array");
		if (schemaNeedsRepair(value, depth + 1, childInsideArrayItem)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// JSON pointer helpers
// ---------------------------------------------------------------------------

function decodeToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

interface ParsedRef {
	kind: "defs" | "pointer" | "external";
	tokens: string[];
}

/** Split `$ref` into its kind and path tokens. Only same-document refs are resolvable. */
export function parseRef(ref: string): ParsedRef {
	if (!ref.startsWith("#") && !ref.startsWith("/")) return { kind: "external", tokens: [] };
	if (ref.includes("://")) return { kind: "external", tokens: [] };
	const fragment = (ref.startsWith("#") ? ref.slice(1) : ref).replace(/^\//, "");
	if (fragment === "") return { kind: "pointer", tokens: [] };
	const tokens = fragment.split("/").map(decodeToken);
	if (tokens.length > 1 && (tokens[0] === "$defs" || tokens[0] === "definitions")) {
		return { kind: "defs", tokens: tokens.slice(1) };
	}
	return { kind: "pointer", tokens };
}

function lookupPointer(root: unknown, tokens: string[]): unknown {
	let cursor: unknown = root;
	for (const token of tokens) {
		if (Array.isArray(cursor)) {
			const index = Number(token);
			if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return undefined;
			cursor = cursor[index];
		} else if (isRecord(cursor) && token in cursor) {
			cursor = cursor[token];
		} else {
			return undefined;
		}
	}
	return cursor;
}

function sanitizeName(raw: string): string {
	return raw.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Register `def` under a unique key; identical content reuses the existing key. */
function claimKey(registry: Rec, preferred: string, def: unknown): string {
	const base = sanitizeName(preferred) || `Def${Object.keys(registry).length + 1}`;
	if (!(base in registry)) return base;
	if (fingerprint(registry[base]) === fingerprint(def)) return base;
	let key = `${base}_2`;
	let n = 2;
	while (key in registry && fingerprint(registry[key]) !== fingerprint(def)) {
		key = `${base}_${++n}`;
	}
	return key;
}

/** Rewrite `#/$defs/X` / `#/definitions/X` refs according to a rename map. */
function applyRenames(node: unknown, renames: Map<string, string>, depth = 0): unknown {
	if (depth > MAX_DEPTH || renames.size === 0) return node;
	if (Array.isArray(node)) return node.map((item) => applyRenames(item, renames, depth + 1));
	if (!isRecord(node)) return node;
	const next: Rec = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "$ref" && typeof value === "string") {
			const parsed = parseRef(value);
			if (parsed.kind === "defs" && parsed.tokens.length === 1) {
				next[key] = `#/$defs/${renames.get(parsed.tokens[0]) ?? parsed.tokens[0]}`;
				continue;
			}
			next[key] = value;
			continue;
		}
		next[key] = applyRenames(value, renames, depth + 1);
	}
	return next;
}

// ---------------------------------------------------------------------------
// Pass 1 — hoist every nested $defs / definitions to a root registry
// ---------------------------------------------------------------------------

function hoistDefs(node: unknown, registry: Rec, depth = 0): unknown {
	if (depth > MAX_DEPTH) return node;
	if (Array.isArray(node)) return node.map((item) => hoistDefs(item, registry, depth + 1));
	if (!isRecord(node)) return node;

	// Definitions declared on THIS node (the Pydantic-nesting artefact). They are
	// invisible to a root-scoped resolver, so lift them and rename on collision.
	const renames = new Map<string, string>();
	const pending: Array<{ key: string; def: unknown }> = [];
	for (const defsKey of DEFS_KEYWORDS) {
		const defs = node[defsKey];
		if (!isRecord(defs)) continue;
		for (const [name, def] of Object.entries(defs)) {
			const key = claimKey(registry, name, def);
			renames.set(name, key);
			pending.push({ key, def });
		}
	}

	const out: Rec = {};
	for (const [key, value] of Object.entries(node)) {
		if (DEFS_KEYWORDS.includes(key)) continue;
		out[key] = hoistDefs(applyRenames(value, renames), registry, depth + 1);
	}

	// Register after the subtree so nested defs inside them get claimed too.
	for (const { key, def } of pending) {
		if (!(key in registry)) {
			registry[key] = hoistDefs(applyRenames(def, renames), registry, depth + 1);
		}
	}

	return out;
}

// ---------------------------------------------------------------------------
// Pass 2 — inline every $ref
// ---------------------------------------------------------------------------

interface InlineState {
	dropped: string[];
	cyclic: string[];
}

function resolveRefTarget(ref: string, registry: Rec, root: Rec): unknown {
	const parsed = parseRef(ref);
	if (parsed.kind === "external") return undefined;
	if (parsed.kind === "defs") {
		const head = lookupPointer(registry, parsed.tokens);
		if (head !== undefined) return head;
		return lookupPointer(root, parsed.tokens); // fall back to literal root path
	}
	return lookupPointer(root, parsed.tokens);
}

function inlineRefs(node: unknown, registry: Rec, root: Rec, stack: string[], state: InlineState, depth = 0): unknown {
	if (depth > MAX_DEPTH) return {};
	if (Array.isArray(node)) return node.map((item) => inlineRefs(item, registry, root, stack, state, depth + 1));
	if (!isRecord(node)) return node;

	const own: Rec = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "$ref" || DEFS_KEYWORDS.includes(key)) continue;
		if (SCHEMA_KEYWORDS.has(key)) own[key] = inlineRefs(value, registry, root, stack, state, depth + 1);
		else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
			own[key] = value.map((item) => inlineRefs(item, registry, root, stack, state, depth + 1));
		} else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
			const bag: Rec = {};
			for (const [pk, pv] of Object.entries(value)) bag[pk] = inlineRefs(pv, registry, root, stack, state, depth + 1);
			own[key] = bag;
		} else if (key === "required" && Array.isArray(value)) own[key] = [...value];
		else own[key] = value;
	}

	const ref = node.$ref;
	if (typeof ref !== "string") return own;

	if (stack.includes(ref)) {
		// Recursive schema — cannot inline infinitely. Accept anything at this node.
		state.cyclic.push(ref);
		return own;
	}
	const target = resolveRefTarget(ref, registry, root);
	if (target === undefined) {
		// Dangling pointer. llama.cpp fails the entire request on these.
		state.dropped.push(ref);
		return own;
	}
	const inlined = inlineRefs(target, registry, root, [...stack, ref], state, depth + 1);
	// Target supplies structure; local siblings (description/title/examples) win.
	return { ...(isRecord(inlined) ? inlined : {}), ...own };
}

/** Last line of defence: no `$ref` / `$defs` may survive onto the wire. */
function stripRefArtifacts(node: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH) return {};
	if (Array.isArray(node)) return node.map((item) => stripRefArtifacts(item, depth + 1));
	if (!isRecord(node)) return node;
	const next: Rec = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "$ref" || DEFS_KEYWORDS.includes(key)) continue;
		next[key] = stripRefArtifacts(value, depth + 1);
	}
	return next;
}

interface GrammarCompatibilityState {
	adjustedLimits: number;
}

/**
 * Work around llama.cpp b10612's exact nested-array maxLength=2000 parser bug.
 * 1999, 2001, and much larger values work; 2001 is the least permissive safe wire
 * value and the MCP tool still enforces its authoritative 2000-character limit.
 */
function normalizeGrammarCompatibility(
	node: unknown,
	state: GrammarCompatibilityState,
	insideArrayItem = false,
	depth = 0,
): unknown {
	if (depth > MAX_DEPTH) return {};
	if (Array.isArray(node)) {
		return node.map((item) => normalizeGrammarCompatibility(item, state, insideArrayItem, depth + 1));
	}
	if (!isRecord(node)) return node;
	const next: Rec = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "maxLength" && insideArrayItem && value === LLAMA_CPP_BROKEN_NESTED_MAX_LENGTH) {
			next[key] = LLAMA_CPP_SAFE_NESTED_MAX_LENGTH;
			state.adjustedLimits++;
			continue;
		}
		const childInsideArrayItem = insideArrayItem || (key === "items" && node.type === "array");
		next[key] = normalizeGrammarCompatibility(value, state, childInsideArrayItem, depth + 1);
	}
	return next;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SingleSchemaRepair {
	schema: unknown;
	repaired: boolean;
	dropped: string[];
	cyclic: string[];
	adjustedGrammarLimits: number;
}

/** Repair one tool `parameters` schema. Returns the original identity when clean. */
export function repairToolSchema(parameters: unknown): SingleSchemaRepair {
	if (!isRecord(parameters) || !schemaNeedsRepair(parameters)) {
		return { schema: parameters, repaired: false, dropped: [], cyclic: [], adjustedGrammarLimits: 0 };
	}
	const registry: Rec = {};
	// Seed with the author's own root-level defs so root refs still resolve.
	for (const defsKey of DEFS_KEYWORDS) {
		const defs = parameters[defsKey];
		if (isRecord(defs)) {
			for (const [name, def] of Object.entries(defs)) {
				const key = claimKey(registry, name, def);
				registry[key] = def;
			}
		}
	}
	const hoisted = hoistDefs(parameters, registry);
	const state: InlineState = { dropped: [], cyclic: [] };
	const inlined = inlineRefs(hoisted, registry, parameters, [], state);
	const cleaned = stripRefArtifacts(inlined);
	const grammarState: GrammarCompatibilityState = { adjustedLimits: 0 };
	const compatible = normalizeGrammarCompatibility(cleaned, grammarState);
	return {
		schema: compatible,
		repaired: fingerprint(compatible) !== fingerprint(parameters),
		dropped: [...new Set(state.dropped)],
		cyclic: [...new Set(state.cyclic)],
		adjustedGrammarLimits: grammarState.adjustedLimits,
	};
}

/** Repair every tool schema in an outgoing chat/completions payload (identity if clean). */
export function repairRequestToolSchemas(payload: unknown): { payload: unknown; report: ToolSchemaRepairReport } {
	if (!isRecord(payload)) return { payload, report: EMPTY_REPORT };
	const tools = payload.tools;
	if (!Array.isArray(tools) || tools.length === 0) return { payload, report: EMPTY_REPORT };

	const repairedTools: string[] = [];
	const droppedRefs: string[] = [];
	const cyclicRefs: string[] = [];
	let adjustedGrammarLimits = 0;
	let nextTools: unknown[] | undefined;

	tools.forEach((tool, index) => {
		if (!isRecord(tool)) return;
		const fn = isRecord(tool.function) ? tool.function : undefined;
		const holder: Rec | undefined = fn ?? tool;
		const parameters = holder?.parameters;
		if (!isRecord(parameters)) return;
		const result = repairToolSchema(parameters);
		if (!result.repaired) return;

		repairedTools.push(String(fn?.name ?? tool.name ?? `tool[${index}]`));
		droppedRefs.push(...result.dropped);
		cyclicRefs.push(...result.cyclic);
		adjustedGrammarLimits += result.adjustedGrammarLimits;
		if (!nextTools) nextTools = [...tools];
		nextTools[index] = fn
			? { ...tool, function: { ...fn, parameters: result.schema } }
			: { ...tool, parameters: result.schema };
	});

	if (!nextTools) return { payload, report: EMPTY_REPORT };
	return {
		payload: { ...payload, tools: nextTools },
		report: {
			repairedTools,
			droppedRefs: [...new Set(droppedRefs)],
			cyclicRefs: [...new Set(cyclicRefs)],
			adjustedGrammarLimits,
			changed: true,
		},
	};
}

/** One-line human summary for a log/status notice. */
export function describeToolSchemaRepair(report: ToolSchemaRepairReport): string {
	if (!report.changed) return "";
	const shown = report.repairedTools.slice(0, NOTICE_LIMIT).join(", ");
	const more = report.repairedTools.length > NOTICE_LIMIT ? ` +${report.repairedTools.length - NOTICE_LIMIT} more` : "";
	const parts = [`repaired ${report.repairedTools.length} local tool schema(s): ${shown}${more}`];
	if (report.adjustedGrammarLimits > 0) {
		parts.push(`worked around nested maxLength=2000 grammar bug in ${report.adjustedGrammarLimits} location(s)`);
	}
	if (report.droppedRefs.length > 0) parts.push(`loosened unresolvable refs: ${report.droppedRefs.slice(0, NOTICE_LIMIT).join(", ")}`);
	if (report.cyclicRefs.length > 0) parts.push(`loosened recursive refs: ${report.cyclicRefs.slice(0, NOTICE_LIMIT).join(", ")}`);
	return parts.join("; ");
}

/** True for self-hosted endpoints on the local network (where grammar converters live). */
export function isLocalEndpointUrl(baseUrl: string): boolean {
	let host: string;
	try {
		host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
	} catch {
		return false;
	}
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host === "0.0.0.0") return true;
	const octets = host.split(".").map(Number);
	if (octets.length === 4 && octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255)) {
		const [a, b] = octets as [number, number];
		if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true;
	}
	return false;
}

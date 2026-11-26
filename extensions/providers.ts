/**
 * Provider detection and model config extraction.
 *
 * Pure module (no TUI, no storage): reads what the servers actually report — the
 * OpenAI-layer `/v1/models` catalogue plus per-type *native* enrichment endpoints
 * (llama.cpp `/props`, oMLX `/v1/models/status`, Ollama `/api/tags` + `/api/ps`) —
 * and turns it into the ModelConfig that registerProvider() registers with Pi.
 *
 * The per-server API research this encodes lives in docs/providers/.
 */

export interface ModelConfig {
	id: string;
	name: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean | null;
	input: string[] | null;
	source: string;
	loaded?: boolean;
}

/**
 * Plugin-internal enrichment merged into raw model objects by enrichModels().
 * Values come from the server's *native* (non-OpenAI) endpoints and are consulted
 * only when the /v1/models entry does not report the field itself.
 */
export interface ModelEnrichment {
	/** Effective runtime context (llama.cpp /props n_ctx, oMLX max_context_window, Ollama default num_ctx). */
	contextWindow?: number;
	/** Effective max output tokens (oMLX per-model setting). */
	maxTokens?: number;
	/** Model is currently loaded in memory (oMLX status `loaded`, Ollama /api/ps). */
	loaded?: boolean;
	/** Authoritative VLM flag (llama.cpp /props `modalities.vision`). */
	vision?: boolean;
	/** Server-reported thinking-capable default (oMLX status `thinking_default`). */
	thinkingDefault?: boolean;
}

/** Key under which enrichModels() stashes a ModelEnrichment on a raw model object. */
export const ENRICH_KEY = "__md";

export function redactSecret(value: string, secret?: string): string {
	return secret ? value.replaceAll(secret, "[redacted]") : value;
}

// ---------------------------------------------------------------------------
// Server detection (headers first, then model-object fingerprints)
// ---------------------------------------------------------------------------

export function detectServerType(headers: Headers, models: Record<string, unknown>[]): string {
	const server = (headers.get("server") ?? "").toLowerCase();
	const poweredBy = (headers.get("x-powered-by") ?? "").toLowerCase();

	if (server.includes("llama-cpp") || server.includes("llama.cpp")) return "llama.cpp";
	if (server.includes("ollama")) return "Ollama";
	if (server.includes("vllm")) return "vLLM";
	if (server.includes("sglang")) return "SGLang";
	if (server.includes("lm-studio") || server.includes("lm studio") || server.includes("lmstudio")) return "LM Studio";
	if (server.includes("omlx") || poweredBy.includes("omlx")) return "oMLX";

	for (const m of models) {
		const ownedBy = String(m.owned_by ?? "").toLowerCase();
		if (ownedBy === "omlx") return "oMLX";
		if (ownedBy === "vllm") return "vLLM";
		if (ownedBy === "llamacpp") return "llama.cpp";
	}
	for (const m of models) {
		// MTPLX /v1/models entries carry a `capability` field (chat/embedding/rerank)
		if (typeof m.capability === "string" && (m.capability as string).length > 0) return "MTPLX";
	}
	for (const m of models) {
		if (String(m.id ?? "").includes(":")) return "Ollama";
	}
	return "OpenAI-compatible";
}

// ---------------------------------------------------------------------------
// Raw field parsing helpers
// ---------------------------------------------------------------------------

function tryNum(v: unknown): number | null {
	if (typeof v === "number" && !isNaN(v)) return v;
	if (typeof v === "string") {
		const n = parseInt(v, 10);
		return isNaN(n) ? null : n;
	}
	return null;
}

function parseArgValue(args: string[] | undefined, flag: string): number | null {
	if (!args) return null;
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === flag) {
			const n = parseInt(args[i + 1], 10);
			return isNaN(n) ? null : n;
		}
	}
	return null;
}

function parsePresetValue(preset: string | undefined, key: string): number | null {
	if (!preset) return null;
	const m = preset.match(new RegExp(`${key}\\s*=\\s*(\\d+)`, "i"));
	if (m) {
		const n = parseInt(m[1], 10);
		return isNaN(n) ? null : n;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Model config extraction (reads real server data, null for anything missing)
// ---------------------------------------------------------------------------

export function extractModelConfig(raw: Record<string, unknown>): ModelConfig {
	const id = String(raw.id ?? "");
	const name = String(raw.name ?? id);
	const status = (raw.status && typeof raw.status === "object" ? raw.status : undefined) as
		| Record<string, unknown>
		| undefined;
	const args = status?.args as string[] | undefined;
	const preset = status?.preset as string | undefined;
	const enriched = (raw[ENRICH_KEY] ?? {}) as ModelEnrichment;

	// Context window: standard fields, then llama.cpp args/preset, then loaded meta,
	// then native-endpoint enrichment (llama.cpp /props, oMLX status, Ollama tags)
	let contextWindow =
		tryNum(raw.context_length) ??
		tryNum(raw.context_window) ??
		tryNum(raw.max_model_len) ??
		tryNum(raw.max_context_len) ??
		tryNum(raw.max_context_length) ??
		parseArgValue(args, "--ctx-size") ??
		parsePresetValue(preset, "ctx-size");
	if (contextWindow === null && raw.meta && typeof raw.meta === "object") {
		contextWindow = tryNum((raw.meta as Record<string, unknown>).n_ctx);
	}
	if (contextWindow === null) contextWindow = enriched.contextWindow ?? null;

	// Max output tokens
	let maxTokens =
		tryNum(raw.max_tokens) ??
		tryNum(raw.max_output_tokens) ??
		tryNum(raw.max_completion_tokens) ??
		parseArgValue(args, "--n-predict") ??
		parsePresetValue(preset, "n-predict");
	if (maxTokens === null) maxTokens = enriched.maxTokens ?? null;

	// Reasoning
	let reasoning: boolean | null = null;
	if (Array.isArray(raw.capabilities)) reasoning = (raw.capabilities as string[]).includes("reasoning");
	if (reasoning === null && raw.reasoning !== undefined) reasoning = !!raw.reasoning;
	if (reasoning === null) {
		const budget = parseArgValue(args, "--reasoning-budget") ?? parsePresetValue(preset, "reasoning-budget");
		if (budget !== null) reasoning = budget !== 0;
	}
	if (reasoning === null && enriched.thinkingDefault === true) reasoning = true;

	// Input modalities
	let input: string[] | null = null;
	let hasVision = false;

	// 1. Standard architecture.input_modalities (vLLM, SGLang, etc.)
	if (raw.architecture && typeof raw.architecture === "object") {
		const arch = raw.architecture as Record<string, unknown>;
		const modalities = arch.input_modalities as string[] | undefined;
		if (Array.isArray(modalities) && modalities.length > 0) {
			input = [];
			for (const m of modalities) {
				const l = m.toLowerCase();
				if (l.includes("text") && !input.includes("text")) input.push("text");
				if ((l.includes("image") || l.includes("vision")) && !input.includes("image")) {
					input.push("image");
					hasVision = true;
				}
			}
		}
		// Also check for vision-specific architecture keys
		if (!hasVision && (arch.vision_config || arch.vision_model || arch.mm_proj || arch.multi_modal_projector)) {
			hasVision = true;
		}
	}

	// 2. Direct input array on the model object
	if (!input && Array.isArray(raw.input)) {
		input = raw.input as string[];
		if (input.includes("image")) hasVision = true;
	}

	// 3. llama.cpp: --mmproj flag in args or preset (multimodal projector file)
	if (!hasVision && args) {
		for (const a of args) {
			if (a.startsWith("--mmproj") || a.startsWith("--vision")) {
				hasVision = true;
				break;
			}
		}
	}
	if (!hasVision && preset) {
		if (/mmproj|vision/i.test(preset)) {
			hasVision = true;
		}
	}

	// 4. oMLX: check for vision-specific capabilities or model tags
	if (!hasVision && Array.isArray(raw.capabilities)) {
		const caps = (raw.capabilities as string[]).map((c: string) => c.toLowerCase());
		if (caps.some((c: string) => c.includes("vision") || c.includes("image") || c.includes("multimodal"))) {
			hasVision = true;
		}
	}

	// 5. Enrichment: native endpoint reports an authoritative VLM flag (llama.cpp /props)
	if (!hasVision && enriched.vision === true) hasVision = true;

	// 6. Build final input array — always include "text", add "image" if vision detected
	if (hasVision) {
		input = input && input.includes("image") ? input : ["text", "image"];
	} else if (!input) {
		input = ["text"];
	} else if (!input.includes("text")) {
		input.unshift("text");
	}

	let loaded = status?.value === "loaded" ? true : status?.value === "unloaded" ? false : undefined;
	if (loaded === undefined && enriched.loaded === true) loaded = true;
	const source = String(raw.source ?? (status ? "server args" : "api"));

	return { id, name, contextWindow, maxTokens, reasoning, input, source, loaded };
}

// ---------------------------------------------------------------------------
// Live probe: OpenAI catalogue + native enrichment
// ---------------------------------------------------------------------------

export async function fetchModels(
	baseUrl: string,
	apiKey?: string,
	signal?: AbortSignal,
): Promise<{ models: Record<string, unknown>[]; serverType: string }> {
	const url = baseUrl.replace(/\/+$/, "") + "/v1/models";
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`HTTP ${response.status}: ${redactSecret(body.slice(0, 200), apiKey)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	if (!data || typeof data !== "object" || !Array.isArray(data.data)) {
		throw new Error("Invalid /v1/models response: expected a data array.");
	}
	const models = data.data.filter(
		(model): model is Record<string, unknown> =>
			!!model && typeof model === "object" && typeof (model as Record<string, unknown>).id === "string" &&
			(model as Record<string, unknown>).id !== "",
	);
	if (models.length !== data.data.length) {
		throw new Error("Invalid /v1/models response: every model must have a non-empty string id.");
	}
	const serverType = detectServerType(response.headers, models);
	await enrichModels(baseUrl, apiKey, serverType, models);
	return { models, serverType };
}

/**
 * Best-effort enrichment from each server type's *native* (non-OpenAI) endpoints.
 * Merges server-reported context windows, max tokens, load state, and VLM flags
 * into the raw model objects (under ENRICH_KEY) for whatever /v1/models omitted.
 * Never throws: a missing or failing native endpoint leaves the catalogue unchanged.
 */
export async function enrichModels(
	baseUrl: string,
	apiKey: string | undefined,
	serverType: string,
	models: Record<string, unknown>[],
): Promise<void> {
	const base = baseUrl.replace(/\/+$/, "");
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const getJson = async (path: string): Promise<Record<string, unknown> | null> => {
		try {
			const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(1_000) });
			if (!res.ok) return null;
			const data = (await res.json()) as unknown;
			return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	};
	const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
	const merge = (m: Record<string, unknown>, e: ModelEnrichment): void => {
		const existing = (m[ENRICH_KEY] ?? {}) as ModelEnrichment;
		m[ENRICH_KEY] = { ...existing, ...e };
	};
	try {
		if (serverType === "llama.cpp") {
			// Native /props: the real runtime context + the authoritative VLM flag
			const props = await getJson("/props");
			if (!props) return;
			const gen = props.default_generation_settings as Record<string, unknown> | undefined;
			const nCtx = gen ? tryNum(gen.n_ctx) : null;
			const vision = Boolean((props.modalities as Record<string, unknown> | undefined)?.vision);
			if ((nCtx !== null && nCtx > 0) || vision) {
				for (const m of models) merge(m, { contextWindow: nCtx ?? undefined, vision });
			}
			return;
		}
		if (serverType === "oMLX") {
			// Extended /v1/models/status: effective context, per-model max tokens,
			// load state, and the thinking-capable default
			const status = await getJson("/v1/models/status");
			if (!status) return;
			const byId = new Map<string, ModelEnrichment>();
			for (const entry of list(status.models)) {
				const id = String(entry.id ?? "");
				if (!id) continue;
				const e: ModelEnrichment = {
					contextWindow:
						tryNum(entry.max_context_window) ?? tryNum(entry.model_context_length) ?? undefined,
					maxTokens: tryNum(entry.max_tokens) ?? undefined,
					loaded: entry.loaded === true ? true : undefined,
					thinkingDefault: entry.thinking_default === true ? true : undefined,
				};
				byId.set(id, e);
				// /v1/models may surface the user alias as the id — match both
				const alias = String(entry.model_alias ?? "");
				if (alias && alias !== id) byId.set(alias, e);
			}
			for (const m of models) {
				const e = byId.get(String(m.id ?? ""));
				if (e) merge(m, e);
			}
			return;
		}
		if (serverType === "Ollama") {
			// Native /api/tags: model cards incl. the default context; /api/ps: loaded models
			const tags = await getJson("/api/tags");
			const tagByName = new Map<string, Record<string, unknown>>();
			for (const t of list(tags?.models)) {
				const name = String(t.name ?? "");
				if (name) tagByName.set(name, t);
			}
			const loadedNames = new Set<string>();
			for (const p of list((await getJson("/api/ps"))?.models)) {
				const name = String(p.name ?? "");
				if (name) loadedNames.add(name);
			}
			for (const m of models) {
				const name = String(m.id ?? "");
				const details = (tagByName.get(name)?.details ?? {}) as Record<string, unknown>;
				const e: ModelEnrichment = {
					contextWindow: tryNum(details.context_length) ?? undefined,
					loaded: loadedNames.has(name) ? true : undefined,
				};
				if (e.contextWindow !== undefined || e.loaded !== undefined) merge(m, e);
			}
			return;
		}
		// vLLM / SGLang / LM Studio / MTPLX / generic: no reliable native metadata
		// endpoint today (see docs/providers/ — context stays override-driven)
	} catch {
		/* enrichment is best-effort — never fail the scan */
	}
}

/**
 * Identify individual MCP tool schemas a llama.cpp endpoint cannot compile.
 *   node --experimental-strip-types scripts/bisect-grammar.ts BASE_URL [MODEL] [TOOL_FILTER]
 *
 * The repair is applied first; a failure here therefore isolates an additional
 * converter limitation rather than the known $defs/$ref issue.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repairRequestToolSchemas } from "../schema-repair.ts";

const BASE = process.argv[2];
const MODEL = process.argv[3] ?? "qwen3.8-27b";
const FILTER = process.argv[4];
const CACHE = process.env.PI_MCP_CACHE ?? join(homedir(), ".pi", "agent", "mcp-cache.json");

if (!BASE) {
	console.error("usage: node --experimental-strip-types scripts/bisect-grammar.ts BASE_URL [MODEL] [TOOL_FILTER]");
	process.exit(2);
}

const cache = JSON.parse(readFileSync(CACHE, "utf8")) as {
	servers: Record<string, { tools?: Record<string, unknown>[] }>;
};

const tools: Record<string, unknown>[] = [];
for (const [server, spec] of Object.entries(cache.servers)) {
	for (const tool of spec.tools ?? []) {
		const fn = (tool.function ?? tool) as Record<string, unknown>;
		const parameters = fn.parameters ?? fn.inputSchema;
		if (!fn.name || !parameters) continue;
		tools.push({ type: "function", function: { name: `${server}__${String(fn.name).replace(/[^A-Za-z0-9_-]/g, "_")}`, description: String(fn.description ?? ""), parameters } });
	}
}

const repaired = repairRequestToolSchemas({ model: MODEL, messages: [{ role: "user", content: "x" }], max_tokens: 8, tools }).payload as { tools: Record<string, unknown>[] };
let candidates = repaired.tools;
if (FILTER) candidates = candidates.filter((t) => String((t.function as Record<string, unknown>).name).includes(FILTER));

async function post(subset: Record<string, unknown>[]): Promise<{ status: number; msg: string }> {
	const res = await fetch(`${BASE}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "reply OK" }], max_tokens: 8, tools: subset }),
	});
	const body = await res.text();
	await new Promise((resolve) => setTimeout(resolve, 100));
	return { status: res.status, msg: body.slice(0, 160) };
}

console.log(`probing ${candidates.length} tool(s) against ${BASE} (${MODEL})`);

// 1. individual probe
const failing: string[] = [];
for (const tool of candidates) {
	const name = String((tool.function as Record<string, unknown>).name);
	const { status, msg } = await post([tool]);
	if (status !== 200) {
		failing.push(name);
		console.log(`FAIL ${status} ${name}\n     ${msg}`);
	}
}
console.log(`\nindividually failing: ${failing.length === 0 ? "none" : failing.join(", ")}`);
process.exit(0);

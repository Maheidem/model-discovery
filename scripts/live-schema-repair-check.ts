/**
 * LIVE verification: push the local Pi MCP catalogue through the repair and against
 * a llama.cpp-compatible endpoint. Not part of `npm test` (needs the network).
 *
 *   node --experimental-strip-types scripts/live-schema-repair-check.ts BASE_URL [MODEL]
 *
 * This sends tool definitions but never executes a tool call.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repairRequestToolSchemas, describeToolSchemaRepair } from "../schema-repair.ts";

const BASE = process.argv[2];
const MODEL = process.argv[3] ?? "qwen3.8-27b";
const CACHE = process.env.PI_MCP_CACHE ?? join(homedir(), ".pi", "agent", "mcp-cache.json");

if (!BASE) {
	console.error("usage: node --experimental-strip-types scripts/live-schema-repair-check.ts BASE_URL [MODEL]");
	process.exit(2);
}

function collectRefs(node: unknown, out: string[] = []): string[] {
	if (Array.isArray(node)) for (const item of node) collectRefs(item, out);
	else if (node && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			if (key === "$ref" && typeof value === "string") out.push(value);
			else if (key === "$defs" || key === "definitions") out.push(`<${key}:${Object.keys(value as object).length} entries>`);
			else collectRefs(value, out);
		}
	}
	return out;
}

async function post(tools: unknown[], model = MODEL): Promise<{ status: number; body: string }> {
	const res = await fetch(`${BASE}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content: "reply with OK" }], max_tokens: 16, tools }),
	});
	return { status: res.status, body: await res.text() };
}

if (!existsSync(CACHE)) {
	console.error(`no mcp cache at ${CACHE}`);
	process.exit(2);
}

const cache = JSON.parse(readFileSync(CACHE, "utf8")) as { servers: Record<string, { tools?: Record<string, unknown>[] }> };
const servers = Object.entries(cache.servers);
const tools: Record<string, unknown>[] = [];
for (const [name, server] of servers) {
	for (const tool of (server.tools ?? []) as Record<string, unknown>[]) {
		// MCP catalogue entries carry `inputSchema`; OpenAI-shaped ones carry `function.parameters`.
		const fn = (tool.function ?? tool) as Record<string, unknown>;
		const parameters = fn.parameters ?? fn.inputSchema;
		if (!fn.name || !parameters) continue;
		tools.push({
			type: "function",
			function: { name: `${name}__${String(fn.name).replace(/[^A-Za-z0-9_-]/g, "_")}`, description: String(fn.description ?? ""), parameters },
		});
	}
}

const broken = tools.filter((t) => collectRefs((t as { function: { parameters: unknown } }).function.parameters).length > 0);
console.log(`endpoint        : ${BASE}`);
console.log(`tools collected : ${tools.length} from ${servers.length} MCP servers`);
console.log(`tools w/ refs  : ${broken.length}`);
for (const t of broken) console.log(`  - ${String((t as { function: { name: string } }).function.name)}`);

const before = await post(tools);
console.log(`\nBEFORE repair -> HTTP ${before.status}`);
if (before.status !== 200) console.log(`  ${before.body.slice(0, 260)}`);

const { payload, report } = repairRequestToolSchemas({ model: MODEL, messages: [{ role: "user", content: "reply with OK" }], max_tokens: 16, tools });
console.log(`\nrepair summary  : ${describeToolSchemaRepair(report) || "(nothing to repair)"}`);
if (report.droppedRefs.length) console.log(`  loosened refs : ${report.droppedRefs.join(", ")}`);

const after = await post((payload as { tools: unknown[] }).tools);
console.log(`\nAFTER repair  -> HTTP ${after.status}`);
if (after.status === 200) console.log("  ✅ llama-swap/llama.cpp accepted the repaired tool set");
else console.log(`  ❌ ${after.body.slice(0, 260)}`);

const leftovers = collectRefs((payload as { tools: unknown[] }).tools).filter((r) => r.startsWith("#") || r.includes("entries"));
console.log(`\nresidual refs/defs on the wire: ${leftovers.length === 0 ? "none ✅" : leftovers.join(", ")}`);
process.exit(after.status === 200 && leftovers.length === 0 ? 0 : 1);

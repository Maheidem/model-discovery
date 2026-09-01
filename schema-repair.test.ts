/**
 * Tests for tool-schema repair (schema-repair.ts).
 *
 * The reference bug is real: the okto-pulse MCP server ships
 * `okto_pulse_create_guideline_revision` with `$defs` nested under `patch` while the
 * `$ref`s inside stay root-relative, and llama.cpp (via llama-swap) answers every
 * request with HTTP 400 "JSON schema conversion failed: Error resolving ref
 * #/$defs/GuidelineMetricInput: $defs not in {...}".
 *
 * `llamaCppGrammarServer()` below re-implements that resolver rule plus the exact
 * nested-array maxLength=2000 parser failure, so the wire payload is checked against
 * both live llama.cpp behaviours rather than only by inspection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:http";
import { request as httpRequest } from "node:http";
import {
	describeToolSchemaRepair,
	isLocalEndpointUrl,
	LLAMA_CPP_BROKEN_NESTED_MAX_LENGTH,
	LLAMA_CPP_SAFE_NESTED_MAX_LENGTH,
	parseRef,
	repairRequestToolSchemas,
	repairToolSchema,
	schemaNeedsRepair,
} from "./schema-repair.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The real shape reported by llama-swap v251 / llama.cpp b10612. */
const GUIDELINE_METRIC_INPUT = {
	type: "object",
	properties: {
		metric_id: { type: "string", minLength: 1, maxLength: 64 },
		code: { type: "string", minLength: 1, maxLength: 128 },
		title: { type: "string", minLength: 1 },
		direction: { enum: ["minimum", "maximum"], type: "string" },
		default_threshold: { type: "integer", minimum: 0, maximum: 100 },
	},
	required: ["metric_id", "code", "title", "direction", "default_threshold"],
	additionalProperties: false,
};

const BROKEN_PARAMETERS = {
	type: "object",
	properties: {
		board_id: { type: "string", minLength: 1, maxLength: 36 },
		patch: {
			$defs: { GuidelineMetricInput: GUIDELINE_METRIC_INPUT },
			type: "object",
			properties: {
				content: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }], default: null },
				metrics: { type: "array", items: { $ref: "#/$defs/GuidelineMetricInput" } },
			},
			additionalProperties: false,
		},
	},
	required: ["board_id", "patch"],
	additionalProperties: false,
};

/** Minimal form of okto_pulse_move_card's independent llama.cpp grammar bug. */
const BROKEN_GRAMMAR_PARAMETERS = {
	type: "object",
	properties: {
		files: {
			type: "array",
			items: {
				type: "object",
				properties: {
					note: {
						anyOf: [
							{ type: "string", minLength: 1, maxLength: LLAMA_CPP_BROKEN_NESTED_MAX_LENGTH },
							{ type: "null" },
						],
						default: null,
					},
				},
			},
		},
	},
};

function chatPayload(tools: unknown[]): Record<string, unknown> {
	return { model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }], stream: true, tools };
}

function functionTool(name: string, parameters: unknown): Record<string, unknown> {
	return { type: "function", function: { name, description: `${name} desc`, parameters } };
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

function assertRefFree(node: unknown, depth = 0): void {
	assert.ok(depth < 512, "structure too deep — likely a cloning cycle");
	if (Array.isArray(node)) {
		for (const item of node) assertRefFree(item, depth + 1);
		return;
	}
	if (typeof node !== "object" || node === null) return;
	for (const [key, value] of Object.entries(node)) {
		assert.ok(key !== "$ref" && key !== "$defs" && key !== "definitions", `residual ${key} reached the wire`);
		assertRefFree(value, depth + 1);
	}
}

// ---------------------------------------------------------------------------
// llama.cpp converter rule (fixture)
// ---------------------------------------------------------------------------

/**
 * Mirror of the two verified llama.cpp b10612 rules:
 * - `$ref` resolves only against the document root's `$defs`/`definitions`;
 * - nested-array `maxLength: 2000` fails grammar parsing (1999/2001 both work).
 */
function llamaCppGrammarServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			const body = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string; parameters?: unknown } }> };
			for (const tool of body.tools ?? []) {
				const params = (tool.function ?? (tool as Record<string, unknown>))?.parameters as Record<string, unknown> | undefined;
				const refs: string[] = [];
				let hasBrokenGrammarLimit = false;
				const collect = (node: unknown, insideArrayItem = false): void => {
					if (Array.isArray(node)) return node.forEach((item) => collect(item, insideArrayItem));
					if (typeof node !== "object" || node === null) return;
					const record = node as Record<string, unknown>;
					if (insideArrayItem && record.maxLength === LLAMA_CPP_BROKEN_NESTED_MAX_LENGTH) {
						hasBrokenGrammarLimit = true;
					}
					for (const [key, value] of Object.entries(record)) {
						if (key === "$ref" && typeof value === "string") refs.push(value);
						else collect(value, insideArrayItem || (key === "items" && record.type === "array"));
					}
				};
				collect(params);
				const defs = (params?.["\$defs"] ?? params?.definitions) as Record<string, unknown> | undefined;
				for (const ref of refs) {
					const tail = ref.replace(/^#\/(\$defs|definitions)\//, "");
					const resolvable = tail !== ref && defs && Object.keys(defs).includes(tail);
					if (!resolvable) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ code: 400, message: `JSON schema conversion failed:\nError resolving ref ${ref}` }));
						return;
					}
				}
				if (hasBrokenGrammarLimit) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ code: 400, message: "Failed to initialize samplers: failed to parse grammar" }));
					return;
				}
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				baseUrl: `http://127.0.0.1:${port}`,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

function postChat(baseUrl: string, payload: unknown): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const url = new URL(`${baseUrl}/v1/chat/completions`);
		const req = httpRequest(
			{ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "Content-Type": "application/json" } },
			(res) => {
				let body = "";
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end(JSON.stringify(payload));
	});
}

// ---------------------------------------------------------------------------
// Tests — detection
// ---------------------------------------------------------------------------

test("clean schemas are left untouched (identity, no clone)", () => {
	const clean = { type: "object", properties: { a: { type: "string" }, b: { items: { type: "integer" } } }, required: ["a"] };
	const payload = chatPayload([functionTool("ok_tool", clean)]);
	const { payload: out, report } = repairRequestToolSchemas(payload);
	assert.equal(out, payload, "payload must keep object identity when nothing needs repair");
	assert.equal(report.changed, false);
	assert.deepEqual(report.repairedTools, []);
	assert.equal(schemaNeedsRepair(clean), false);
});

test("payload without tools is untouched", () => {
	const payload = { model: "m", messages: [] };
	assert.equal(repairRequestToolSchemas(payload).payload, payload);
});

// ---------------------------------------------------------------------------
// Tests — the reference bug
// ---------------------------------------------------------------------------

test("nested $defs with root-relative $ref is inlined (reference bug)", () => {
	const { schema, repaired, dropped, cyclic } = repairToolSchema(BROKEN_PARAMETERS);
	assert.equal(repaired, true);
	assert.deepEqual(dropped, [], "the def exists — it was just scoped wrong, so nothing should be dropped");
	assert.deepEqual(cyclic, []);
	assertRefFree(schema);

	const patch = (schema as Record<string, Record<string, Record<string, unknown>>>).properties.patch.properties;
	assert.deepEqual(patch.metrics, { type: "array", items: GUIDELINE_METRIC_INPUT }, "metrics.items must be the inlined def");
	assert.equal((schema as { $defs?: unknown }).$defs, undefined, "$defs must not reach the wire");
});

test("repaired payload satisfies the llama.cpp resolver rule", async () => {
	const { baseUrl, close } = await llamaCppGrammarServer();
	try {
		const broken = chatPayload([functionTool("guideline_tool", BROKEN_PARAMETERS)]);
		const before = await postChat(baseUrl, broken);
		assert.equal(before.status, 400, "fixture must reproduce the production failure");
		assert.match(before.body, /Error resolving ref #\/\$defs\/GuidelineMetricInput/);

		const repaired = repairRequestToolSchemas(broken);
		assert.equal(repaired.report.changed, true);
		assert.deepEqual(repaired.report.repairedTools, ["guideline_tool"]);
		assert.equal(repaired.report.adjustedGrammarLimits, 0);

		const after = await postChat(baseUrl, repaired.payload);
		assert.equal(after.status, 200, `expected 200, got ${after.status}: ${after.body}`);
	} finally {
		await close();
	}
});

test("nested-array maxLength=2000 is changed to the proven-safe neighbour", () => {
	const result = repairToolSchema(BROKEN_GRAMMAR_PARAMETERS);
	assert.equal(result.repaired, true);
	assert.equal(result.adjustedGrammarLimits, 1);
	const files = (result.schema as {
		properties: { files: { items: { properties: { note: { anyOf: Array<{ maxLength?: number }> } } } } };
	}).properties.files;
	assert.equal(files.items.properties.note.anyOf[0].maxLength, LLAMA_CPP_SAFE_NESTED_MAX_LENGTH);

	// The failure is contextual and exact: top-level 2000 plus neighbouring nested
	// values are accepted by the live converter and must remain byte-identical.
	const topLevel = { type: "object", properties: { text: { type: "string", maxLength: 2000 } } };
	const nested1999 = { type: "array", items: { type: "string", maxLength: 1999 } };
	const nested2001 = { type: "array", items: { type: "string", maxLength: 2001 } };
	const propertyNamedItems = { type: "object", properties: { items: { type: "string", maxLength: 2000 } } };
	for (const clean of [topLevel, nested1999, nested2001, propertyNamedItems]) {
		assert.equal(repairToolSchema(clean).schema, clean, "non-broken shapes must retain identity");
	}
});

test("grammar-limit workaround turns the live failure contract from 400 to 200", async () => {
	const { baseUrl, close } = await llamaCppGrammarServer();
	try {
		const broken = chatPayload([functionTool("move_card", BROKEN_GRAMMAR_PARAMETERS)]);
		const before = await postChat(baseUrl, broken);
		assert.equal(before.status, 400);
		assert.match(before.body, /failed to parse grammar/);

		const repaired = repairRequestToolSchemas(broken);
		assert.equal(repaired.report.adjustedGrammarLimits, 1);
		assert.deepEqual(repaired.report.repairedTools, ["move_card"]);
		const after = await postChat(baseUrl, repaired.payload);
		assert.equal(after.status, 200, `expected 200, got ${after.status}: ${after.body}`);
	} finally {
		await close();
	}
});

// ---------------------------------------------------------------------------
// Tests — hardening
// ---------------------------------------------------------------------------

test("dangling $ref is loosened instead of failing the request", () => {
	const params = {
		type: "object",
		properties: { ghost: { $ref: "#/$defs/NotAnywhere", description: "kept" } },
	};
	const { schema, repaired, dropped } = repairToolSchema(params);
	assert.equal(repaired, true);
	assert.deepEqual(dropped, ["#/$defs/NotAnywhere"]);
	const ghost = (schema as Record<string, Record<string, Record<string, unknown>>>).properties.ghost;
	assert.equal(ghost.description, "kept", "annotation siblings survive loosening");
	assert.ok(!("$ref" in ghost));
});

test("recursive $ref terminates and loosens the cycle", () => {
	const params: Record<string, unknown> = {
		type: "object",
		properties: { node: { $ref: "#/$defs/Tree" } },
	};
	(params["$defs"] as Record<string, unknown> | undefined) ??= {};
	(params as { $defs: Record<string, unknown> }).$defs.Tree = {
		type: "object",
		properties: { children: { type: "array", items: { $ref: "#/$defs/Tree" } } },
	};
	const { schema, repaired, cyclic } = repairToolSchema(params);
	assert.equal(repaired, true);
	assert.ok(cyclic.includes("#/$defs/Tree"));
	assertRefFree(schema);
});

test("transitive refs collapse fully", () => {
	const params = {
		type: "object",
		properties: { a: { $ref: "#/$defs/A" } },
		$defs: {
			A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
			B: { type: "string", minLength: 2 },
		},
	};
	const { schema, dropped, cyclic } = repairToolSchema(params);
	assert.deepEqual(dropped, []);
	assert.deepEqual(cyclic, []);
	const b = (schema as Record<string, Record<string, Record<string, Record<string, unknown>>>>).properties.a.properties.b;
	assert.deepEqual(b, { type: "string", minLength: 2 });
	assertRefFree(schema);
});

test("same-named nested defs with different content are both preserved", () => {
	const left = { type: "object", properties: { onlyLeft: { type: "string" } }, required: ["onlyLeft"] };
	const right = { type: "object", properties: { onlyRight: { type: "integer" } }, required: ["onlyRight"] };
	const params = {
		type: "object",
		properties: {
			l: { $defs: { Thing: left }, type: "object", properties: { v: { $ref: "#/$defs/Thing" } } },
			r: { $defs: { Thing: right }, type: "object", properties: { v: { $ref: "#/$defs/Thing" } } },
		},
	};
	const { schema, repaired, dropped } = repairToolSchema(params);
	assert.equal(repaired, true);
	assert.deepEqual(dropped, []);
	const props = (schema as Record<string, Record<string, Record<string, Record<string, unknown>>>>).properties;
	assert.deepEqual(Object.keys(props.l.properties.v.properties ?? {}), ["onlyLeft"]);
	assert.deepEqual(Object.keys(props.r.properties.v.properties ?? {}), ["onlyRight"]);
	assertRefFree(schema);
});

test("refs inside anyOf / oneOf / map keywords are repaired", () => {
	const params = {
		type: "object",
		properties: {
			choice: { oneOf: [{ $ref: "#/$defs/X" }, { type: "null" }] },
			nested: { if: { $ref: "#/$defs/X" }, then: { not: { $ref: "#/$defs/X" } } },
			map: { type: "object", additionalProperties: { $ref: "#/$defs/X" } },
			tuple: { type: "array", prefixItems: [{ $ref: "#/$defs/X" }] },
		},
		$defs: { X: { type: "boolean" } },
	};
	const { schema, repaired } = repairToolSchema(params);
	assert.equal(repaired, true);
	assertRefFree(schema);
	const props = (schema as Record<string, Record<string, Record<string, unknown>>>).properties;
	assert.deepEqual((props.choice as { oneOf: unknown[] }).oneOf, [{ type: "boolean" }, { type: "null" }]);
	assert.deepEqual((props.map as { additionalProperties: unknown }).additionalProperties, { type: "boolean" });
	assert.deepEqual((props.tuple as { prefixItems: unknown[] }).prefixItems, [{ type: "boolean" }]);
});

test("$ref siblings are preserved", () => {
	const params = {
		type: "object",
		properties: { thing: { $ref: "#/$defs/X", description: "local note", title: "Thing" } },
		$defs: { X: { type: "string", description: "def note" } },
	};
	const { schema } = repairToolSchema(params);
	const thing = (schema as Record<string, Record<string, Record<string, unknown>>>).properties.thing;
	assert.equal(thing.type, "string", "structure comes from the def");
	assert.equal(thing.description, "local note", "local annotation wins over the def's");
	assert.equal(thing.title, "Thing");
});

test("root-level $defs written by a correct author also resolve", () => {
	const params = {
		$defs: { Item: { type: "integer" } },
		type: "object",
		properties: { n: { $ref: "#/$defs/Item" } },
	};
	const { schema, repaired, dropped } = repairToolSchema(params);
	assert.equal(repaired, true);
	assert.deepEqual(dropped, []);
	assert.deepEqual((schema as Record<string, Record<string, unknown>>).properties.n, { type: "integer" });
});

test("defs referenced through a nested path resolve", () => {
	const params = {
		type: "object",
		properties: {
			outer: {
				$defs: { Deep: { type: "object", properties: { flag: { $ref: "#/$defs/Inner" } } }, Inner: { type: "boolean" } },
				type: "object",
				properties: { list: { type: "array", items: { $ref: "#/$defs/Deep" } } },
			},
		},
	};
	const { schema, dropped } = repairToolSchema(params);
	assert.deepEqual(dropped, [], "both defs live on the same nested node and must both hoist");
	const flag = (schema as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>).properties.outer.properties.list.items.properties.flag;
	assert.deepEqual(flag, { type: "boolean" });
});

test("external refs cannot be inlined and are loosened", () => {
	const params = { type: "object", properties: { far: { $ref: "https://example.com/schema.json#/definitions/X" } } };
	const { repaired, dropped } = repairToolSchema(params);
	assert.equal(repaired, true);
	assert.deepEqual(dropped, ["https://example.com/schema.json#/definitions/X"]);
});

test("many-tool payloads are repaired selectively and quickly", () => {
	const tools = Array.from({ length: 256 }, (_, i) =>
		i % 8 === 0 ? functionTool(`slow_tool_${i}`, BROKEN_PARAMETERS) : functionTool(`fast_tool_${i}`, { type: "object", properties: { x: { type: "string" } } }),
	);
	const payload = chatPayload(tools);
	const started = performance.now();
	const { payload: out, report } = repairRequestToolSchemas(payload);
	const elapsed = performance.now() - started;
	assert.equal(report.repairedTools.length, 32);
	assert.equal(report.repairedTools[0], "slow_tool_0");
	const toolsOut = (out as { tools: Array<{ function: { parameters: Record<string, unknown> } }> }).tools;
	assert.equal(toolsOut[1], tools[1], "clean tools keep object identity");
	assert.ok(elapsed < 250, `repairing 256 tools took ${elapsed.toFixed(1)}ms — too slow for a per-request hook`);
});

test("malformed payloads do not throw", () => {
	for (const payload of [null, undefined, 42, "str", [], { tools: null }, { tools: [] }, { tools: [null, 7] }, { tools: [{ function: {} }] }]) {
		const { payload: out, report } = repairRequestToolSchemas(payload);
		assert.equal(report.changed, false);
		assert.equal(out, payload);
	}
});

test("idempotent: repairing twice changes nothing", () => {
	const once = repairToolSchema(BROKEN_PARAMETERS).schema;
	const twice = repairToolSchema(once);
	assert.equal(twice.repaired, false);
	assert.deepEqual(twice.schema, once);
});

// ---------------------------------------------------------------------------
// Tests — helpers
// ---------------------------------------------------------------------------

test("parseRef classifies pointer kinds", () => {
	assert.deepEqual(parseRef("#/$defs/X"), { kind: "defs", tokens: ["X"] });
	assert.deepEqual(parseRef("#/definitions/X"), { kind: "defs", tokens: ["X"] });
	assert.deepEqual(parseRef("#/$defs/A/properties/b"), { kind: "defs", tokens: ["A", "properties", "b"] });
	assert.deepEqual(parseRef("#/properties/a"), { kind: "pointer", tokens: ["properties", "a"] });
	assert.deepEqual(parseRef("other.json#/X"), { kind: "external", tokens: [] });
});

test("isLocalEndpointUrl covers self-hosted hosts only", () => {
	assert.equal(isLocalEndpointUrl("http://192.168.1.50"), true);
	assert.equal(isLocalEndpointUrl("http://192.168.1.50:8081"), true);
	assert.equal(isLocalEndpointUrl("http://localhost:8123"), true);
	assert.equal(isLocalEndpointUrl("http://127.0.0.1:8080/v1"), true);
	assert.equal(isLocalEndpointUrl("http://desktop.local:11434"), true);
	assert.equal(isLocalEndpointUrl("http://10.0.0.5:8000"), true);
	assert.equal(isLocalEndpointUrl("http://172.16.0.9:8080"), true);
	assert.equal(isLocalEndpointUrl("https://api.openai.com/v1"), false);
	assert.equal(isLocalEndpointUrl("https://api.anthropic.com"), false);
	assert.equal(isLocalEndpointUrl("http://8.8.8.8:8080"), false);
	assert.equal(isLocalEndpointUrl("not a url"), false);
});

test("describeToolSchemaRepair summarises and stays quiet when clean", () => {
	assert.equal(describeToolSchemaRepair(repairRequestToolSchemas(chatPayload([])).report), "");
	const { report } = repairRequestToolSchemas(
		chatPayload([
			functionTool("a", BROKEN_PARAMETERS),
			functionTool("b", { properties: { z: { $ref: "#/nope" } } }),
			functionTool("c", BROKEN_GRAMMAR_PARAMETERS),
		]),
	);
	const text = describeToolSchemaRepair(report);
	assert.match(text, /repaired 3 local tool schema\(s\): a, b, c/);
	assert.match(text, /worked around nested maxLength=2000 grammar bug in 1 location\(s\)/);
	assert.match(text, /loosened unresolvable refs: #\/nope/);
});

/**
 * Slice 3 grammar tests (D3 all-mutations parity).
 *
 * Pure parser tests — no UI, no storage, no network. The parity inventory
 * (tests/fixtures/discover-actions.ts) proves every declared verb parses;
 * these tests pin the grammar edges: secrets never inline, destructive
 * non-interactive removal needs --yes, numbers must be positive integers,
 * and completions teach the nested shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { completeDiscoverArgs, parseDiscoverArgs } from "./commands.ts";

// Compare via JSON roundtrip: the parser emits explicit `source: undefined`
// keys on some intents, and deepStrictEqual distinguishes those from absence.
const ck = (actual: unknown, expected: unknown) =>
	assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));

test("nested mutation verbs parse (slice 3)", () => {
	ck(parseDiscoverArgs("source open local"), { kind: "source-open", name: "local" });
	ck(parseDiscoverArgs("source rename local lan-server"), { kind: "source-rename", oldName: "local", newName: "lan-server" });
	ck(parseDiscoverArgs("source auth local --key-from-env LOCAL_KEY"), { kind: "source-auth", name: "local", keyFromEnv: "LOCAL_KEY" });
	ck(parseDiscoverArgs("source auth local"), { kind: "source-auth", name: "local" });
	ck(parseDiscoverArgs("source rescan local"), { kind: "source-rescan", name: "local" });
	ck(parseDiscoverArgs("source defaults local ctx 131072"), { kind: "source-defaults", name: "local", contextWindow: 131072, maxTokens: undefined });
	ck(parseDiscoverArgs("source defaults local max 16384"), { kind: "source-defaults", name: "local", contextWindow: undefined, maxTokens: 16384 });
	ck(parseDiscoverArgs("model qwen3-32b vision on"), { kind: "model-set", modelId: "qwen3-32b", field: "vision", value: "on", source: undefined });
	ck(parseDiscoverArgs("model qwen3-32b ctx 4096 --source local"), { kind: "model-set", modelId: "qwen3-32b", field: "contextWindow", value: "4096", source: "local" });
	ck(parseDiscoverArgs("model qwen3-32b reasoning off"), { kind: "model-set", modelId: "qwen3-32b", field: "reasoning", value: "off", source: undefined });
	ck(parseDiscoverArgs("preset set local qwen3-32b thinking temperature 0.7"), {
		kind: "preset-set",
		source: "local",
		modelId: "qwen3-32b",
		slug: "thinking",
		field: "temperature",
		value: "0.7",
	});
	ck(parseDiscoverArgs("preset remove local qwen3-32b thinking --yes"), {
		kind: "preset-remove",
		source: "local",
		modelId: "qwen3-32b",
		slug: "thinking",
		confirmed: true,
	});
	ck(parseDiscoverArgs("routing set local qwen3-32b medium fast"), {
		kind: "routing-set",
		source: "local",
		modelId: "qwen3-32b",
		level: "medium",
		slug: "fast",
	});
	ck(parseDiscoverArgs("routing conventional local qwen3-32b"), { kind: "routing-conventional", source: "local", modelId: "qwen3-32b" });
	ck(parseDiscoverArgs("routing remove local qwen3-32b"), { kind: "routing-remove", source: "local", modelId: "qwen3-32b", confirmed: false });
});

test("secrets are never accepted inline", () => {
	const bad = parseDiscoverArgs("source auth local sk-abcdef123456");
	assert.equal(bad.kind, "invalid");
	assert.match((bad as { message: string }).message, /--key-from-env/);
});

test("numeric grammar rejects junk", () => {
	for (const args of ["model x ctx 0", "model x ctx -4", "model x max abc", "source defaults local ctx nope", "source defaults local"]) {
		assert.equal(parseDiscoverArgs(args).kind, "invalid", `"${args}" must be rejected`);
	}
	ck(parseDiscoverArgs("model x ctx 1,024"), { kind: "model-set", modelId: "x", field: "contextWindow", value: "1024", source: undefined });
});

test("destructive verbs distinguish confirmation", () => {
	assert.equal((parseDiscoverArgs("preset remove local m s") as { confirmed: boolean }).confirmed, false);
	assert.equal((parseDiscoverArgs("preset remove local m s --yes") as { confirmed: boolean }).confirmed, true);
	assert.equal((parseDiscoverArgs("routing remove local m --yes") as { confirmed: boolean }).confirmed, true);
});

test("completions teach the nested grammar", () => {
	const names = ["local"];
	const top = (completeDiscoverArgs("", names) ?? []).map((c) => c.value);
	for (const expected of ["status", "source add ", "source rename ", "source auth ", "source defaults ", "source rescan ", "model ", "preset set ", "routing set ", "routing conventional ", "routing remove "]) {
		assert.ok(top.includes(expected), `top-level completions must include "${expected}"`);
	}
	const auth = (completeDiscoverArgs("source auth ", names) ?? []).map((c) => c.value);
	assert.ok(auth.includes("source auth local --key-from-env "), "auth completion must teach the env-var path");
});

test("unknown verbs stay invalid with guidance", () => {
	for (const args of ["rename local x", "preset local thinking", "routing local m medium fast", "nonsense"]) {
		assert.equal(parseDiscoverArgs(args).kind, "invalid", `"${args}" must be invalid`);
	}
});

test("url shorthand still wins over unknown words", () => {
	const intent = parseDiscoverArgs("http://127.0.0.1:8123/v1");
	assert.equal(intent.kind, "add");
});

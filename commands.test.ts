import assert from "node:assert/strict";
import test from "node:test";
import { completeDiscoverArgs, parseDiscoverArgs } from "./commands.ts";

test("command parser preserves bare and direct-URL behavior", () => {
	assert.deepEqual(parseDiscoverArgs(""), { kind: "open" });
	assert.deepEqual(parseDiscoverArgs("http://localhost:8080"), { kind: "add", url: "http://localhost:8080" });
	assert.deepEqual(parseDiscoverArgs("localhost:8080"), { kind: "add", url: "localhost:8080" });
	assert.deepEqual(parseDiscoverArgs("models.local/v1"), { kind: "add", url: "models.local/v1" });
	assert.deepEqual(parseDiscoverArgs("[::1]:8080"), { kind: "add", url: "[::1]:8080" });
});

test("command parser recognizes reports and source listing", () => {
	assert.deepEqual(parseDiscoverArgs("status"), { kind: "status" });
	assert.deepEqual(parseDiscoverArgs("source list"), { kind: "status" });
	assert.deepEqual(parseDiscoverArgs("doctor"), { kind: "doctor" });
	assert.deepEqual(parseDiscoverArgs("paths"), { kind: "paths" });
	assert.deepEqual(parseDiscoverArgs("help"), { kind: "help" });
});

test("source add grammar accepts only URL plus optional name", () => {
	assert.deepEqual(parseDiscoverArgs("source add"), { kind: "add" });
	assert.deepEqual(parseDiscoverArgs("source add http://host:8080"), { kind: "add", url: "http://host:8080" });
	assert.deepEqual(parseDiscoverArgs("source add host:8080 --name local"), {
		kind: "add", url: "host:8080", providerName: "local",
	});
	assert.match(parseDiscoverArgs("source add host:8080 extra").kind, /invalid/);
});

test("source remove preserves names with spaces and explicit intent", () => {
	assert.deepEqual(parseDiscoverArgs("source remove my workstation"), {
		kind: "remove", name: "my workstation", confirmed: false,
	});
	assert.deepEqual(parseDiscoverArgs("source remove my workstation --yes"), {
		kind: "remove", name: "my workstation", confirmed: true,
	});
	assert.equal(parseDiscoverArgs("source remove").kind, "invalid");
});

test("unknown input is explicit and completions teach full replacements", () => {
	assert.deepEqual(parseDiscoverArgs("nonsense"), { kind: "invalid", message: "Unknown /discover input: nonsense" });
	const completions = completeDiscoverArgs("source remove w", ["workstation", "other"]);
	assert.ok(completions?.some((item) => item.value === "source remove workstation"));
	assert.ok(completions?.some((item) => item.value === "source remove workstation --yes"));
	assert.equal(completeDiscoverArgs("zzz", []), null);
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import {
	STORAGE_PATH,
	getStorageDiagnostic,
	loadProviders,
	saveProviders,
} from "./storage.ts";

test("storage writes atomically with owner-only permissions", { concurrency: false }, () => {
	assert.deepEqual(loadProviders(), []);
	saveProviders([{ name: "private", baseUrl: "http://localhost:8080", apiKey: "stored-secret" }]);
	assert.equal(existsSync(STORAGE_PATH), true);
	assert.equal(statSync(STORAGE_PATH).mode & 0o777, 0o600);
	assert.equal(statSync(dirname(STORAGE_PATH)).mode & 0o077, 0);
	assert.equal(loadProviders()[0]?.name, "private");
	assert.deepEqual(readdirSync(dirname(STORAGE_PATH)).filter((name) => name.endsWith(".tmp")), []);
});

test("corrupt configuration is preserved instead of silently overwritten", { concurrency: false }, () => {
	mkdirSync(dirname(STORAGE_PATH), { recursive: true });
	writeFileSync(STORAGE_PATH, "{ definitely not json", { mode: 0o600 });
	assert.deepEqual(loadProviders(), []);
	const diagnostic = getStorageDiagnostic();
	assert.ok(diagnostic?.preservedPath);
	assert.equal(existsSync(STORAGE_PATH), false);
	assert.equal(existsSync(diagnostic.preservedPath), true);
	assert.match(diagnostic.message, /preserved/);
});

test("invalid provider shapes are preserved as corrupt evidence", { concurrency: false }, () => {
	writeFileSync(STORAGE_PATH, JSON.stringify([{ name: 42, baseUrl: "http://localhost" }]), { mode: 0o600 });
	assert.deepEqual(loadProviders(), []);
	const diagnostic = getStorageDiagnostic();
	assert.ok(diagnostic?.preservedPath);
	assert.equal(existsSync(diagnostic.preservedPath), true);
});

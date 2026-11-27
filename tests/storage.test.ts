import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import {
	STORAGE_PATH,
	deleteModelProfile,
	getInvalidModelProfiles,
	getModelProfiles,
	getStorageDiagnostic,
	loadProviders,
	saveModelProfile,
	saveProviders,
	type DiscoveredProvider,
} from "../extensions/storage.ts";

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

test("a save keeps a stored preset that fails validation, and the doctor data lists it", { concurrency: false }, () => {
	const provider: DiscoveredProvider = {
		name: "keep",
		baseUrl: "http://localhost:8080",
		modelProfiles: {
			m: [
				{ slug: "good", sampling: { temperature: 0.7 } },
				{ slug: "future", chatTemplateKwargs: { unknown_key: true } } as never,
			],
		},
	};
	assert.deepEqual(getModelProfiles(provider, "m").map((profile) => profile.slug), ["good"]);
	saveModelProfile(provider, "m", { slug: "good", sampling: { temperature: 0.9 } }, "good");
	saveModelProfile(provider, "m", { slug: "new", sampling: { topK: 20 } });
	assert.deepEqual(provider.modelProfiles?.m.map((profile) => profile.slug), ["good", "future", "new"]);
	assert.equal(provider.modelProfiles?.m[0].sampling?.temperature, 0.9);
	const invalid = getInvalidModelProfiles(provider);
	assert.equal(invalid.length, 1);
	assert.equal(invalid[0].modelId, "m");
	assert.equal(invalid[0].slug, "future");
	deleteModelProfile(provider, "m", "good");
	assert.deepEqual(provider.modelProfiles?.m.map((profile) => profile.slug), ["future", "new"]);
});

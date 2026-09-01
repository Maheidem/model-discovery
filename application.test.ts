import assert from "node:assert/strict";
import test from "node:test";
import { createDiscoveryApplication, type DiscoveryRepository } from "./application.ts";
import type { ModelProfileRouting } from "./profiles.ts";
import type { DiscoveredProvider } from "./storage.ts";

function fixture() {
	let providers: DiscoveredProvider[] = [{ name: "local", baseUrl: "http://localhost:8080" }];
	const repository: DiscoveryRepository = {
		list: () => structuredClone(providers),
		save: (provider) => {
			const index = providers.findIndex((candidate) => candidate.name === provider.name);
			if (index >= 0) providers[index] = structuredClone(provider);
			else providers.push(structuredClone(provider));
		},
		remove: (name) => { providers = providers.filter((provider) => provider.name !== name); },
		rename: (oldName, newName) => {
			const provider = providers.find((candidate) => candidate.name === oldName);
			if (!provider || providers.some((candidate) => candidate.name === newName)) return false;
			provider.name = newName;
			return true;
		},
	};
	return { app: createDiscoveryApplication(repository), providers: () => providers };
}

test("application actions own source mutations", () => {
	const state = fixture();
	const provider = state.app.findSource("local");
	assert.ok(provider);
	state.app.setCredential(provider, "secret-value");
	assert.equal(state.providers()[0].apiKey, "secret-value");

	const renamed = state.app.renameSource(provider, "workstation");
	assert.deepEqual(renamed, { ok: true, oldName: "local", newName: "workstation" });
	assert.equal(provider.name, "workstation");
	assert.equal(state.app.findSource("workstation")?.baseUrl, "http://localhost:8080");
	assert.equal(state.app.removeSource("workstation"), true);
	assert.equal(state.app.removeSource("workstation"), false);
});

test("application rejects invalid and duplicate source names", () => {
	const state = fixture();
	const local = state.app.findSource("local");
	assert.ok(local);
	state.app.saveSource({ name: "other", baseUrl: "http://localhost:9000" });
	assert.equal(state.app.renameSource(local, " ").reason, "invalid");
	assert.equal(state.app.renameSource(local, "other").reason, "duplicate");
	assert.equal(local.name, "local");
});

test("profile and routing actions persist through the same repository", () => {
	const state = fixture();
	const provider = state.app.findSource("local");
	assert.ok(provider);
	state.app.saveProfile(provider, "model", { slug: "focused", chatTemplateKwargs: { enable_thinking: true } });
	assert.equal(state.app.profiles(provider, "model")[0]?.slug, "focused");
	const routing: ModelProfileRouting = {
		enabled: true,
		aliasSlug: "adaptive",
		levels: { off: "focused", minimal: "focused", low: "focused", medium: "focused", high: "focused", xhigh: "focused", max: "focused" },
	};
	state.app.saveRouting(provider, "model", routing);
	assert.deepEqual(state.app.profileRouting(provider, "model"), routing);
	state.app.removeRouting(provider, "model");
	state.app.removeProfile(provider, "model", "focused");
	assert.equal(state.app.profileRouting(provider, "model"), undefined);
	assert.deepEqual(state.app.profiles(provider, "model"), []);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
	createDiscoveryApplication,
	modelSettingPatch,
	patchModelOverride,
	type DiscoveryRepository,
} from "../extensions/application.ts";
import type { ModelProfileRouting } from "../extensions/profiles.ts";
import type { DiscoveredProvider } from "../extensions/storage.ts";

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

const DEFAULT_LEVELS = { off: "instruct", minimal: "thinking", low: "thinking", medium: "thinking", high: "thinking", xhigh: "thinking", max: "thinking" };
const DEFAULTS = {
	presets: [
		{ slug: "instruct", chatTemplateKwargs: { enable_thinking: false }, sampling: { temperature: 0.7 }, exposeAsModel: false },
		{ slug: "thinking", chatTemplateKwargs: { enable_thinking: true }, sampling: { temperature: 1 }, exposeAsModel: false },
	],
	routing: { enabled: true, aliasSlug: "adaptive", levels: DEFAULT_LEVELS },
};

test("applyFamilyDefaults replaces a preset with the same name and keeps the other presets", () => {
	const state = fixture();
	const provider = state.app.findSource("local");
	assert.ok(provider);
	state.app.saveProfile(provider, "model", { slug: "mine", sampling: { temperature: 0.2 } });
	state.app.saveProfile(provider, "model", { slug: "thinking", chatTemplateKwargs: { enable_thinking: true }, sampling: { temperature: 0.1 } });
	state.app.applyFamilyDefaults(provider, "model", DEFAULTS);
	const stored = state.providers()[0];
	assert.deepEqual(stored.modelProfiles?.model.map((preset) => preset.slug), ["mine", "thinking", "instruct"]);
	assert.equal(stored.modelProfiles?.model[1].sampling?.temperature, 1);
	assert.equal(stored.modelProfiles?.model[0].sampling?.temperature, 0.2);
	assert.deepEqual(stored.modelProfileRouting?.model, { enabled: true, aliasSlug: "adaptive", levels: DEFAULT_LEVELS });
});

test("applyFamilyDefaults keeps a stored alias name and turns the routing on", () => {
	const state = fixture();
	const provider = state.app.findSource("local");
	assert.ok(provider);
	state.app.saveProfile(provider, "model", { slug: "mine", sampling: { temperature: 0.2 } });
	const levels = { off: "mine", minimal: "mine", low: "mine", medium: "mine", high: "mine", xhigh: "mine", max: "mine" };
	state.app.saveRouting(provider, "model", { enabled: false, aliasSlug: "auto", levels });
	state.app.applyFamilyDefaults(provider, "model", DEFAULTS);
	assert.deepEqual(state.providers()[0].modelProfileRouting?.model, { enabled: true, aliasSlug: "auto", levels: DEFAULT_LEVELS });

	// A stored alias with the name of a copied preset cannot stay: the two names collide.
	state.app.saveRouting(provider, "model", { enabled: true, aliasSlug: "thinking", levels });
	state.app.applyFamilyDefaults(provider, "model", DEFAULTS);
	assert.equal(state.providers()[0].modelProfileRouting?.model.aliasSlug, "adaptive");
});

test("modelSettingPatch stores only a value that is different from the automatic value", () => {
	const facts = { familyIds: ["qwen3.8", "gemma4"], kind: "chat" };
	assert.deepEqual(modelSettingPatch("defaults", "off", facts), { patch: { familyDefaults: false } });
	assert.deepEqual(modelSettingPatch("defaults", "on", facts), { patch: { familyDefaults: undefined } });
	assert.deepEqual(modelSettingPatch("family", "gemma4", facts), { patch: { family: "gemma4" } });
	assert.deepEqual(modelSettingPatch("family", "none", facts), { patch: { family: "none" } });
	assert.deepEqual(modelSettingPatch("family", "auto", facts), { patch: { family: undefined } });
	assert.match((modelSettingPatch("family", "nope", facts) as { error: string }).error, /Unknown family "nope".*qwen3\.8, gemma4, auto, none/);
	assert.deepEqual(modelSettingPatch("hidden", "on", facts), { patch: { hidden: true } });
	assert.deepEqual(modelSettingPatch("hidden", "off", facts), { patch: { hidden: undefined } });
	assert.deepEqual(modelSettingPatch("hidden", "off", { ...facts, kind: "embedding" }), { patch: { hidden: false } });
	assert.deepEqual(modelSettingPatch("hidden", "on", { ...facts, kind: "embedding" }), { patch: { hidden: undefined } });
	assert.deepEqual(modelSettingPatch("reasoning", "off", facts), { patch: { reasoning: false } });
	assert.deepEqual(modelSettingPatch("reasoning", "auto", facts), { patch: { reasoning: undefined } });
	assert.deepEqual(modelSettingPatch("vision", "on", facts), { patch: { input: ["text", "image"] } });
	assert.deepEqual(modelSettingPatch("vision", "off", facts), { patch: { input: ["text"] } });
	assert.deepEqual(modelSettingPatch("vision", "auto", facts), { patch: { input: undefined } });
	assert.ok("error" in modelSettingPatch("hidden", "auto", facts));
});

test("patchModelOverride deletes one key, keeps the other keys, and drops an empty object", () => {
	const provider: DiscoveredProvider = {
		name: "local",
		baseUrl: "http://localhost:8080",
		modelOverrides: { a: { reasoning: true, contextWindow: 4096, family: "qwen3.8" }, b: { maxTokens: 10 } },
	};
	patchModelOverride(provider, "a", { reasoning: undefined });
	assert.deepEqual(provider.modelOverrides, { a: { contextWindow: 4096, family: "qwen3.8" }, b: { maxTokens: 10 } });
	patchModelOverride(provider, "a", { contextWindow: undefined, family: undefined });
	assert.deepEqual(provider.modelOverrides, { b: { maxTokens: 10 } });
	patchModelOverride(provider, "b", { maxTokens: undefined });
	assert.equal(provider.modelOverrides, undefined);
});

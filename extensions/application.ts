import type { ModelProfile, ModelProfileRouting } from "./profiles.ts";
import {
	deleteModelProfile,
	deleteModelProfileRouting,
	deleteProvider,
	getModelProfileRouting,
	getModelProfiles,
	loadProviders,
	renameProvider,
	saveModelProfile,
	saveModelProfileRouting,
	upsertProvider,
	type DiscoveredProvider,
	type ModelOverride,
} from "./storage.ts";

export interface DiscoveryRepository {
	list(): DiscoveredProvider[];
	save(provider: DiscoveredProvider): void;
	remove(name: string): void;
	rename(oldName: string, newName: string): boolean;
}

export interface RenameSourceResult {
	ok: boolean;
	oldName: string;
	newName: string;
	reason?: "missing" | "duplicate" | "invalid";
}

export interface DiscoveryApplication {
	listSources(): DiscoveredProvider[];
	findSource(name: string): DiscoveredProvider | undefined;
	saveSource(provider: DiscoveredProvider): void;
	removeSource(name: string): boolean;
	renameSource(provider: DiscoveredProvider, newName: string): RenameSourceResult;
	setCredential(provider: DiscoveredProvider, apiKey: string | undefined): void;
	profiles(provider: DiscoveredProvider, modelId: string): ModelProfile[];
	profileRouting(provider: DiscoveredProvider, modelId: string): ModelProfileRouting | undefined;
	saveProfile(provider: DiscoveredProvider, modelId: string, profile: ModelProfile, previousSlug?: string): void;
	removeProfile(provider: DiscoveredProvider, modelId: string, slug: string): void;
	saveRouting(provider: DiscoveredProvider, modelId: string, routing: ModelProfileRouting): void;
	removeRouting(provider: DiscoveredProvider, modelId: string): void;
	/**
	 * Copy the recommended presets and routing of a model into the config.
	 * A stored preset with the same name is replaced. Other stored presets stay.
	 * A stored adaptive alias name stays.
	 */
	applyFamilyDefaults(provider: DiscoveredProvider, modelId: string, defaults: FamilyDefaults): void;
}

export interface FamilyDefaults {
	presets: readonly ModelProfile[];
	routing: ModelProfileRouting;
}

/** A change of the stored settings of one model. A key with the value `undefined` is deleted. */
export type ModelOverridePatch = { [K in keyof ModelOverride]?: ModelOverride[K] | undefined };

/**
 * Change the stored settings of one model on the provider object. The caller
 * saves the provider. An empty settings object is not kept.
 */
export function patchModelOverride(provider: DiscoveredProvider, modelId: string, patch: ModelOverridePatch): void {
	const next: Record<string, unknown> = { ...provider.modelOverrides?.[modelId] };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete next[key];
		else next[key] = value;
	}
	const all = { ...provider.modelOverrides };
	if (Object.keys(next).length > 0) all[modelId] = next as ModelOverride;
	else delete all[modelId];
	provider.modelOverrides = Object.keys(all).length > 0 ? all : undefined;
}

export type ModelSettingField = "defaults" | "family" | "hidden" | "reasoning" | "vision";

/**
 * The stored form of one model setting. Only a value that is different from
 * the automatic value is stored.
 * - `defaults on|off`: `off` stores `familyDefaults: false`.
 * - `family <id>|auto|none`: `auto` stores nothing.
 * - `hidden on|off`: a chat model is shown by default. Each other kind is hidden by default.
 * - `reasoning on|off|auto` and `vision on|off|auto`: `auto` deletes the stored value, and
 *   the server value or the family value applies again.
 */
export function modelSettingPatch(
	field: ModelSettingField,
	value: string,
	facts: { familyIds: readonly string[]; kind: string },
): { patch: ModelOverridePatch } | { error: string } {
	if (field === "family") {
		if (value === "auto") return { patch: { family: undefined } };
		if (value === "none" || facts.familyIds.includes(value)) return { patch: { family: value } };
		return { error: `Unknown family "${value}". Use one of: ${[...facts.familyIds, "auto", "none"].join(", ")}.` };
	}
	if (field === "reasoning" || field === "vision") {
		if (value !== "on" && value !== "off" && value !== "auto") return { error: `${field} expects on, off or auto.` };
		if (field === "reasoning") return { patch: { reasoning: value === "auto" ? undefined : value === "on" } };
		return { patch: { input: value === "auto" ? undefined : value === "on" ? ["text", "image"] : ["text"] } };
	}
	if (value !== "on" && value !== "off") return { error: `${field} expects on or off.` };
	const on = value === "on";
	if (field === "defaults") return { patch: { familyDefaults: on ? undefined : false } };
	const hiddenByDefault = facts.kind !== "chat";
	return { patch: { hidden: on === hiddenByDefault ? undefined : on } };
}

export const fileDiscoveryRepository: DiscoveryRepository = {
	list: loadProviders,
	save: upsertProvider,
	remove: deleteProvider,
	rename: renameProvider,
};

export function createDiscoveryApplication(
	repository: DiscoveryRepository = fileDiscoveryRepository,
): DiscoveryApplication {
	return {
		listSources: () => repository.list(),
		findSource: (name) => repository.list().find((provider) => provider.name === name),
		saveSource: (provider) => repository.save(provider),
		removeSource: (name) => {
			if (!repository.list().some((provider) => provider.name === name)) return false;
			repository.remove(name);
			return true;
		},
		renameSource: (provider, rawName) => {
			const oldName = provider.name;
			const newName = rawName.trim();
			if (!newName) return { ok: false, oldName, newName, reason: "invalid" };
			const providers = repository.list();
			if (!providers.some((candidate) => candidate.name === oldName)) {
				return { ok: false, oldName, newName, reason: "missing" };
			}
			if (providers.some((candidate) => candidate.name === newName && candidate.name !== oldName)) {
				return { ok: false, oldName, newName, reason: "duplicate" };
			}
			if (newName !== oldName && !repository.rename(oldName, newName)) {
				return { ok: false, oldName, newName, reason: "duplicate" };
			}
			provider.name = newName;
			return { ok: true, oldName, newName };
		},
		setCredential: (provider, apiKey) => {
			provider.apiKey = apiKey;
			repository.save(provider);
		},
		profiles: (provider, modelId) => getModelProfiles(provider, modelId),
		profileRouting: (provider, modelId) => getModelProfileRouting(provider, modelId),
		saveProfile: (provider, modelId, profile, previousSlug) => {
			saveModelProfile(provider, modelId, profile, previousSlug);
			repository.save(provider);
		},
		removeProfile: (provider, modelId, slug) => {
			deleteModelProfile(provider, modelId, slug);
			repository.save(provider);
		},
		saveRouting: (provider, modelId, routing) => {
			saveModelProfileRouting(provider, modelId, routing);
			repository.save(provider);
		},
		removeRouting: (provider, modelId) => {
			deleteModelProfileRouting(provider, modelId);
			repository.save(provider);
		},
		applyFamilyDefaults: (provider, modelId, defaults) => {
			for (const preset of defaults.presets) saveModelProfile(provider, modelId, { ...preset }, preset.slug);
			const stored = getModelProfileRouting(provider, modelId);
			// A stored alias name stays, unless a copied preset has the same name.
			const keepAlias = stored && !defaults.presets.some((preset) => preset.slug === stored.aliasSlug);
			saveModelProfileRouting(provider, modelId, {
				enabled: true,
				aliasSlug: keepAlias ? stored.aliasSlug : defaults.routing.aliasSlug,
				levels: { ...defaults.routing.levels },
			});
			repository.save(provider);
		},
	};
}

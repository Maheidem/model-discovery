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
	};
}

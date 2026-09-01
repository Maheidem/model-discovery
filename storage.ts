import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import {
	migrateLegacyProfileRouting,
	validateModelProfile,
	type ModelProfile,
	type ModelProfileRouting,
} from "./profiles.ts";
import { redactSecret } from "./providers.ts";

export interface ModelOverride {
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
}

export interface DiscoveredProvider {
	name: string;
	baseUrl: string;
	apiKey?: string;
	serverType?: string;
	defaultContextWindow?: number;
	defaultMaxTokens?: number;
	modelOverrides?: Record<string, ModelOverride>;
	modelProfiles?: Record<string, ModelProfile[]>;
	modelProfileRouting?: Record<string, ModelProfileRouting>;
	profileSchemaVersion?: number;
	cachedModels?: Record<string, unknown>[];
	compat?: Record<string, unknown>;
	/**
	 * Inline $defs/$ref in outgoing tool schemas for this endpoint (default: true for
	 * local/self-hosted endpoints, where llama.cpp-style grammar converters reject any
	 * $ref that is not resolvable at the document root). Set false to send verbatim.
	 */
	repairToolSchemas?: boolean;
	/** Last successful live catalogue refresh (legacy name retained in storage). */
	lastScanned?: number;
	lastScanAttempt?: number;
	lastScanError?: string;
}

export interface StorageDiagnostic {
	kind: "warning";
	message: string;
	preservedPath?: string;
}

export const STORAGE_PATH = join(os.homedir(), ".pi", "agent", "model-discovery.json");
let latestStorageDiagnostic: StorageDiagnostic | undefined;

export function getStorageDiagnostic(): StorageDiagnostic | undefined {
	return latestStorageDiagnostic;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function corruptBackupPath(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const base = `${STORAGE_PATH}.corrupt-${stamp}`;
	let candidate = base;
	let suffix = 1;
	while (existsSync(candidate)) candidate = `${base}-${suffix++}`;
	return candidate;
}

function preserveCorruptStorage(error: unknown): void {
	const backupPath = corruptBackupPath();
	try {
		renameSync(STORAGE_PATH, backupPath);
		latestStorageDiagnostic = {
			kind: "warning",
			message: `Invalid configuration was preserved as ${backupPath}.`,
			preservedPath: backupPath,
		};
	} catch (backupError) {
		latestStorageDiagnostic = {
			kind: "warning",
			message: `Configuration could not be read (${errorMessage(error)}) or preserved (${errorMessage(backupError)}).`,
		};
	}
}

export function writeProvidersAtomic(providers: DiscoveredProvider[]): void {
	mkdirSync(dirname(STORAGE_PATH), { recursive: true, mode: 0o700 });
	const tempPath = `${STORAGE_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tempPath, JSON.stringify(providers, null, 2), { encoding: "utf-8", mode: 0o600 });
		renameSync(tempPath, STORAGE_PATH);
	} catch (error) {
		try {
			if (existsSync(tempPath)) unlinkSync(tempPath);
		} catch {
			/* best-effort cleanup */
		}
		throw error;
	}
}

export function loadProviders(): DiscoveredProvider[] {
	if (!existsSync(STORAGE_PATH)) return [];
	let raw: string;
	try {
		raw = readFileSync(STORAGE_PATH, "utf-8");
	} catch (error) {
		latestStorageDiagnostic = {
			kind: "warning",
			message: `Configuration could not be read: ${errorMessage(error)}`,
		};
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) throw new Error("Expected the top-level value to be an array of providers.");
		if (!parsed.every((provider) =>
			provider !== null &&
			typeof provider === "object" &&
			typeof (provider as { name?: unknown }).name === "string" &&
			typeof (provider as { baseUrl?: unknown }).baseUrl === "string"
		)) {
			throw new Error("Every provider requires string name and baseUrl fields.");
		}
	} catch (error) {
		preserveCorruptStorage(error);
		return [];
	}

	const providers = parsed as DiscoveredProvider[];
	let migrated = false;
	for (const provider of providers) {
		if (!provider || typeof provider !== "object") continue;
		if ((provider.profileSchemaVersion ?? 0) >= 2) continue;
		for (const [modelId, rawProfiles] of Object.entries(provider.modelProfiles ?? {})) {
			if (!Array.isArray(rawProfiles)) continue;
			const result = migrateLegacyProfileRouting(rawProfiles, provider.modelProfileRouting?.[modelId]);
			if (!result.changed || !result.routing) continue;
			provider.modelProfiles = { ...provider.modelProfiles, [modelId]: result.profiles };
			provider.modelProfileRouting = { ...provider.modelProfileRouting, [modelId]: result.routing };
			migrated = true;
		}
		provider.profileSchemaVersion = 2;
		migrated = true;
	}
	if (migrated) writeProvidersAtomic(providers);
	return providers;
}

export function saveProviders(providers: DiscoveredProvider[]): void {
	writeProvidersAtomic(providers);
}

export function upsertProvider(provider: DiscoveredProvider): void {
	const all = loadProviders();
	const index = all.findIndex((candidate) => candidate.name === provider.name);
	if (index >= 0) all[index] = provider;
	else all.push(provider);
	saveProviders(all);
}

export function deleteProvider(name: string): void {
	saveProviders(loadProviders().filter((provider) => provider.name !== name));
}

export function renameProvider(oldName: string, newName: string): boolean {
	const all = loadProviders();
	const index = all.findIndex((provider) => provider.name === oldName);
	if (index < 0 || all.some((provider) => provider.name === newName)) return false;
	all[index].name = newName;
	saveProviders(all);
	return true;
}

export function persistProviderScanState(provider: DiscoveredProvider): void {
	try {
		const providers = loadProviders();
		const stored = providers.find(
			(candidate) => candidate.name === provider.name && candidate.baseUrl === provider.baseUrl,
		);
		if (!stored) return;
		stored.serverType = provider.serverType;
		stored.cachedModels = provider.cachedModels;
		stored.lastScanned = provider.lastScanned;
		stored.lastScanAttempt = provider.lastScanAttempt;
		stored.lastScanError = provider.lastScanError;
		saveProviders(providers);
	} catch (error) {
		// Runtime registration must not fail merely because scan metadata could not be persisted.
		console.error(`[model-discovery] ${provider.name}: could not persist catalogue state (${errorMessage(error)}).`);
	}
}

export function recordSuccessfulScan(
	provider: DiscoveredProvider,
	models: Record<string, unknown>[],
	serverType: string,
	persist = true,
): void {
	const now = Date.now();
	provider.serverType = serverType;
	provider.cachedModels = models;
	provider.lastScanned = now;
	provider.lastScanAttempt = now;
	provider.lastScanError = undefined;
	if (persist) persistProviderScanState(provider);
}

export function recordFailedScan(provider: DiscoveredProvider, error: unknown, persist = true): void {
	provider.lastScanAttempt = Date.now();
	provider.lastScanError = redactSecret(errorMessage(error), provider.apiKey);
	if (persist) persistProviderScanState(provider);
}

export function getModelProfiles(provider: DiscoveredProvider, modelId: string): ModelProfile[] {
	const profiles: unknown = provider.modelProfiles?.[modelId];
	if (!Array.isArray(profiles)) return [];
	return profiles.filter((profile): profile is ModelProfile => validateModelProfile(profile) === null);
}

export function saveModelProfile(
	provider: DiscoveredProvider,
	modelId: string,
	profile: ModelProfile,
	previousSlug?: string,
): void {
	const profiles = getModelProfiles(provider, modelId);
	const index = previousSlug === undefined ? -1 : profiles.findIndex((item) => item.slug === previousSlug);
	const next = [...profiles];
	if (index >= 0) next[index] = profile;
	else next.push(profile);
	provider.modelProfiles = { ...provider.modelProfiles, [modelId]: next };
}

export function deleteModelProfile(provider: DiscoveredProvider, modelId: string, slug: string): void {
	const nextProfiles = getModelProfiles(provider, modelId).filter((profile) => profile.slug !== slug);
	const modelProfiles = { ...provider.modelProfiles };
	if (nextProfiles.length > 0) modelProfiles[modelId] = nextProfiles;
	else delete modelProfiles[modelId];
	provider.modelProfiles = Object.keys(modelProfiles).length > 0 ? modelProfiles : undefined;
}

export function getModelProfileRouting(
	provider: DiscoveredProvider,
	modelId: string,
): ModelProfileRouting | undefined {
	return provider.modelProfileRouting?.[modelId];
}

export function saveModelProfileRouting(
	provider: DiscoveredProvider,
	modelId: string,
	routing: ModelProfileRouting,
): void {
	provider.modelProfileRouting = { ...provider.modelProfileRouting, [modelId]: routing };
}

export function deleteModelProfileRouting(provider: DiscoveredProvider, modelId: string): void {
	const routing = { ...provider.modelProfileRouting };
	delete routing[modelId];
	provider.modelProfileRouting = Object.keys(routing).length > 0 ? routing : undefined;
}

/**
 * Model family data: file and network I/O. No pi API.
 *
 * There are two layers:
 * - bundled: the `families/` directory of the package.
 * - cache: `<agent dir>/model-discovery-families.json`, written by
 *   `refreshFamilies()` from the data on GitHub.
 *
 * The cache wins only when it is valid and its `revision` is higher than the
 * bundled `revision`. No function in this module throws.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH } from "./config.ts";
import {
	FAMILY_SCHEMA_VERSION,
	validateFamily,
	validateFamilyIndex,
	type FamilyIndex,
	type FamilyRegistry,
	type ModelFamily,
} from "./families.ts";

/** The cache file. It is in the same directory as the config file. */
export const FAMILIES_CACHE_PATH = join(dirname(CONFIG_PATH), "model-discovery-families.json");
export const DEFAULT_FAMILIES_URL = "https://raw.githubusercontent.com/Maheidem/model-discovery/main/families/";

const BUNDLED_DIR = fileURLToPath(new URL("../families/", import.meta.url));
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3_000;

type Rejected = { file: string; error: string };

interface FamilyCache {
	checkedAt: number;
	fetchedAt: number;
	etag?: string;
	baseUrl: string;
	index: FamilyIndex;
	files: Record<string, unknown>;
	rejected: Rejected[];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EMPTY_INDEX: FamilyIndex = { schemaVersion: FAMILY_SCHEMA_VERSION, revision: 0, updated: "", files: [] };

function readBundled(): { registry: FamilyRegistry; byFile: Map<string, ModelFamily> } {
	const byFile = new Map<string, ModelFamily>();
	const rejected: Rejected[] = [];
	let index: FamilyIndex;
	try {
		const value = JSON.parse(readFileSync(join(BUNDLED_DIR, "index.json"), "utf-8")) as unknown;
		const error = validateFamilyIndex(value);
		if (error) throw new Error(error);
		index = value as FamilyIndex;
	} catch (error) {
		rejected.push({ file: "index.json", error: errorText(error) });
		return { registry: { index: { ...EMPTY_INDEX }, families: [], layer: "bundled", rejected }, byFile };
	}
	for (const file of index.files) {
		try {
			const value = JSON.parse(readFileSync(join(BUNDLED_DIR, file), "utf-8")) as unknown;
			const error = validateFamily(value);
			if (error) throw new Error(error);
			byFile.set(file, value as ModelFamily);
		} catch (error) {
			rejected.push({ file, error: errorText(error) });
		}
	}
	return { registry: { index, families: [...byFile.values()], layer: "bundled", rejected }, byFile };
}

/** Read the cache file. The result is `undefined` when there is no valid cache. */
function readCache(): FamilyCache | undefined {
	try {
		const value = JSON.parse(readFileSync(FAMILIES_CACHE_PATH, "utf-8")) as unknown;
		if (!isRecord(value) || !isRecord(value.files)) return undefined;
		if (typeof value.checkedAt !== "number" || typeof value.fetchedAt !== "number") return undefined;
		if (typeof value.baseUrl !== "string" || validateFamilyIndex(value.index) !== null) return undefined;
		const rejected = Array.isArray(value.rejected)
			? value.rejected.filter(
					(entry): entry is Rejected =>
						isRecord(entry) && typeof entry.file === "string" && typeof entry.error === "string",
				)
			: [];
		return {
			checkedAt: value.checkedAt,
			fetchedAt: value.fetchedAt,
			etag: typeof value.etag === "string" ? value.etag : undefined,
			baseUrl: value.baseUrl,
			index: value.index as FamilyIndex,
			files: value.files,
			rejected,
		};
	} catch {
		return undefined;
	}
}

function writeCache(cache: FamilyCache): void {
	mkdirSync(dirname(FAMILIES_CACHE_PATH), { recursive: true, mode: 0o700 });
	const tempPath = `${FAMILIES_CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tempPath, JSON.stringify(cache, null, 2), { encoding: "utf-8", mode: 0o600 });
		renameSync(tempPath, FAMILIES_CACHE_PATH);
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch {
			/* There is no temporary file to remove. */
		}
		throw error;
	}
}

/**
 * Read the family files of the package. A file that fails validation goes to
 * `rejected`.
 */
export function loadBundledFamilies(): FamilyRegistry {
	return readBundled().registry;
}

/**
 * Give the family data to use: the cache when it is valid and newer than the
 * bundled data, else the bundled data. A cached family file that fails
 * validation goes to `rejected`, and the bundled family with the same file
 * name replaces it.
 */
export function loadFamilyRegistry(): FamilyRegistry {
	const bundled = readBundled();
	try {
		const cache = readCache();
		if (!cache || cache.index.revision <= bundled.registry.index.revision) return bundled.registry;
		const families: ModelFamily[] = [];
		const rejected: Rejected[] = [];
		for (const file of cache.index.files) {
			const value = cache.files[file];
			const error =
				value === undefined
					? (cache.rejected.find((entry) => entry.file === file)?.error ?? "The file is not in the cache.")
					: validateFamily(value);
			if (error === null) {
				families.push(value as ModelFamily);
				continue;
			}
			rejected.push({ file, error });
			const fallback = bundled.byFile.get(file);
			if (fallback) families.push(fallback);
		}
		return { index: cache.index, families, layer: "cache", fetchedAt: cache.fetchedAt, rejected };
	} catch {
		return bundled.registry;
	}
}

export interface FamilyRefreshResult {
	status: "updated" | "not-modified" | "skipped" | "failed";
	reason?: string;
	revision?: number;
	rejected: { file: string; error: string }[];
}

/**
 * Get new family data from the network and write the cache.
 *
 * - `PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE=1` stops the check, unless `force` is set.
 * - One check in 24 hours, unless `force` is set.
 * - `PI_MODEL_DISCOVERY_FAMILIES_URL` replaces the base URL.
 * - A failure keeps the old cache and changes nothing.
 */
export async function refreshFamilies(
	options: { force?: boolean; now?: number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FamilyRefreshResult> {
	const failed = (reason: string): FamilyRefreshResult => ({ status: "failed", reason, rejected: [] });
	try {
		const force = options.force === true;
		const now = options.now ?? Date.now();
		const fetchImpl = options.fetchImpl ?? fetch;
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		if (!force && process.env.PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE === "1") {
			return { status: "skipped", reason: "PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE is set to 1.", rejected: [] };
		}
		const cache = readCache();
		if (!force && cache && now - cache.checkedAt < CHECK_INTERVAL_MS) {
			return {
				status: "skipped",
				reason: "The last check is less than 24 hours old.",
				revision: cache.index.revision,
				rejected: [],
			};
		}

		let baseUrl = process.env.PI_MODEL_DISCOVERY_FAMILIES_URL || DEFAULT_FAMILIES_URL;
		if (!baseUrl.endsWith("/")) baseUrl += "/";

		const headers: Record<string, string> = { Accept: "application/json" };
		if (!force && cache?.etag && cache.baseUrl === baseUrl) headers["If-None-Match"] = cache.etag;
		const indexResponse = await fetchImpl(`${baseUrl}index.json`, { headers, signal: AbortSignal.timeout(timeoutMs) });
		if (indexResponse.status === 304 && cache) {
			writeCache({ ...cache, checkedAt: now });
			return { status: "not-modified", revision: cache.index.revision, rejected: [] };
		}
		if (!indexResponse.ok) return failed(`index.json: HTTP ${indexResponse.status}`);
		const index = (await indexResponse.json()) as unknown;
		const indexError = validateFamilyIndex(index);
		if (indexError) return failed(`index.json: ${indexError}`);
		const validIndex = index as FamilyIndex;

		const files: Record<string, unknown> = {};
		const rejected: Rejected[] = [];
		for (const file of validIndex.files) {
			const response = await fetchImpl(`${baseUrl}${file}`, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) return failed(`${file}: HTTP ${response.status}`);
			let value: unknown;
			try {
				value = await response.json();
			} catch (error) {
				return failed(`${file}: ${errorText(error)}`);
			}
			const error = validateFamily(value);
			if (error) rejected.push({ file, error });
			else files[file] = value;
		}

		writeCache({
			checkedAt: now,
			fetchedAt: now,
			etag: indexResponse.headers.get("etag") ?? undefined,
			baseUrl,
			index: validIndex,
			files,
			rejected,
		});
		return { status: "updated", revision: validIndex.revision, rejected };
	} catch (error) {
		return failed(errorText(error));
	}
}

/** Lines for a doctor report about the family data in use. */
export function describeFamilyRegistry(registry: FamilyRegistry): string[] {
	const lines = [
		`Family data layer: ${registry.layer}`,
		`Revision: ${registry.index.revision}`,
		`Updated: ${registry.index.updated || "unknown"}`,
	];
	if (registry.layer === "cache" && registry.fetchedAt !== undefined) {
		lines.push(`Fetched: ${new Date(registry.fetchedAt).toISOString()}`);
	}
	lines.push(`Families: ${registry.families.length}`);
	for (const entry of registry.rejected) lines.push(`Rejected ${entry.file}: ${entry.error}`);
	return lines;
}

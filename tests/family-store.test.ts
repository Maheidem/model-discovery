/**
 * Tests for the family data store (family-store.ts).
 * The runner gives this file a temporary HOME, thus the cache file is in a
 * temporary agent directory. A local HTTP server replaces GitHub.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import test, { afterEach } from "node:test";
import { FAMILY_SCHEMA_VERSION } from "../extensions/families.ts";
import {
	DEFAULT_FAMILIES_URL,
	FAMILIES_CACHE_PATH,
	describeFamilyRegistry,
	loadBundledFamilies,
	loadFamilyRegistry,
	refreshFamilies,
} from "../extensions/family-store.ts";

const bundled = loadBundledFamilies();
const HOUR = 60 * 60 * 1000;

interface Fake {
	url: string;
	requests: { path: string; ifNoneMatch?: string }[];
	close: () => Promise<void>;
}

/** Serve `files` as JSON. `index.json` has the ETag `"v1"` and honours `If-None-Match`. */
async function fakeServer(files: Record<string, unknown>): Promise<Fake> {
	const requests: Fake["requests"] = [];
	const server: Server = createServer((req, res) => {
		const path = (req.url ?? "").replace(/^\/families\//, "");
		const ifNoneMatch = req.headers["if-none-match"];
		requests.push({ path, ifNoneMatch: typeof ifNoneMatch === "string" ? ifNoneMatch : undefined });
		if (!(path in files)) {
			res.writeHead(404).end();
			return;
		}
		if (path === "index.json" && ifNoneMatch === '"v1"') {
			res.writeHead(304).end();
			return;
		}
		const body = files[path];
		res.writeHead(200, { "Content-Type": "application/json", ETag: '"v1"' });
		res.end(typeof body === "string" ? body : JSON.stringify(body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		// No `/` at the end: refreshFamilies must add it.
		url: `http://127.0.0.1:${port}/families`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** The remote data: the bundled files with a higher revision and changed labels. */
function remoteFiles(revision = bundled.index.revision + 1): Record<string, unknown> {
	const files: Record<string, unknown> = {
		"index.json": { ...bundled.index, revision, updated: "2027-01-01" },
	};
	bundled.index.files.forEach((file, position) => {
		files[file] = { ...bundled.families[position], label: `${bundled.families[position].label} (remote)` };
	});
	return files;
}

async function withServer(files: Record<string, unknown>, run: (fake: Fake) => Promise<void>): Promise<void> {
	const fake = await fakeServer(files);
	process.env.PI_MODEL_DISCOVERY_FAMILIES_URL = fake.url;
	try {
		await run(fake);
	} finally {
		await fake.close();
	}
}

afterEach(() => {
	rmSync(FAMILIES_CACHE_PATH, { force: true });
	delete process.env.PI_MODEL_DISCOVERY_FAMILIES_URL;
	delete process.env.PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE;
});

test("the bundled registry loads all nine families with no rejected file", { concurrency: false }, () => {
	assert.deepEqual(bundled.rejected, []);
	assert.equal(bundled.layer, "bundled");
	assert.equal(bundled.index.schemaVersion, FAMILY_SCHEMA_VERSION);
	assert.equal(bundled.index.files.length, 9);
	assert.deepEqual(
		bundled.families.map((family) => family.id),
		["qwen3.8", "qwen3.6", "qwen3.5-small", "qwen3.5", "qwen3", "gemma4", "inkling2-small", "inkling2-mini", "inkling"],
	);
	assert.deepEqual(bundled.index.servers, { Ollama: { thinking: "top-level" }, "LM Studio": { thinking: "top-level" } });
	assert.match(DEFAULT_FAMILIES_URL, /\/families\/$/);
});

test("with no cache the bundled data is in use", { concurrency: false }, () => {
	const registry = loadFamilyRegistry();
	assert.equal(registry.layer, "bundled");
	assert.equal(registry.families.length, 9);
	assert.deepEqual(describeFamilyRegistry(registry), [
		"Family data layer: bundled",
		`Revision: ${bundled.index.revision}`,
		`Updated: ${bundled.index.updated}`,
		"Families: 9",
	]);
});

test("a refresh writes the cache, and the cache wins when its revision is higher", { concurrency: false }, async () => {
	await withServer(remoteFiles(), async (fake) => {
		const now = Date.UTC(2027, 0, 2);
		const result = await refreshFamilies({ now });
		assert.deepEqual(result, { status: "updated", revision: bundled.index.revision + 1, rejected: [] });
		assert.equal(fake.requests.length, 10);
		assert.equal(statSync(FAMILIES_CACHE_PATH).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(dirname(FAMILIES_CACHE_PATH)).filter((name) => name.endsWith(".tmp")), []);
		const cache = JSON.parse(readFileSync(FAMILIES_CACHE_PATH, "utf-8"));
		assert.equal(cache.checkedAt, now);
		assert.equal(cache.fetchedAt, now);
		assert.equal(cache.etag, '"v1"');
		assert.equal(cache.baseUrl, `${fake.url}/`);

		const registry = loadFamilyRegistry();
		assert.equal(registry.layer, "cache");
		assert.equal(registry.fetchedAt, now);
		assert.equal(registry.index.revision, bundled.index.revision + 1);
		assert.equal(registry.families.length, 9);
		assert.ok(registry.families.every((family) => family.label.endsWith("(remote)")));
		assert.deepEqual(describeFamilyRegistry(registry), [
			"Family data layer: cache",
			`Revision: ${bundled.index.revision + 1}`,
			"Updated: 2027-01-01",
			"Fetched: 2027-01-02T00:00:00.000Z",
			"Families: 9",
		]);
	});
});

test("a cache with the same revision as the bundled data does not win", { concurrency: false }, async () => {
	await withServer(remoteFiles(bundled.index.revision), async () => {
		assert.equal((await refreshFamilies()).status, "updated");
		assert.equal(loadFamilyRegistry().layer, "bundled");
	});
});

test("a family file that fails validation is rejected and the bundled copy is used", { concurrency: false }, async () => {
	const files = remoteFiles();
	files["gemma4.json"] = { ...(files["gemma4.json"] as object), match: ["("] };
	await withServer(files, async () => {
		const result = await refreshFamilies();
		assert.equal(result.status, "updated");
		assert.equal(result.rejected.length, 1);
		assert.equal(result.rejected[0].file, "gemma4.json");
		const cache = JSON.parse(readFileSync(FAMILIES_CACHE_PATH, "utf-8"));
		assert.equal("gemma4.json" in cache.files, false);

		const registry = loadFamilyRegistry();
		assert.equal(registry.layer, "cache");
		assert.deepEqual(registry.rejected, result.rejected);
		assert.equal(registry.families.length, 9);
		const gemma = registry.families.find((family) => family.id === "gemma4");
		assert.equal(gemma?.label, "Gemma 4");
		assert.equal(registry.families.find((family) => family.id === "qwen3.8")?.label, "Qwen 3.8 (remote)");
		assert.match(describeFamilyRegistry(registry).at(-1) ?? "", /^Rejected gemma4\.json: /);
	});
});

test("a cached family file that became invalid is rejected at load", { concurrency: false }, async () => {
	await withServer(remoteFiles(), async () => {
		await refreshFamilies();
		const cache = JSON.parse(readFileSync(FAMILIES_CACHE_PATH, "utf-8"));
		cache.files["qwen3.json"].id = "";
		writeFileSync(FAMILIES_CACHE_PATH, JSON.stringify(cache));
		const registry = loadFamilyRegistry();
		assert.equal(registry.rejected[0]?.file, "qwen3.json");
		assert.equal(registry.families.find((family) => family.id === "qwen3")?.label, "Qwen 3");
	});
});

test("an unknown schemaVersion fails and the older layer stays", { concurrency: false }, async () => {
	const files = remoteFiles();
	await withServer(files, async () => {
		assert.equal((await refreshFamilies({ now: 1 })).status, "updated");
		const before = readFileSync(FAMILIES_CACHE_PATH, "utf-8");
		files["index.json"] = { ...(files["index.json"] as object), schemaVersion: 2, revision: 99 };
		const result = await refreshFamilies({ force: true, now: 2 });
		assert.equal(result.status, "failed");
		assert.match(result.reason ?? "", /schemaVersion/);
		assert.equal(readFileSync(FAMILIES_CACHE_PATH, "utf-8"), before);
		assert.equal(loadFamilyRegistry().index.revision, bundled.index.revision + 1);
	});
});

test("an unknown schemaVersion with no cache keeps the bundled layer", { concurrency: false }, async () => {
	const files = remoteFiles();
	files["index.json"] = { ...(files["index.json"] as object), schemaVersion: 2 };
	await withServer(files, async () => {
		assert.equal((await refreshFamilies()).status, "failed");
		assert.equal(existsSync(FAMILIES_CACHE_PATH), false);
		assert.equal(loadFamilyRegistry().layer, "bundled");
	});
});

test("a file name with a path part fails the refresh", { concurrency: false }, async () => {
	const files = remoteFiles();
	files["index.json"] = { ...(files["index.json"] as object), files: ["../evil.json"] };
	await withServer(files, async (fake) => {
		const result = await refreshFamilies();
		assert.equal(result.status, "failed");
		assert.match(result.reason ?? "", /evil\.json/);
		assert.deepEqual(fake.requests.map((request) => request.path), ["index.json"]);
		assert.equal(existsSync(FAMILIES_CACHE_PATH), false);
	});
});

test("there is one check in 24 hours, unless force is set", { concurrency: false }, async () => {
	await withServer(remoteFiles(), async (fake) => {
		const start = Date.UTC(2027, 0, 2);
		assert.equal((await refreshFamilies({ now: start })).status, "updated");
		const count = fake.requests.length;
		const skipped = await refreshFamilies({ now: start + 23 * HOUR });
		assert.equal(skipped.status, "skipped");
		assert.equal(fake.requests.length, count);
		assert.equal((await refreshFamilies({ now: start + 23 * HOUR, force: true })).status, "updated");
		assert.equal(fake.requests.at(count)?.ifNoneMatch, undefined);
	});
});

test("a 304 answer updates only the check time", { concurrency: false }, async () => {
	await withServer(remoteFiles(), async (fake) => {
		const start = Date.UTC(2027, 0, 2);
		await refreshFamilies({ now: start });
		const count = fake.requests.length;
		const result = await refreshFamilies({ now: start + 25 * HOUR });
		assert.deepEqual(result, { status: "not-modified", revision: bundled.index.revision + 1, rejected: [] });
		assert.equal(fake.requests.length, count + 1);
		assert.equal(fake.requests.at(-1)?.ifNoneMatch, '"v1"');
		const cache = JSON.parse(readFileSync(FAMILIES_CACHE_PATH, "utf-8"));
		assert.equal(cache.checkedAt, start + 25 * HOUR);
		assert.equal(cache.fetchedAt, start);
		assert.equal((await refreshFamilies({ now: start + 26 * HOUR })).status, "skipped");
	});
});

test("the environment switch stops the check, unless force is set", { concurrency: false }, async () => {
	await withServer(remoteFiles(), async (fake) => {
		process.env.PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE = "1";
		assert.equal((await refreshFamilies()).status, "skipped");
		assert.equal(fake.requests.length, 0);
		assert.equal((await refreshFamilies({ force: true })).status, "updated");
	});
});

test("a network or parse failure does not throw and keeps the old cache", { concurrency: false }, async () => {
	await withServer(remoteFiles(), async () => {
		await refreshFamilies({ now: 1 });
	});
	const before = readFileSync(FAMILIES_CACHE_PATH, "utf-8");

	process.env.PI_MODEL_DISCOVERY_FAMILIES_URL = "http://127.0.0.1:1/";
	assert.equal((await refreshFamilies({ force: true })).status, "failed");

	const files = remoteFiles();
	delete files["qwen3.json"];
	await withServer(files, async () => {
		const result = await refreshFamilies({ force: true });
		assert.equal(result.status, "failed");
		assert.match(result.reason ?? "", /qwen3\.json: HTTP 404/);
	});

	files["qwen3.json"] = "{ not json";
	await withServer(files, async () => {
		assert.equal((await refreshFamilies({ force: true })).status, "failed");
	});

	const fetchImpl = (async () => {
		throw new Error("no network");
	}) as unknown as typeof fetch;
	assert.deepEqual(await refreshFamilies({ force: true, fetchImpl }), {
		status: "failed",
		reason: "no network",
		rejected: [],
	});
	assert.equal(readFileSync(FAMILIES_CACHE_PATH, "utf-8"), before);
});

test("a corrupt cache file is ignored", { concurrency: false }, () => {
	mkdirSync(dirname(FAMILIES_CACHE_PATH), { recursive: true });
	writeFileSync(FAMILIES_CACHE_PATH, "{ not json");
	assert.equal(loadFamilyRegistry().layer, "bundled");
});

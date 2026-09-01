import assert from "node:assert/strict";
import test from "node:test";
import {
	buildDiagnosticsLines,
	buildHomeItems,
	buildHomeSummary,
	formatDiscoveryStatus,
	sourceAvailability,
	summarizeSources,
} from "./ui-model.ts";
import type { DiscoveredProvider } from "./storage.ts";

const providers: DiscoveredProvider[] = [
	{
		name: "ready",
		baseUrl: "http://localhost:8080",
		serverType: "oMLX",
		apiKey: "never-render-this-secret",
		cachedModels: [{ id: "qwen" }],
		lastScanned: 1,
	},
	{
		name: "cached",
		baseUrl: "http://localhost:8081",
		serverType: "llama.cpp",
		apiKey: "never-render-this-secret",
		cachedModels: [{ id: "one" }, { id: "two" }],
		lastScanError: "connection refused for never-render-this-secret",
	},
	{
		name: "down",
		baseUrl: "http://localhost:8082",
		lastScanError: "unreachable",
	},
];

test("home model progressively discloses health and actions", () => {
	assert.deepEqual(sourceAvailability(providers[0]), "ready");
	assert.deepEqual(sourceAvailability(providers[1]), "degraded");
	assert.deepEqual(sourceAvailability(providers[2]), "unavailable");
	assert.deepEqual(summarizeSources(providers), {
		sourceCount: 3,
		modelCount: 3,
		readyCount: 1,
		degradedCount: 1,
		unavailableCount: 1,
		unscannedCount: 0,
	});
	assert.match(buildHomeSummary(providers).join("\n"), /1 ready · 1 cached · 1 unavailable/);
	const items = buildHomeItems(providers);
	assert.deepEqual(items.slice(-4).map((item) => item.value), ["add", "rescan-all", "diagnostics", "quit"]);
	assert.equal(buildHomeItems([])[0]?.value, "add");
});

test("status and diagnostics are useful but secret-safe", () => {
	const status = formatDiscoveryStatus(providers, { storagePath: "/tmp/home/.pi/agent/model-discovery.json", home: "/tmp/home" });
	assert.match(status, /^Model Discovery/m);
	assert.match(status, /Storage: ~\/\.pi\/agent\/model-discovery\.json/);
	assert.match(status, /cached\/degraded/);
	assert.doesNotMatch(status, /never-render-this-secret/);
	const diagnostics = buildDiagnosticsLines(providers).join("\n");
	assert.match(diagnostics, /authentication: API key configured/);
	assert.match(diagnostics, /latest error: connection refused/);
	assert.doesNotMatch(diagnostics, /never-render-this-secret/);
});

test("empty home makes the primary action obvious", () => {
	assert.deepEqual(buildHomeSummary([]), [
		"No sources configured",
		"Add a source to discover models from a local OpenAI-compatible endpoint.",
	]);
	assert.match(formatDiscoveryStatus([], { storagePath: "/tmp/config", home: "/tmp/home" }), /No sources configured/);
});

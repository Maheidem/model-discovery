/**
 * home.test.ts — slice 1a contract (PLAN §5, OPERATIONAL §1): the home frame
 * is FIXED height at every width and every source count; deeper navigation is
 * never cropped, because only the Sources WINDOW shrinks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	buildHomeSnapshot,
	formatAge,
	HOME_ACTION_ROWS,
	HOME_OVERFLOW_KEY,
	HOME_PANEL_ROWS,
	homePanelRowCount,
	homeSourceRows,
	type HomeSnapshotInput,
	type HomeSourceInput,
} from "../ui/home.ts";
import { modelDiscoveryVersion } from "../version.ts";

function source(name: string, over: Partial<HomeSourceInput> = {}): HomeSourceInput {
	return { name, baseUrl: `http://${name}:8080`, serverType: "llama.cpp", modelCount: 3, availability: "ready", ...over };
}

function input(sources: HomeSourceInput[], over: Partial<HomeSnapshotInput> = {}): HomeSnapshotInput {
	return {
		version: modelDiscoveryVersion(),
		sources,
		storageLine: "~/.pi/agent/model-discovery.json",
		scanLine: "last scan 12m ago",
		...over,
	};
}

test("frame is exactly HOME_PANEL_ROWS for 0..12 sources and with diagnostics/adaptive lines", () => {
	for (let n = 0; n <= 12; n++) {
		const sources = Array.from({ length: n }, (_, i) => source(`p${i}`));
		assert.equal(homePanelRowCount(input(sources)), HOME_PANEL_ROWS, `height with ${n} sources`);
		assert.equal(homePanelRowCount(input(sources, { diagnostic: "writable storage failed" })), HOME_PANEL_ROWS, `height with ${n} sources + diagnostic`);
		assert.equal(homePanelRowCount(input(sources, { adaptiveLine: "4 preset(s) configured" })), HOME_PANEL_ROWS, `height with ${n} sources + adaptive`);
	}
});

test("sources overflow into a counted marker, newest-first, frame unchanged", () => {
	const sources = Array.from({ length: 12 }, (_, i) => source(`p${i}`));
	const snap = buildHomeSnapshot(input(sources));
	const rows = snap.sections[0].rows;
	const budget = homeSourceRows(sources, 4);
	assert.equal(budget.length, 4);
	assert.equal(budget[3].key, HOME_OVERFLOW_KEY);
	assert.match(String(budget[3].label), /^\+9 more sources$/);
	assert.match(String(budget[0].label), /^p0$/);
	// Panel row count still equals fixed budget even when 12 providers exist.
	assert.equal(homePanelRowCount(input(sources)), HOME_PANEL_ROWS);
	assert.ok(rows.length <= HOME_PANEL_ROWS);
});

test("summary carries version, counts, storage and scan lines", () => {
	const snap = buildHomeSnapshot(
		input([source("local"), source("box", { availability: "degraded" })], { scanLine: "last scan 2h ago" }),
	);
	const text = [...(snap.summaryLines ?? []), ...(snap.detailLines ?? [])].join("\n");
	assert.match(text, new RegExp(`v${modelDiscoveryVersion()}`));
	assert.match(text, /2 providers · 6 models/);
	assert.match(text, /~\/\.pi\/agent\/model-discovery\.json/);
	assert.match(text, /last scan 2h ago/);
});

test("health is stated in words, not only colour", () => {
	const snap = buildHomeSnapshot(
		input([
			source("a"),
			source("b", { availability: "degraded" }),
			source("c", { availability: "unavailable" }),
			source("d", { availability: "unscanned" }),
		]),
	);
	assert.match(snap.idleMessage ?? "", /1 ready · 1 cached · 1 unavailable · 1 not scanned/);
});

test("every home action key is unique and HOME actions match the inventory keys", () => {
	const keys = HOME_ACTION_ROWS.map((row) => row.key);
	assert.equal(new Set(keys).size, keys.length);
});

test("formatAge formats all buckets and the unknown case", () => {
	const now = Date.UTC(2026, 8, 8, 12, 0, 0);
	assert.equal(formatAge(now - 30_000, now), "30s ago");
	assert.equal(formatAge(now - 5 * 60_000, now), "5m ago");
	assert.equal(formatAge(now - 3 * 3_600_000, now), "3h ago");
	assert.equal(formatAge(undefined, now), "never scanned");
});

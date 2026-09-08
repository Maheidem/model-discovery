/**
 * advanced-panel.test.ts — slice 4 contract: the advanced hub is a fixed
 * frame; sources window instead of growing; maintenance rows and the back
 * row are always present; pagination keys are the shared page:* keys.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ADVANCED_MAINTENANCE_ROWS, ADVANCED_PANEL_ROWS, buildAdvancedSnapshot } from "../ui/advanced-panel.ts";
import { BACK_KEY } from "../ui/endpoint-panel.ts";
import { modelDiscoveryVersion } from "../version.ts";

const src = (name: string, i = 0) => ({
	name,
	serverType: i % 2 ? "vLLM" : "oMLX",
	hasApiKey: i % 3 === 0,
	cachedCount: i * 2,
});

test("frame is fixed and mentions version, storage, and the secret policy", () => {
	const built = buildAdvancedSnapshot({
		version: modelDiscoveryVersion(),
		storagePath: "~/.pi/agent/model-discovery.json",
		sources: [src("local")],
	});
	const snap = built.snapshot as unknown as {
		title: string;
		summaryLines: string[];
		sections: { title: string; rows: unknown[] }[];
		detailLines?: string[];
	};
	assert.equal(snap.title, "Advanced configuration");
	const text = [...snap.summaryLines, ...(snap.detailLines ?? [])].join("\n");
	assert.match(text, new RegExp(`v${modelDiscoveryVersion()}`));
	assert.match(text, /~\/\.pi\/agent\/model-discovery\.json/);
	assert.match(text, /--key-from-env/);
	assert.equal(snap.sections[0].rows.length, ADVANCED_MAINTENANCE_ROWS.length);
	const keys = snap.sections[1].rows.map((r) => (r as { key: string }).key);
	assert.ok(keys.includes(BACK_KEY) || snap.sections.some((s) => s.rows.some((r) => (r as { key: string }).key === BACK_KEY)));
});

test("sources window with counted pagination instead of growing", () => {
	const many = Array.from({ length: 11 }, (_, i) => src(`s${i}`, i));
	const first = buildAdvancedSnapshot({ version: "0.0.0", storagePath: "~", sources: many, page: 0 });
	assert.ok(first.pages >= 2, "11 sources must paginate on a 23-row frame");
	const keys0 = first.snapshot.sections[1].rows.map((r) => r.key);
	assert.ok(keys0.some((k) => k === "page:next"), "more pages must offer page:next");
	assert.ok(!keys0.some((k) => k === "page:prev"), "page 0 has no page:prev");
	const last = buildAdvancedSnapshot({ version: "0.0.0", storagePath: "~", sources: many, page: first.pages - 1 });
	const keysL = last.snapshot.sections[1].rows.map((r) => r.key);
	assert.ok(keysL.includes("page:prev"), "last page offers page:prev");
	// Out-of-range pages clamp, never crash or render an empty lie.
	const clamped = buildAdvancedSnapshot({ version: "0.0.0", storagePath: "~", sources: many, page: 99 });
	assert.equal(clamped.page, first.pages - 1);
});

test("empty state tells the user what to do", () => {
	const built = buildAdvancedSnapshot({ version: "0.0.0", storagePath: "~", sources: [] });
	assert.match(built.snapshot.idleMessage ?? "", /no sources yet/);
	assert.equal(built.pages, 1);
});

/**
 * ui-parity.test.ts — slice 0 drift guard (`.planning/ui-alignment-2026-09-08` §11).
 *
 * One inventory (`tests/fixtures/discover-actions.ts`) is asserted to be the
 * single source joining panel row keys ⇄ nested `/discover` verbs ⇄
 * `DiscoveryApplication` methods, plus byte-identity of the vendored UI
 * primitives and the loaded-version provenance line.
 *
 * ZERO behavior change: nothing here imports `index.ts`, opens UI, touches the
 * network, or writes storage. The application is exercised against an
 * in-memory fake repository, and no fake ever writes.
 *
 * ---------------------------------------------------------------------------
 * CURRENT PENDING PANEL-KEY ALLOWLIST (slice 0 = all 23, nothing rendered yet)
 * ownership per `PENDING_PANEL_KEYS`; the allowlist reaching `{}` is the
 * done criterion for the alignment plan:
 *   S1 (home dashboard + tree + reports, PLAN §5):
 *     home, status, doctor, paths, help, source:<name>, source:add, presets, routing
 *   S2 (live scan strip + tool cards, PLAN §6):
 *     source:<name>:rescan
 *   S3 (config parity `cfg:` apply + destructive confirms, PLAN §7):
 *     source:remove, source:rename, source:credential, source:defaults,
 *     model:<id>:vision, model:<id>:contextWindow, model:<id>:maxTokens,
 *     preset:<slug>, preset:<slug>:<field>, preset:<slug>:remove,
 *     routing:<modelId>:level:<level>, routing:<modelId>:conventional,
 *     routing:<modelId>:remove
 * ---------------------------------------------------------------------------
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDiscoveryApplication, type DiscoveryApplication, type DiscoveryRepository } from "../application.ts";
import { modelDiscoveryVersion } from "../version.ts";
import { parseDiscoverArgs } from "../commands.ts";
import {
	DISCOVER_ACTIONS,
	IMPLEMENTED_PANEL_KEYS,
	INFO_ONLY_KEYS,
	PENDING_PANEL_KEYS,
} from "./fixtures/discover-actions.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Concrete substitutes for the `<placeholder>` tokens used in row verbs. */
const SAMPLES: Record<string, string> = {
	"<url>": "http://127.0.0.1:8112/v1",
	"<name>": "parity-source",
	"<id>": "qwen3-32b",
	"<slug>": "thinking",
	"<field>": "temperature",
	"<level>": "core",
	"<n>": "4096",
};

function instantiateApplication(): DiscoveryApplication {
	// In-memory fake that NEVER writes: the parity guard is about shape, not IO.
	const repository: DiscoveryRepository = {
		list: () => [],
		save: () => {},
		remove: () => {},
		rename: () => false,
	};
	return createDiscoveryApplication(repository);
}

function fill(verb: string): string {
	let text = verb;
	for (const [token, sample] of Object.entries(SAMPLES)) text = text.split(token).join(sample);
	return text;
}

test("inventory keys are unique and every row carries the canonical triple", () => {
	const keys = DISCOVER_ACTIONS.map((row) => row.key);
	assert.equal(new Set(keys).size, keys.length, "duplicate inventory key");
	for (const row of DISCOVER_ACTIONS) {
		assert.ok(row.key.length > 0, "empty inventory key");
		assert.ok("verb" in row && "appMethod" in row, `row ${row.key} must declare verb + appMethod`);
	}
});

test("every nested verb in the inventory parses through the real parser", () => {
	for (const row of DISCOVER_ACTIONS) {
		if (!row.verb) continue; // capability exists in TUI only — pending a nested verb
		const intent = parseDiscoverArgs(fill(row.verb));
		assert.notEqual(intent.kind, "invalid", `verb "${row.verb}" must parse (got ${JSON.stringify(intent)})`);
	}
	// The documented alias of `status` must keep working too (commands.ts:31).
	assert.equal(parseDiscoverArgs("source list").kind, "status");
	// Bare `/discover` is the home entry point (open), not a mutation.
	assert.equal(parseDiscoverArgs("").kind, "open");
});

test("every appMethod resolves to a live application function", () => {
	const app = instantiateApplication();
	const methods = Object.keys(app) as Array<keyof DiscoveryApplication>;
	for (const row of DISCOVER_ACTIONS) {
		if (!row.appMethod) {
			// Only the pure-text report rows may skip the application layer.
			assert.ok(
				INFO_ONLY_KEYS.includes(row.key),
				`row "${row.key}" has no application method but is not an INFO_ONLY key`,
			);
			continue;
		}
		assert.ok(
			methods.includes(row.appMethod as keyof DiscoveryApplication),
			`application.ts has no member "${row.appMethod}" (row "${row.key}")`,
		);
		assert.equal(
			typeof (app as unknown as Record<string, unknown>)[row.appMethod],
			"function",
			`application.${row.appMethod} is not a function`,
		);
	}
});

test("the inventory covers the whole DiscoveryApplication surface", () => {
	const app = instantiateApplication();
	const actual = Object.keys(app).sort();
	// Frozen snapshot: adding an application method without registering it in
	// the inventory fails here, which is the point (drift becomes loud).
	const snapshot = [
		"findSource",
		"listSources",
		"profileRouting",
		"profiles",
		"removeProfile",
		"removeRouting",
		"removeSource",
		"renameSource",
		"saveProfile",
		"saveRouting",
		"saveSource",
		"setCredential",
	];
	assert.deepEqual(actual, snapshot, "DiscoveryApplication surface changed — update inventory + snapshot together");
	const covered = new Set(DISCOVER_ACTIONS.map((row) => row.appMethod).filter(Boolean));
	for (const method of snapshot) {
		assert.ok(covered.has(method), `application method "${method}" is not in DISCOVER_ACTIONS`);
	}
});

test("every inventory key is an implemented panel row or a shrinking pending key", () => {
	const pendingKeys = Object.keys(PENDING_PANEL_KEYS).sort();
	const inventoryKeys = new Set(DISCOVER_ACTIONS.map((row) => row.key));

	// No overlap: a rendered row must leave the allowlist in the same commit.
	for (const key of IMPLEMENTED_PANEL_KEYS) {
		assert.ok(!pendingKeys.includes(key), `"${key}" is both implemented and pending`);
		assert.ok(inventoryKeys.has(key), `"${key}" is implemented but not in the inventory`);
	}
	// Every inventory key accounted for.
	for (const key of inventoryKeys) {
		assert.ok(
			inventoryKeys.has(key) && (IMPLEMENTED_PANEL_KEYS.includes(key) || key in PENDING_PANEL_KEYS),
			`"${key}" is neither an implemented panel row nor pending`,
		);
	}
	// No dead allowlist entries.
	for (const key of pendingKeys) {
		assert.ok(inventoryKeys.has(key), `pending key "${key}" is not in the inventory`);
		assert.ok(["S1", "S2", "S3"].includes(PENDING_PANEL_KEYS[key]), `pending key "${key}" lacks S1/S2/S3 ownership`);
	}
	// Shrink-only: the frozen slice-0 allowlist is the CEILING — any key that
	// is pending now but was not pending at slice 0 fails here. Keys leaving
	// the ceiling (into IMPLEMENTED_PANEL_KEYS) is the intended progress.
	const SLICE0_ALLOWLIST = new Set([
		"doctor",
		"help",
		"home",
		"model:<id>:contextWindow",
		"model:<id>:maxTokens",
		"model:<id>:vision",
		"paths",
		"preset:<slug>",
		"preset:<slug>:<field>",
		"preset:<slug>:remove",
		"presets",
		"routing",
		"routing:<modelId>:conventional",
		"routing:<modelId>:level:<level>",
		"routing:<modelId>:remove",
		"source:<name>",
		"source:<name>:rescan",
		"source:add",
		"source:credential",
		"source:defaults",
		"source:remove",
		"source:rename",
		"status",
	]);
	for (const key of pendingKeys) {
		assert.ok(SLICE0_ALLOWLIST.has(key), `allowlist grew beyond slice-0 ceiling: "${key}"`);
	}
	assert.ok(
		IMPLEMENTED_PANEL_KEYS.length + pendingKeys.length === inventoryKeys.size,
		"implemented + pending must equal the inventory size",
	);
});

test("vendored ui primitives are byte-identical to the canonical kit", () => {
	const kit = resolve(packageRoot, "../../skills/pi-extension-builder/assets/control-panel/extensions/ui");
	const files = ["settings-panel.ts", "panel-model.ts", "format.ts"];
	if (!existsSync(kit)) return; // published tarball: the kit is not shipped, nothing to compare
	const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
	for (const file of files) {
		const canonical = join(kit, file);
		const vendored = join(packageRoot, "ui", file);
		assert.ok(existsSync(vendored), `vendored copy missing: ui/${file}`);
		assert.equal(digest(vendored), digest(canonical), `ui/${file} drifted from the canonical kit source`);
	}
});

test("version provenance reads the real package.json version", () => {
	const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string };
	assert.equal(modelDiscoveryVersion(), pkg.version);
	assert.match(modelDiscoveryVersion(), /^\d+\.\d+\.\d+/);
});

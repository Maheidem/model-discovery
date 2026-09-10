/**
 * model-discovery tarball-integrity test — the shipped `files` allowlist must
 * cover every runtime module and every relative import must resolve inside it
 * (pattern: custom-extensions/delegate/tests/tarball.test.ts; born from
 * delegate's real 0.6.0 hotfix where a missing `files` entry shipped a package
 * that loaded nowhere while source-tree tests stayed green).
 */
import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files?: string[] };

function shippedFiles(): Set<string> {
	const set = new Set<string>();
	for (const entry of pkg.files ?? []) {
		const abs = path.join(ROOT, entry);
		if (entry.endsWith("/")) {
			if (!fs.existsSync(abs)) continue;
			for (const name of fs.readdirSync(abs)) {
				if (name.endsWith(".ts")) set.add(`${entry}${name}`);
			}
		} else {
			set.add(entry);
		}
	}
	return set;
}

test("tarball: every root runtime .ts module is in the files allowlist", () => {
	const shipped = shippedFiles();
	const present = fs.readdirSync(ROOT).filter((f) => f.endsWith(".ts") && !/\.test\.ts$|\.mts$/.test(f));
	const missing = present.filter((f) => !shipped.has(f));
	assert.deepEqual(missing, [], `root modules absent from package.json files: ${missing.join(", ")}`);
});

test("tarball: every relative ./xxx.ts import resolves inside the shipped set", () => {
	const shipped = shippedFiles();
	const unresolved: string[] = [];
	for (const entry of [...shipped]) {
		if (!entry.endsWith(".ts")) continue;
		const src = fs.readFileSync(path.join(ROOT, entry), "utf8");
		for (const match of src.matchAll(/from\s+["'](\.\/[^"']+\.ts)["']/g)) {
			const rel = match[1]!.slice("./".length);
			const dir = path.dirname(entry);
			const resolved = dir === "." ? rel : `${dir}/${rel}`;
			if (!shipped.has(resolved)) unresolved.push(`${entry} → ${match[1]}`);
		}
	}
	assert.deepEqual(unresolved, [], `imports that would break in the published tarball: ${unresolved.join("; ")}`);
});

test("tarball: the shipped entry point exists", () => {
	const shipped = shippedFiles();
	assert.ok(shipped.has("index.ts"), "index.ts must ship");
	assert.ok(fs.existsSync(path.join(ROOT, "index.ts")));
});

/**
 * model-discovery test runner.
 *
 * Runs every `*.test.ts` in a clean child process (`node --test`) with a
 * throwaway `$HOME`, sequentially (`--test-concurrency=1`) because the suite
 * shares the storage path derived from `$HOME`. Exit code reflects failures.
 *
 * Discovery covers BOTH locations on purpose (slice 0 audit):
 *   - `<package root>/*.test.ts`  — the historical flat suite, kept in its
 *     original explicit order (cheap-first, `index.test.ts` last);
 *   - `tests/*.test.ts`           — the newer location (`ui-parity.test.ts`);
 *     `tests/fixtures/**` holds shared data and is never executed as a test.
 *
 * Extra CLI arguments are passed through as `--test-name-pattern` filters.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testsDir = join(root, "tests");

// Env guard: inherited delegate-child environment variables must never leak
// into these runs (same hygiene as custom-extensions/delegate/tests/run.mjs).
for (const key of ["PI_DELEGATE_CHILD", "PI_DELEGATE_RUN_ID", "PI_DELEGATE_PARENT_PID"]) delete process.env[key];

function discover(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => entry.name)
    .sort();
}

// Historical order for the root suite; any additional root test is appended.
const preferredRootOrder = [
  "profiles.test.ts",
  "enrichment.test.ts",
  "offline.test.ts",
  "schema-repair.test.ts",
  "application.test.ts",
  "commands.test.ts",
  "storage.test.ts",
  "ui-model.test.ts",
  "wizard-shell.test.ts",
  "index.test.ts",
];

const rootTests = discover(root);
const files = [];
for (const file of preferredRootOrder) if (rootTests.includes(file)) files.push(join(root, file));
for (const file of rootTests) if (!preferredRootOrder.includes(file)) files.push(join(root, file));
for (const file of discover(testsDir)) files.push(join(testsDir, file));

if (!files.length) {
  console.error("no tests found");
  process.exit(1);
}

const filters = process.argv.slice(2);

for (const file of files) {
  const sandbox = mkdtempSync(join(tmpdir(), "model-discovery-test-"));
  const home = join(sandbox, "home");
  const env = { ...process.env, HOME: home };
  delete env.NODE_TEST_CONTEXT;
  try {
    const args = ["--experimental-strip-types", "--test", "--test-concurrency=1"];
    for (const filter of filters) args.push("--test-name-pattern", filter);
    args.push(relative(root, file));
    const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

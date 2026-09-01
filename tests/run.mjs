import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = [
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

for (const file of files) {
  const sandbox = mkdtempSync(join(tmpdir(), "model-discovery-test-"));
  const home = join(sandbox, "home");
  const env = { ...process.env, HOME: home };
  delete env.NODE_TEST_CONTEXT;
  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--test", "--test-concurrency=1", file],
      { cwd: root, env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

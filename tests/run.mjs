#!/usr/bin/env node
// Canonical test runner of the pi extension standard. Keep this file identical in every repo.
// It runs each tests/**/*.test.* file in its own child: isolated HOME, allowlisted env, outer timeout.
import { runTests } from "@maheidem/pi-panel-kit/testing";

process.exitCode = runTests({ root: new URL("..", import.meta.url) });

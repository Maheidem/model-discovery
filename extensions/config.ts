/**
 * model-discovery — the config file path.
 *
 * The file is `<agent dir>/model-discovery.json` (normally
 * `~/.pi/agent/model-discovery.json`). `getAgentDir()` gives the agent dir,
 * so the path follows `PI_CODING_AGENT_DIR` when that variable is set.
 * `storage.ts` reads and writes the file; it exports the same path as
 * `STORAGE_PATH`.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export const CONFIG_PATH = join(getAgentDir(), "model-discovery.json");

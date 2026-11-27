// omlx.mjs <config path> <source> status | unload <id> | load <id>
//
// Show or change the load state of one oMLX source.
// The API key comes from the config file. The script never prints it.
// `unload` refuses when the server has active or waiting requests.
// An id is the model id that pi shows: the alias when the model has one, else the server id.
// `status` prints the loaded models with these ids.
// Exit code: 0 = done, 1 = refused or failed, 2 = wrong arguments.
import fs from "node:fs";

const [configPath, sourceName, op, id] = process.argv.slice(2);
if (!configPath || !sourceName || !["status", "unload", "load"].includes(op) || (op !== "status" && !id)) {
	console.error("usage: omlx.mjs <config path> <source> status | unload <id> | load <id>");
	process.exit(2);
}
const source = JSON.parse(fs.readFileSync(configPath, "utf8")).find((entry) => entry.name === sourceName);
if (!source) {
	console.error(`omlx.mjs: the config has no source "${sourceName}"`);
	process.exit(2);
}
const base = String(source.baseUrl).replace(/\/+$/, "");
const headers = { "content-type": "application/json" };
if (source.apiKey) headers.Authorization = "Bearer " + source.apiKey;
const safe = (text) => (source.apiKey ? String(text).split(source.apiKey).join("***") : String(text));

async function getJson(path) {
	const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
	return response.json();
}

/** The request counts, and each model of the server with its server id, its pi id and its load state. */
async function status() {
	const [api, models] = await Promise.all([getJson("/api/status"), getJson("/v1/models/status")]);
	const entries = (Array.isArray(models.models) ? models.models : []).map((entry) => ({
		serverId: String(entry.id),
		piId: String(entry.model_alias || entry.id),
		loaded: entry.loaded === true,
	}));
	return { active: api.active_requests, waiting: api.waiting_requests, entries };
}

try {
	if (op !== "status") {
		const before = await status();
		if (op === "unload" && (before.active || before.waiting)) {
			console.log("refuse: requests are active", before.active, before.waiting);
			process.exit(1);
		}
		const entry = before.entries.find((item) => item.piId === id || item.serverId === id);
		if (!entry) throw new Error(`the server has no model "${id}"`);
		const response = await fetch(`${base}/v1/models/${encodeURIComponent(entry.serverId)}/${op}`, {
			method: "POST",
			headers,
			signal: AbortSignal.timeout(180_000),
		});
		console.log(op, id, response.status, safe((await response.text()).slice(0, 160)));
		if (!response.ok) process.exit(1);
	}
	const now = await status();
	const loaded = now.entries.filter((item) => item.loaded).map((item) => item.piId);
	console.log("active:", now.active, "waiting:", now.waiting, "loaded:", JSON.stringify(loaded));
} catch (error) {
	console.error(`omlx.mjs: ${sourceName} ${op} failed: ${safe(error?.message ?? error)}`);
	process.exit(1);
}

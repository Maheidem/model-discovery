// m3.mjs status | unload <id> | load <id> : load state of mac-m3 (the key comes from the config, it is not printed)
import fs from "fs";
const c = JSON.parse(fs.readFileSync(process.env.HOME + "/.pi/agent/model-discovery.json", "utf8")).find((p) => p.name === "mac-m3");
const h = { Authorization: "Bearer " + c.apiKey, "content-type": "application/json" };
const [op, id] = process.argv.slice(2);
const get = async (p) => (await fetch(c.baseUrl + p, { headers: h, signal: AbortSignal.timeout(15000) })).json();
if (op === "unload" || op === "load") {
  const s = await get("/api/status");
  if (op === "unload" && (s.active_requests || s.waiting_requests)) { console.log("refuse: requests are active", s.active_requests, s.waiting_requests); process.exit(1); }
  const r = await fetch(`${c.baseUrl}/v1/models/${encodeURIComponent(id)}/${op}`, { method: "POST", headers: h, signal: AbortSignal.timeout(180000) });
  console.log(op, id, r.status, (await r.text()).slice(0, 160));
}
const s = await get("/api/status");
console.log("active:", s.active_requests, "waiting:", s.waiting_requests, "loaded:", JSON.stringify(s.loaded_models));

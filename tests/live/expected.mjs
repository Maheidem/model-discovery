// expected.mjs <config path> <source> <model id> <output path>
//
// Write the expected values of one matrix row to a JSON file.
// The script reads the source from the config copy. It asks the live server for its report
// (read-only GET requests). It gives the report and the bundled family files to the code of
// the extension, in the same way as `registerProvider` in extensions/index.ts.
// Run it with: node --experimental-strip-types expected.mjs ...
// The script never prints and never writes an API key.
import fs from "node:fs";
import { loadBundledFamilies } from "../../extensions/family-store.ts";
import { resolveModel, thinkingTransportForServer } from "../../extensions/model-plan.ts";
import { repetitionPenaltyKeyForServer, THINKING_LEVELS } from "../../extensions/profiles.ts";
import { extractModelConfig, fetchModels, redactSecret } from "../../extensions/providers.ts";

const [configPath, sourceName, modelId, outPath] = process.argv.slice(2);
if (!configPath || !sourceName || !modelId || !outPath) {
	console.error("usage: expected.mjs <config path> <source> <model id> <output path>");
	process.exit(2);
}

function fail(message) {
	console.error(`expected.mjs: ${message}`);
	process.exit(1);
}

const sources = JSON.parse(fs.readFileSync(configPath, "utf8"));
const source = sources.find((entry) => entry.name === sourceName);
if (!source) fail(`the config has no source "${sourceName}"`);

// `fetchModels` also calls `enrichModels`. The result is the catalogue that `registerProvider` gets.
let live;
try {
	live = await fetchModels(source.baseUrl, source.apiKey, AbortSignal.timeout(15_000));
} catch (error) {
	fail(`"${sourceName}" does not answer: ${redactSecret(String(error?.message ?? error), source.apiKey)}`);
}
const { models, serverType } = live;
const config = models.map(extractModelConfig).find((entry) => entry.id === modelId);
if (!config) fail(`"${sourceName}" does not list the model "${modelId}"`);

const registry = loadBundledFamilies();
if (registry.rejected.length > 0) fail(`a bundled family file is not valid: ${JSON.stringify(registry.rejected)}`);
const resolved = resolveModel(source, config, registry, serverType, {
	repetitionPenaltyKey: repetitionPenaltyKeyForServer(serverType),
});

// pi offers "off" and each level whose `thinkingLevelMap` value is not null.
// A model with reasoning off has no level control in pi.
const levelMap = resolved.baseThinkingLevelMap;
const offered = resolved.reasoning && levelMap ? THINKING_LEVELS.filter((level) => levelMap[level] !== null) : ["off"];

const expected = {
	source: sourceName,
	model: modelId,
	serverType,
	thinkingTransport: thinkingTransportForServer(registry, serverType),
	familyRevision: registry.index.revision,
	kind: resolved.kind,
	hidden: resolved.hidden,
	familyId: resolved.family?.id ?? null,
	familyLabel: resolved.family?.label ?? null,
	familySource: resolved.familySource,
	thinking: resolved.thinking ?? null,
	thinkingSource: resolved.thinking?.source ?? null,
	reasoning: resolved.reasoning,
	reasoningSource: resolved.reasoningSource,
	vision: resolved.vision,
	visionSource: resolved.visionSource,
	defaultsOn: resolved.defaultsOn,
	thinkingLevelMap: levelMap ?? null,
	offeredLevels: offered,
	baseLevelParams: resolved.baseLevelParams ?? null,
	presets: resolved.defaults?.presets ?? null,
	routing: resolved.defaults?.routing ?? null,
	levelSlugs: resolved.defaults?.levelSlugs ?? null,
};

const text = JSON.stringify(expected, null, 2) + "\n";
if (source.apiKey && text.includes(source.apiKey)) fail("the result contains the API key; no file was written");
fs.writeFileSync(outPath, text);
console.log(
	`expected: ${sourceName}/${modelId} family=${expected.familyId ?? "none"} thinking=${expected.thinkingSource ?? "none"} levels=${offered.join(",")}`,
);

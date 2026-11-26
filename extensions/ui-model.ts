import type { SelectItem } from "@earendil-works/pi-tui";
import { redactSecret } from "./providers.ts";
import { STORAGE_PATH, getStorageDiagnostic, type DiscoveredProvider } from "./storage.ts";

export type SourceAvailability = "ready" | "degraded" | "unavailable" | "unscanned";

export interface DiscoverySummary {
	sourceCount: number;
	modelCount: number;
	readyCount: number;
	degradedCount: number;
	unavailableCount: number;
	unscannedCount: number;
}

export function homeRelativePath(path: string, home = process.env.HOME): string {
	if (!home) return path;
	return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function sourceAvailability(provider: DiscoveredProvider): SourceAvailability {
	if (provider.lastScanError) return provider.cachedModels?.length ? "degraded" : "unavailable";
	if (provider.lastScanned) return "ready";
	return "unscanned";
}

export function summarizeSources(providers: readonly DiscoveredProvider[]): DiscoverySummary {
	const summary: DiscoverySummary = {
		sourceCount: providers.length,
		modelCount: 0,
		readyCount: 0,
		degradedCount: 0,
		unavailableCount: 0,
		unscannedCount: 0,
	};
	for (const provider of providers) {
		summary.modelCount += provider.cachedModels?.length ?? 0;
		summary[`${sourceAvailability(provider)}Count`]++;
	}
	return summary;
}

export function buildHomeSummary(providers: readonly DiscoveredProvider[]): string[] {
	const summary = summarizeSources(providers);
	if (!summary.sourceCount) {
		return ["No sources configured", "Add a source to discover models from a local OpenAI-compatible endpoint."];
	}
	const health: string[] = [];
	if (summary.readyCount) health.push(`${summary.readyCount} ready`);
	if (summary.degradedCount) health.push(`${summary.degradedCount} cached`);
	if (summary.unavailableCount) health.push(`${summary.unavailableCount} unavailable`);
	if (summary.unscannedCount) health.push(`${summary.unscannedCount} not scanned`);
	return [
		`${summary.sourceCount} source${summary.sourceCount === 1 ? "" : "s"} · ${summary.modelCount} cached model${summary.modelCount === 1 ? "" : "s"}`,
		health.join(" · "),
	];
}

export function buildHomeItems(providers: readonly DiscoveredProvider[]): SelectItem[] {
	const sourceItems = providers.map((provider) => {
		const availability = sourceAvailability(provider);
		const modelCount = provider.cachedModels?.length ?? 0;
		return {
			value: `provider:${provider.name}`,
			label: provider.name,
			description: `${availability} · ${provider.serverType ?? "unknown server"} · ${modelCount} model${modelCount === 1 ? "" : "s"} · ${provider.baseUrl}`,
		};
	});
	return [
		...sourceItems,
		{ value: "add", label: "Add source", description: "Discover models from an OpenAI-compatible endpoint" },
		...(providers.length
			? [{ value: "rescan-all", label: "Re-scan all sources", description: "Refresh every catalogue; cached models remain on failure" }]
			: []),
		{ value: "diagnostics", label: "Diagnostics", description: "Inspect storage, health, and cached models" },
		{ value: "quit", label: "Close" },
	];
}

function sourceStatusLine(provider: DiscoveredProvider): string {
	const status = sourceAvailability(provider);
	const modelCount = provider.cachedModels?.length ?? 0;
	return `- ${provider.name}: ${status} · ${provider.serverType ?? "unknown"} · ${modelCount} model${modelCount === 1 ? "" : "s"} · ${provider.baseUrl}`;
}

export function formatDiscoveryStatus(
	providers: readonly DiscoveredProvider[],
	options: { storagePath?: string; home?: string } = {},
): string {
	const summary = summarizeSources(providers);
	const path = homeRelativePath(options.storagePath ?? STORAGE_PATH, options.home ?? process.env.HOME);
	const lines = [
		"Model Discovery",
		`Sources: ${summary.sourceCount}`,
		`Cached models: ${summary.modelCount}`,
		`Health: ${summary.readyCount} ready, ${summary.degradedCount} cached/degraded, ${summary.unavailableCount} unavailable, ${summary.unscannedCount} not scanned`,
		`Storage: ${path}`,
	];
	if (providers.length) lines.push(...providers.map(sourceStatusLine));
	else lines.push("No sources configured. In TUI mode, run /discover and choose Add source.");
	const diagnostic = getStorageDiagnostic();
	if (diagnostic) lines.push(`Warning: ${diagnostic.message}`);
	return lines.join("\n");
}

export function buildDiagnosticsLines(providers: readonly DiscoveredProvider[]): string[] {
	const summary = summarizeSources(providers);
	const lines = [
		`Configuration: ${homeRelativePath(STORAGE_PATH)}`,
		`Sources: ${summary.sourceCount} · cached models: ${summary.modelCount}`,
		`Health: ${summary.readyCount} ready · ${summary.degradedCount} cached/degraded · ${summary.unavailableCount} unavailable · ${summary.unscannedCount} not scanned`,
	];
	const diagnostic = getStorageDiagnostic();
	if (diagnostic) lines.push(`Warning: ${diagnostic.message}`);
	if (!providers.length) {
		lines.push("", "No sources configured.");
		return lines;
	}
	lines.push("", "Configured sources");
	for (const provider of providers) {
		lines.push(sourceStatusLine(provider));
		lines.push(`  authentication: ${provider.apiKey ? "API key configured" : "anonymous"}`);
		if (provider.lastScanned) lines.push(`  last successful scan: ${new Date(provider.lastScanned).toLocaleString()}`);
		if (provider.lastScanError) lines.push(`  latest error: ${redactSecret(provider.lastScanError, provider.apiKey)}`);
	}
	return lines;
}

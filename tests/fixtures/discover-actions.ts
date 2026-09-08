/**
 * DISCOVER_ACTIONS — the single action inventory for model-discovery.
 *
 * Slice 0 of `.planning/ui-alignment-2026-09-08`. One table joins the three
 * surfaces that must never drift again:
 *
 *   panel row key  ⇄  nested `/discover` verb  ⇄  `DiscoveryApplication` method
 *
 * Every row is seeded from REALITY as it exists on disk today — nothing
 * aspirational:
 *   - `verb` is the argument string `parseDiscoverArgs()` (`commands.ts`)
 *     accepts TODAY (`""` = no nested verb exists yet for that capability).
 *   - `appMethod` is a member of the `DiscoveryApplication` interface
 *     (`application.ts`), verified at runtime by `tests/ui-parity.test.ts`
 *     with `typeof === "function"` against a live instance.
 *     The sentinel `""` is allowed ONLY for the two pure-text report rows
 *     (`paths`, `help`) whose real source is `STORAGE_PATH` / `DISCOVER_USAGE`,
 *     not the application layer — the parity test enforces that exception
 *     against `INFO_ONLY_KEYS`.
 *
 * Row-key grammar (canonical, forward-compatible with PLAN §7):
 *   `source:<name>` / `model:<id>:<field>` / `preset:<modelId>:<slug>[:<field>]` /
 *   `routing:<modelId>:<part>` are PATTERNS; `<…>` is substituted at render.
 *   (Storage reality: `provider.modelProfiles[modelId][]` — the model scope is
 *   part of the preset identity; renamed in slice 1b.)
 *
 * Planned verbs (land in slice 3, `cfg:<scope>:<field>` generic apply — today
 * these capabilities are TUI-wizard-only, which is exactly the drift §3/§9 of
 * the map records):
 *   source:rename      → `/discover source rename <old> <new>`
 *   source:credential  → `/discover source auth <name> [--key-from-env ENV]`
 *   source:defaults    → `/discover source defaults <name> ctx <n>` / `max <n>`
 *   model:<id>:vision  → `/discover model <id> vision on|off`
 *   preset:<slug>:<f>  → `/discover preset set <slug> <field> <value>`
 *   routing:*          → `/discover routing <modelId> <lvl> <slug>`
 *
 * `IMPLEMENTED_PANEL_KEYS` is empty because the bare `/discover` home is
 * still a `WizardSelect` list (`ui-model.ts:56`), not a panel: nothing on
 * disk renders a `PanelRow` yet. `PENDING_PANEL_KEYS` is therefore the whole
 * inventory at slice 0, and it shrinking to `{}` IS the done criterion.
 */

export type SliceOwnership = "S1" | "S2" | "S3";

export interface DiscoverAction {
	/** Canonical panel row key (pattern keys carry `<placeholders>`). */
	key: string;
	/** Nested `/discover` argument form accepted TODAY; `""` = no verb yet. */
	verb: string;
	/** `DiscoveryApplication` member reached; `""` only for info-only rows. */
	appMethod: string;
}

/** Keys whose row is a report/info surface with no application method. */
export const INFO_ONLY_KEYS: readonly string[] = ["paths", "help"];

export const DISCOVER_ACTIONS: readonly DiscoverAction[] = [
	// --- Navigation + reports (reality: commands.ts:29-40, index.ts:1938-1963) ---
	{ key: "home", verb: "", appMethod: "listSources" },
	{ key: "status", verb: "status", appMethod: "listSources" },
	{ key: "doctor", verb: "doctor", appMethod: "listSources" },
	{ key: "paths", verb: "paths", appMethod: "" },
	{ key: "help", verb: "help", appMethod: "" },

	// --- Sources (add/remove dual-pathed today; rename/auth/defaults TUI-only) ---
	{ key: "source:<name>", verb: "source open <name>", appMethod: "findSource" },
	{ key: "source:add", verb: "source add <url>", appMethod: "saveSource" },
	{ key: "source:remove", verb: "source remove <name> --yes", appMethod: "removeSource" },
	{ key: "source:rename", verb: "source rename <name> <new>", appMethod: "renameSource" },
	{ key: "source:credential", verb: "source auth <name> --key-from-env API_KEY", appMethod: "setCredential" },
	{ key: "source:defaults", verb: "source defaults <name> ctx <n>", appMethod: "saveSource" },
	{ key: "source:<name>:rescan", verb: "source rescan <name>", appMethod: "saveSource" },

	// --- Per-model overrides (index.ts:1328/1369/1616 mutation paths) ---
	{ key: "model:<id>:vision", verb: "model <id> vision on", appMethod: "saveSource" },
	{ key: "model:<id>:contextWindow", verb: "model <id> ctx <n>", appMethod: "saveSource" },
	{ key: "model:<id>:maxTokens", verb: "model <id> max <n>", appMethod: "saveSource" },

	// --- Presets CRUD (index.ts:1103/1243/1262) ---
	{ key: "presets", verb: "", appMethod: "profiles" },
	{ key: "preset:<modelId>:<slug>", verb: "", appMethod: "saveProfile" },
	{ key: "preset:<modelId>:<slug>:<field>", verb: "preset set <name> <modelId> <slug> <field> <n>", appMethod: "saveProfile" },
	{ key: "preset:<modelId>:<slug>:remove", verb: "preset remove <name> <modelId> <slug> --yes", appMethod: "removeProfile" },

	// --- Adaptive routing (index.ts:994/1164/1165) ---
	{ key: "routing", verb: "", appMethod: "profileRouting" },
	{ key: "routing:<modelId>:level:<level>", verb: "routing set <name> <modelId> <level> <slug>", appMethod: "saveRouting" },
	{ key: "routing:<modelId>:conventional", verb: "routing conventional <name> <modelId>", appMethod: "saveRouting" },
	{ key: "routing:<modelId>:remove", verb: "routing remove <name> <modelId> --yes", appMethod: "removeRouting" },
];

/**
 * Panel row keys rendered TODAY (slice 1b landed): the wizard is retired and
 * every inventory key is a live `PanelRow` on the panel-native screens
 * (`ui/home.ts`, `ui/endpoint-panel.ts`, `ui/add-panel.ts`). `PENDING_PANEL_KEYS`
 * is `{}` — the alignment done-criterion (parity contract §done) is met.
 */
export const IMPLEMENTED_PANEL_KEYS: readonly string[] = [
	"home",
	"status",
	"doctor",
	"paths",
	"help",
	"presets",
	"routing",
	"source:<name>",
	"source:add",
	"source:remove",
	"source:rename",
	"source:credential",
	"source:defaults",
	"source:<name>:rescan",
	"model:<id>:vision",
	"model:<id>:contextWindow",
	"model:<id>:maxTokens",
	"preset:<modelId>:<slug>",
	"preset:<modelId>:<slug>:<field>",
	"preset:<modelId>:<slug>:remove",
	"routing:<modelId>:level:<level>",
	"routing:<modelId>:conventional",
	"routing:<modelId>:remove",
];

/**
 * Pending allowlist: inventory key → slice that lands the panel row.
 * Monotone: a key may only LEAVE this table, never enter it without a
 * matching panel row in `IMPLEMENTED_PANEL_KEYS`.
 *
 *   S1 = home dashboard + tree/browse + reports (panel anatomy, PLAN §5)
 *   S2 = live scan strip + tool cards (PLAN §6)
 *   S3 = config parity: cfg: apply, overrides, presets, routing, destructive
 *        arm-then-confirm (PLAN §7)
 */
export const PENDING_PANEL_KEYS: Readonly<Record<string, SliceOwnership>> = {};

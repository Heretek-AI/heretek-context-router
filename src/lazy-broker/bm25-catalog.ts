/**
 * bm25-catalog.ts — In-memory Okapi BM25 tool catalog for the lazy broker.
 *
 * Pure-TypeScript implementation (Map + inverted index) so `bun test` runs
 * deterministically with no native dependencies. Stores backend MCP tool
 * definitions and ranks them with:
 *
 *   Score = TriggerMatch * 3.0 + BM25 * 1.0 + KeywordBoost * 2.0
 *
 * - TriggerMatch: number of query terms that hit the tool's own name
 *   (exact token or substring of the normalized name).
 * - BM25: standard Okapi BM25 (k1 = 1.2, b = 0.75) over the tool corpus
 *   text (name tokens + description + boost keywords).
 * - KeywordBoost: number of boost keywords matching a query term
 *   (exact or substring, either direction, case-insensitive).
 */

export type BrokerProfile = "core" | "appsec" | "android" | "game" | "research";

export const ALL_BROKER_PROFILES: readonly BrokerProfile[] = [
  "core",
  "appsec",
  "android",
  "game",
  "research",
] as const;

export function assertValidBrokerProfile(
  profile: string,
): asserts profile is BrokerProfile {
  if (!(ALL_BROKER_PROFILES as readonly string[]).includes(profile)) {
    throw new Error(
      `Unknown toolbox profile "${profile}". Expected one of: ${ALL_BROKER_PROFILES.join(", ")}.`,
    );
  }
}

export interface BackendToolDef {
  server: string;
  profile: BrokerProfile;
  name: string;
  description: string;
  boostKeywords: string[];
  inputSchemaJson: string;
  /** True when invoking the tool mutates external state (used by the auth gate). */
  mutating: boolean;
}

export interface CatalogSearchOptions {
  profile?: BrokerProfile | string;
  limit?: number;
}

export interface RankedTool {
  name: string;
  profile: BrokerProfile;
  server: string;
  summary: string;
  score: number;
}

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const TRIGGER_WEIGHT = 3.0;
export const BM25_WEIGHT = 1.0;
export const KEYWORD_WEIGHT = 2.0;
export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 25;

/** Lowercase alphanumeric tokenization. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Normalized tool-name token set: splits on `_`, `-`, `.`, `/`, `:` as well. */
function nameTokens(name: string): string[] {
  return tokenize(name.replace(/[_.\-/:]+/g, " "));
}

/** Corpus text indexed per tool: name tokens + description + boost keywords. */
function corpusText(def: BackendToolDef): string {
  return [def.name.replace(/[_.\-/:]+/g, " "), def.description, def.boostKeywords.join(" ")].join(
    "\n",
  );
}

interface DocStats {
  def: BackendToolDef;
  terms: Map<string, number>;
  length: number;
}

function buildSchema(properties: Record<string, { type: string; description: string }>, required: string[]): string {
  return JSON.stringify({
    type: "object",
    properties,
    required,
  });
}

function def(
  server: string,
  profile: BrokerProfile,
  name: string,
  description: string,
  boostKeywords: string[],
  inputSchemaJson: string,
  mutating: boolean,
): BackendToolDef {
  if (name.length === 0) {
    throw new Error("Backend tool name must be non-empty. Failing closed.");
  }
  if (description.length === 0) {
    throw new Error(`Backend tool "${name}" must carry a one-line description. Failing closed.`);
  }
  return { server, profile, name, description, boostKeywords, inputSchemaJson, mutating };
}

/**
 * Seed definitions: 34 domain tools across the 5 Heretek Compose profiles,
 * covering ghidra-mcp, radare2-mcp, morluto/rea, iksnerd/adb-mcp, maestro,
 * godot-mcp, blender-mcp, crawl4ai, searxng, and computer-use-linux.
 */
export function buildSeedToolDefinitions(): BackendToolDef[] {
  return [
    // ---- core (6, server heretek-core) ----
    def(
      "heretek-core", "core", "core__fs_read",
      "Read a workspace-relative file and return its text contents.",
      ["file", "read", "filesystem", "cat"],
      buildSchema({ path: { type: "string", description: "Workspace-relative file path." } }, ["path"]),
      false,
    ),
    def(
      "heretek-core", "core", "core__fs_write",
      "Write text contents to a workspace-relative file path.",
      ["file", "write", "filesystem", "save"],
      buildSchema(
        {
          path: { type: "string", description: "Workspace-relative file path." },
          contents: { type: "string", description: "Text to write." },
        },
        ["path", "contents"],
      ),
      true,
    ),
    def(
      "heretek-core", "core", "core__shell_exec",
      "Execute a shell command in the workspace and capture output.",
      ["shell", "exec", "bash", "command"],
      buildSchema({ command: { type: "string", description: "Shell command to run." } }, ["command"]),
      true,
    ),
    def(
      "heretek-core", "core", "core__git_status",
      "Report git working-tree status and current branch.",
      ["git", "status", "branch", "vcs"],
      buildSchema({}, []),
      false,
    ),
    def(
      "heretek-core", "core", "core__process_list",
      "List running OS processes with pid and command line.",
      ["process", "ps", "tasks", "inspect"],
      buildSchema({}, []),
      false,
    ),
    def(
      "heretek-core", "core", "core__env_inspect",
      "Inspect allow-listed environment variables for debugging.",
      ["env", "environment", "config", "inspect"],
      buildSchema(
        { names: { type: "string", description: "Comma-separated variable names." } },
        ["names"],
      ),
      false,
    ),
    // ---- appsec (8) ----
    def(
      "ghidra-mcp", "appsec", "ghidra__analyze_binary",
      "Analyze a binary with Ghidra headless and list discovered functions.",
      ["ghidra", "binary", "analyze", "reverse", "firmware"],
      buildSchema({ path: { type: "string", description: "Binary file path." } }, ["path"]),
      false,
    ),
    def(
      "ghidra-mcp", "appsec", "ghidra__list_functions",
      "List functions discovered by Ghidra in the loaded program.",
      ["ghidra", "functions", "symbols", "reverse"],
      buildSchema({ program: { type: "string", description: "Loaded program name." } }, ["program"]),
      false,
    ),
    def(
      "ghidra-mcp", "appsec", "ghidra__decompile_function",
      "Decompile a single Ghidra function to C-like pseudocode.",
      ["ghidra", "decompile", "function", "pseudocode", "reverse"],
      buildSchema(
        {
          program: { type: "string", description: "Loaded program name." },
          function: { type: "string", description: "Function name or address." },
        },
        ["program", "function"],
      ),
      false,
    ),
    def(
      "radare2-mcp", "appsec", "radare2__disassemble",
      "Disassemble bytes at an offset with radare2 and return mnemonics.",
      ["radare2", "r2", "disassemble", "asm", "reverse"],
      buildSchema(
        {
          path: { type: "string", description: "Binary file path." },
          offset: { type: "string", description: "Hex offset, e.g. 0x1000." },
        },
        ["path", "offset"],
      ),
      false,
    ),
    def(
      "radare2-mcp", "appsec", "radare2__strings",
      "Extract printable strings from a binary via radare2.",
      ["radare2", "r2", "strings", "iocs", "triage"],
      buildSchema({ path: { type: "string", description: "Binary file path." } }, ["path"]),
      false,
    ),
    def(
      "morluto/rea", "appsec", "rea__scan",
      "Scan a binary with the REA engine for capabilities and behaviors.",
      ["rea", "scan", "capabilities", "malware", "triage"],
      buildSchema({ path: { type: "string", description: "Binary file path." } }, ["path"]),
      false,
    ),
    def(
      "morluto/rea", "appsec", "rea__report",
      "Render a capability report for a previous REA scan id.",
      ["rea", "report", "capabilities", "malware"],
      buildSchema({ scanId: { type: "string", description: "Scan identifier." } }, ["scanId"]),
      false,
    ),
    def(
      "ghidra-mcp", "appsec", "ghidra__xrefs_to",
      "List cross-references to a symbol or address in Ghidra.",
      ["ghidra", "xrefs", "references", "reverse"],
      buildSchema(
        {
          program: { type: "string", description: "Loaded program name." },
          symbol: { type: "string", description: "Symbol name or address." },
        },
        ["program", "symbol"],
      ),
      false,
    ),
    // ---- android (7) ----
    def(
      "iksnerd/adb-mcp", "android", "adb__devices",
      "List connected Android devices via adb.",
      ["android", "adb", "devices", "emulator"],
      buildSchema({}, []),
      false,
    ),
    def(
      "iksnerd/adb-mcp", "android", "adb__install",
      "Install an APK onto the selected Android device.",
      ["android", "adb", "install", "apk", "deploy"],
      buildSchema(
        {
          apk: { type: "string", description: "APK file path." },
          serial: { type: "string", description: "Device serial." },
        },
        ["apk", "serial"],
      ),
      true,
    ),
    def(
      "iksnerd/adb-mcp", "android", "adb__logcat",
      "Capture logcat output from an Android device with a filter.",
      ["android", "adb", "logcat", "logs", "debug"],
      buildSchema({ serial: { type: "string", description: "Device serial." } }, ["serial"]),
      false,
    ),
    def(
      "iksnerd/adb-mcp", "android", "adb__shell",
      "Run a shell command on the Android device via adb shell.",
      ["android", "adb", "shell", "device", "command"],
      buildSchema(
        {
          serial: { type: "string", description: "Device serial." },
          command: { type: "string", description: "Command to run on device." },
        },
        ["serial", "command"],
      ),
      true,
    ),
    def(
      "maestro", "android", "maestro__test",
      "Run a Maestro UI flow file against the connected device.",
      ["android", "maestro", "test", "ui", "flow", "e2e"],
      buildSchema({ flow: { type: "string", description: "Maestro flow YAML path." } }, ["flow"]),
      true,
    ),
    def(
      "maestro", "android", "maestro__flow_run",
      "Execute a named Maestro flow with tags on a device serial.",
      ["android", "maestro", "flow", "run", "e2e"],
      buildSchema(
        {
          flow: { type: "string", description: "Flow name." },
          serial: { type: "string", description: "Device serial." },
        },
        ["flow", "serial"],
      ),
      true,
    ),
    def(
      "iksnerd/adb-mcp", "android", "adb__screenshot",
      "Capture a screenshot from the Android device.",
      ["android", "adb", "screenshot", "screen", "capture"],
      buildSchema({ serial: { type: "string", description: "Device serial." } }, ["serial"]),
      false,
    ),
    // ---- game (7) ----
    def(
      "godot-mcp", "game", "godot__scene_tree",
      "Dump the running Godot scene tree for inspection.",
      ["godot", "scene", "tree", "nodes", "debug"],
      buildSchema({ project: { type: "string", description: "Godot project path." } }, ["project"]),
      false,
    ),
    def(
      "godot-mcp", "game", "godot__run_project",
      "Launch the Godot project headless and capture log output.",
      ["godot", "run", "launch", "playtest", "headless"],
      buildSchema({ project: { type: "string", description: "Godot project path." } }, ["project"]),
      true,
    ),
    def(
      "godot-mcp", "game", "godot__script_lint",
      "Lint GDScript files in a Godot project and report diagnostics.",
      ["godot", "gdscript", "lint", "script", "diagnostics"],
      buildSchema({ project: { type: "string", description: "Godot project path." } }, ["project"]),
      false,
    ),
    def(
      "godot-mcp", "game", "godot__export_build",
      "Export a Godot build preset to a distributable package.",
      ["godot", "export", "build", "preset", "package"],
      buildSchema(
        {
          project: { type: "string", description: "Godot project path." },
          preset: { type: "string", description: "Export preset name." },
        },
        ["project", "preset"],
      ),
      true,
    ),
    def(
      "blender-mcp", "game", "blender__render",
      "Render a Blender scene frame to an image file.",
      ["blender", "render", "scene", "frame", "3d"],
      buildSchema(
        {
          blend: { type: "string", description: ".blend file path." },
          frame: { type: "number", description: "Frame number." },
        },
        ["blend", "frame"],
      ),
      true,
    ),
    def(
      "blender-mcp", "game", "blender__import_mesh",
      "Import a mesh asset into the open Blender scene.",
      ["blender", "import", "mesh", "asset", "3d"],
      buildSchema({ asset: { type: "string", description: "Mesh asset path." } }, ["asset"]),
      true,
    ),
    def(
      "blender-mcp", "game", "blender__export_fbx",
      "Export the active Blender selection to FBX.",
      ["blender", "export", "fbx", "mesh", "3d"],
      buildSchema({ out: { type: "string", description: "Output FBX path." } }, ["out"]),
      true,
    ),
    // ---- research (6) ----
    def(
      "crawl4ai", "research", "crawl4ai__crawl_page",
      "Crawl a URL and return cleaned page content.",
      ["crawl", "crawl4ai", "web", "scrape", "fetch"],
      buildSchema({ url: { type: "string", description: "Page URL." } }, ["url"]),
      true,
    ),
    def(
      "crawl4ai", "research", "crawl4ai__extract_markdown",
      "Extract a page as markdown for research notes.",
      ["crawl", "crawl4ai", "markdown", "extract", "notes"],
      buildSchema({ url: { type: "string", description: "Page URL." } }, ["url"]),
      false,
    ),
    def(
      "searxng", "research", "searxng__web_search",
      "Search the web via SearXNG and return ranked results.",
      ["search", "searxng", "web", "query", "research"],
      buildSchema({ query: { type: "string", description: "Search query." } }, ["query"]),
      false,
    ),
    def(
      "searxng", "research", "searxng__search_images",
      "Search images via SearXNG for reference material.",
      ["search", "searxng", "images", "reference", "media"],
      buildSchema({ query: { type: "string", description: "Search query." } }, ["query"]),
      false,
    ),
    def(
      "computer-use-linux", "research", "gui__click",
      "Click a desktop UI element by label or coordinates.",
      ["gui", "click", "desktop", "computer-use", "automation"],
      buildSchema({ target: { type: "string", description: "Element label or x,y." } }, ["target"]),
      true,
    ),
    def(
      "computer-use-linux", "research", "gui__screenshot",
      "Capture the Linux desktop screenshot for grounding.",
      ["gui", "screenshot", "desktop", "computer-use", "grounding"],
      buildSchema({}, []),
      false,
    ),
  ];
}

/** In-memory BM25 catalog with an inverted index over tool corpus text. */
export class ToolCatalog {
  private docs = new Map<string, DocStats>();
  private docFreq = new Map<string, number>();
  private totalLength = 0;

  get size(): number {
    return this.docs.size;
  }

  toolCount(): number {
    return this.docs.size;
  }

  addTool(definition: BackendToolDef): void {
    if (this.docs.has(definition.name)) {
      throw new Error(`Duplicate backend tool name "${definition.name}". Failing closed.`);
    }
    assertValidBrokerProfile(definition.profile);
    const terms = tokenize(corpusText(definition));
    if (terms.length === 0) {
      throw new Error(`Backend tool "${definition.name}" has empty indexable text. Failing closed.`);
    }
    const counts = new Map<string, number>();
    for (const term of terms) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    for (const term of counts.keys()) {
      this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
    }
    this.totalLength += terms.length;
    this.docs.set(definition.name, { def: definition, terms: counts, length: terms.length });
  }

  getTool(name: string): BackendToolDef {
    const entry = this.docs.get(name);
    if (entry === undefined) {
      throw new Error(`Unknown backend tool "${name}". Failing closed.`);
    }
    return entry.def;
  }

  hasTool(name: string): boolean {
    return this.docs.has(name);
  }

  profiles(): BrokerProfile[] {
    const seen = new Set<BrokerProfile>();
    for (const entry of this.docs.values()) {
      seen.add(entry.def.profile);
    }
    return [...ALL_BROKER_PROFILES].filter((p) => seen.has(p));
  }

  toolsInProfile(profile: BrokerProfile): BackendToolDef[] {
    assertValidBrokerProfile(profile);
    const out: BackendToolDef[] = [];
    for (const entry of this.docs.values()) {
      if (entry.def.profile === profile) {
        out.push(entry.def);
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  private bm25(queryTerms: string[], entry: DocStats, avgLength: number, docCount: number): number {
    let score = 0;
    for (const term of new Set(queryTerms)) {
      const tf = entry.terms.get(term) ?? 0;
      if (tf === 0) {
        continue;
      }
      const df = this.docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (entry.length / avgLength));
      score += idf * ((tf * (BM25_K1 + 1)) / denom);
    }
    return score;
  }

  private triggerMatch(queryTerms: string[], toolName: string): number {
    const tokens = nameTokens(toolName);
    const fused = tokens.join("");
    let hits = 0;
    for (const term of new Set(queryTerms)) {
      if (tokens.includes(term) || (term.length >= 3 && fused.includes(term))) {
        hits += 1;
      }
    }
    return hits;
  }

  private keywordBoost(queryTerms: string[], keywords: string[]): number {
    const lowered = keywords.map((k) => k.toLowerCase());
    const unique = new Set(queryTerms);
    let hits = 0;
    for (const keyword of lowered) {
      for (const term of unique) {
        if (keyword === term || keyword.includes(term) || term.includes(keyword)) {
          hits += 1;
          break;
        }
      }
    }
    return hits;
  }

  search(query: string, options: CatalogSearchOptions = {}): RankedTool[] {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new Error("Search query must be a non-empty string. Failing closed.");
    }
    let profileFilter: BrokerProfile | undefined;
    if (options.profile !== undefined) {
      if (typeof options.profile !== "string") {
        throw new Error("Search profile filter must be a string. Failing closed.");
      }
      assertValidBrokerProfile(options.profile);
      profileFilter = options.profile;
    }
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
      throw new Error(
        `Search limit must be an integer in 1..${MAX_SEARCH_LIMIT}. Received: ${String(options.limit)}. Failing closed.`,
      );
    }
    if (this.docs.size === 0) {
      throw new Error("Tool catalog is empty. Failing closed.");
    }

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) {
      throw new Error("Search query contains no indexable terms. Failing closed.");
    }
    const avgLength = this.totalLength / this.docs.size;
    const ranked: RankedTool[] = [];
    for (const entry of this.docs.values()) {
      if (profileFilter !== undefined && entry.def.profile !== profileFilter) {
        continue;
      }
      const trigger = this.triggerMatch(queryTerms, entry.def.name);
      const bm25 = this.bm25(queryTerms, entry, avgLength, this.docs.size);
      const boost = this.keywordBoost(queryTerms, entry.def.boostKeywords);
      const score = trigger * TRIGGER_WEIGHT + bm25 * BM25_WEIGHT + boost * KEYWORD_WEIGHT;
      if (score > 0) {
        ranked.push({
          name: entry.def.name,
          profile: entry.def.profile,
          server: entry.def.server,
          summary: entry.def.description,
          score,
        });
      }
    }
    ranked.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
    return ranked.slice(0, limit);
  }
}

/** Builds a catalog pre-populated with all seed tool definitions. */
export function createDefaultCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  for (const definition of buildSeedToolDefinitions()) {
    catalog.addTool(definition);
  }
  return catalog;
}

/** Parses and validates the stored JSON input schema of a tool definition. */
export function parseInputSchema(definition: BackendToolDef): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition.inputSchemaJson);
  } catch {
    throw new Error(`Tool "${definition.name}" carries corrupt inputSchemaJson. Failing closed.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Tool "${definition.name}" inputSchema must be a JSON object. Failing closed.`);
  }
  return parsed as Record<string, unknown>;
}

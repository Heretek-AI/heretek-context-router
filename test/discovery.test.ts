import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolCatalog, buildSeedToolDefinitions, createDefaultCatalog } from "../src/lazy-broker/bm25-catalog.ts";
import { registerGatewayBackends } from "../src/lazy-broker/gateway.ts";
import {
  AuthorizationError,
  callTool,
  clearBackendTransports,
  inspectToolSchema,
  isMutatingTool,
  refreshCatalog,
  resetCircuitBreaker,
  searchTools,
  toolDefFromDescriptor,
} from "../src/lazy-broker/meta-router-mcp.ts";
import { FakeMcpServer } from "./helpers/fake-mcp-server.ts";

const GHIDRA_TOOLS = [
  {
    name: "decompile",
    description: "Decompile a function to pseudocode.\nSecond line is not indexed as the summary.",
    inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
    annotations: { readOnlyHint: true },
  },
  { name: "rename_symbol", description: "Rename a symbol in the program database.", inputSchema: { type: "object" } },
  { name: "list_strings", description: "List defined strings.", annotations: { readOnlyHint: true } },
];

describe("ToolCatalog maintenance", () => {
  test("replaceServerTools keeps BM25 statistics identical to a freshly built catalog", () => {
    const seeds = buildSeedToolDefinitions();
    const incremental = createDefaultCatalog();
    const discovered = GHIDRA_TOOLS.map((t) => toolDefFromDescriptor("ghidra-mcp", t));
    incremental.replaceServerTools("ghidra-mcp", discovered);

    const fresh = new ToolCatalog();
    for (const def of seeds.filter((s) => s.server !== "ghidra-mcp")) fresh.addTool(def);
    for (const def of discovered) fresh.addTool(def);

    expect(incremental.toolCount()).toBe(fresh.toolCount());
    for (const query of ["decompile function pseudocode", "android adb install", "render scene", "rename symbol"]) {
      expect(incremental.search(query, { limit: 10 })).toEqual(fresh.search(query, { limit: 10 }));
    }
  });

  test("replaceServerTools is atomic and refuses foreign or duplicate tools", () => {
    const catalog = createDefaultCatalog();
    const before = catalog.toolsForServer("ghidra-mcp").map((t) => t.name);
    const good = toolDefFromDescriptor("ghidra-mcp", { name: "decompile" });
    const foreign = toolDefFromDescriptor("blender-mcp", { name: "render" });
    expect(() => catalog.replaceServerTools("ghidra-mcp", [good, foreign])).toThrow();
    expect(() => catalog.replaceServerTools("ghidra-mcp", [good, good])).toThrow();
    expect(catalog.toolsForServer("ghidra-mcp").map((t) => t.name)).toEqual(before);
  });

  test("upsertTool replaces an entry in place and removeTool drops it", () => {
    const catalog = createDefaultCatalog();
    const count = catalog.toolCount();
    catalog.upsertTool({ ...catalog.getTool("core_fs_read"), description: "Fetch zebra manifest text." });
    expect(catalog.toolCount()).toBe(count);
    expect(catalog.search("zebra manifest")[0]?.name).toBe("core_fs_read");
    expect(catalog.removeTool("core_fs_read")).toBe(true);
    expect(catalog.removeTool("core_fs_read")).toBe(false);
    expect(catalog.toolCount()).toBe(count - 1);
  });
});

describe("toolDefFromDescriptor", () => {
  test("prefixes with the gateway target and derives mutating from readOnlyHint", () => {
    const ro = toolDefFromDescriptor("ghidra-mcp", GHIDRA_TOOLS[0] as (typeof GHIDRA_TOOLS)[number]);
    expect(ro).toMatchObject({
      name: "ghidra_decompile",
      remoteName: "decompile",
      server: "ghidra-mcp",
      profile: "appsec",
      description: "Decompile a function to pseudocode.",
      mutating: false,
      source: "discovered",
    });
    expect(toolDefFromDescriptor("ghidra-mcp", { name: "rename_symbol" }).mutating).toBe(true);
    expect(toolDefFromDescriptor("computer-use-linux", { name: "click" }).name).toBe("gui_click");
    expect(() => toolDefFromDescriptor("unknown-server", { name: "x" })).toThrow();
  });
});

describe("catalog discovery through the gateway", () => {
  let server: FakeMcpServer;
  let catalog: ToolCatalog;
  beforeEach(() => {
    clearBackendTransports();
    resetCircuitBreaker();
    catalog = createDefaultCatalog();
    server = new FakeMcpServer({ tools: { ghidra: GHIDRA_TOOLS, core: [] }, responseMode: "sse", pageSize: 2 });
  });
  afterEach(() => {
    clearBackendTransports();
    resetCircuitBreaker();
    server.stop();
  });

  test("successful discovery replaces the seed tools of that backend", async () => {
    registerGatewayBackends({ gatewayUrl: server.url, mode: "per-target", servers: ["ghidra-mcp"] });
    expect(catalog.hasTool("ghidra_decompile_function")).toBe(true);
    const reports = await refreshCatalog({ catalog });
    expect(reports).toEqual([{ server: "ghidra-mcp", ok: true, toolCount: 3 }]);
    expect(catalog.toolsForServer("ghidra-mcp").map((t) => t.name)).toEqual([
      "ghidra_decompile",
      "ghidra_list_strings",
      "ghidra_rename_symbol",
    ]);
    expect(catalog.hasTool("ghidra_decompile_function")).toBe(false);
    // other backends keep their offline seeds
    expect(catalog.hasTool("adb_install")).toBe(true);

    const hits = searchTools({ query: "decompile pseudocode" }, catalog);
    expect(hits[0]?.name).toBe("ghidra_decompile");
    expect(inspectToolSchema("ghidra_decompile", catalog)).toEqual(GHIDRA_TOOLS[0]?.inputSchema as Record<string, unknown>);
    expect(isMutatingTool("ghidra_rename_symbol", catalog)).toBe(true);

    // discovered tools are callable end-to-end, with the role gate in front
    const out = await callTool({ toolName: "ghidra_decompile", args: { address: "0x10" } }, { role: "director", catalog });
    expect(out.result).toMatchObject({ structuredContent: { path: "/mcp/ghidra", name: "decompile" } });
    await expect(
      callTool({ toolName: "ghidra_rename_symbol", args: {} }, { role: "director", catalog }),
    ).rejects.toThrow(AuthorizationError);
  });

  test("an empty tools/list replaces the seeds with nothing", async () => {
    registerGatewayBackends({ gatewayUrl: server.url, mode: "per-target", servers: ["heretek-core"] });
    const reports = await refreshCatalog({ catalog });
    expect(reports).toEqual([{ server: "heretek-core", ok: true, toolCount: 0 }]);
    expect(catalog.toolsForServer("heretek-core")).toEqual([]);
  });

  test("a failing backend keeps its seed tools and reports the error", async () => {
    registerGatewayBackends({ gatewayUrl: server.url, mode: "per-target", servers: ["ghidra-mcp", "blender-mcp"] });
    server.offline.add("ghidra");
    const reports = await refreshCatalog({ catalog });
    const ghidra = reports.find((r) => r.server === "ghidra-mcp");
    const blender = reports.find((r) => r.server === "blender-mcp");
    expect(ghidra).toMatchObject({ ok: false, toolCount: 4 });
    expect(ghidra?.error).toContain("503");
    // no route for blender on the fake gateway -> 404, seeds kept
    expect(blender).toMatchObject({ ok: false, toolCount: 3 });
    expect(catalog.hasTool("ghidra_decompile_function")).toBe(true);
  });

  test("multiplexed discovery strips the <target>_ prefix per backend", async () => {
    registerGatewayBackends({ gatewayUrl: server.url, mode: "multiplexed", servers: ["ghidra-mcp", "heretek-core"] });
    const reports = await refreshCatalog({ catalog });
    expect(reports).toEqual([
      { server: "ghidra-mcp", ok: true, toolCount: 3 },
      { server: "heretek-core", ok: true, toolCount: 0 },
    ]);
    // one shared multiplexed tools/list (2 pages) serves both backends
    expect(server.rpcRequests("tools/list")).toHaveLength(2);
    expect(catalog.getTool("ghidra_decompile").remoteName).toBe("decompile");
    const out = await callTool({ toolName: "ghidra_list_strings", args: {} }, { role: "qa-adversary", catalog });
    expect(out.result).toMatchObject({ structuredContent: { path: "/mcp", name: "ghidra_list_strings" } });
  });
});

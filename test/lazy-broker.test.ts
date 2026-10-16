import { describe, expect, test } from "bun:test";
import {
  createDefaultCatalog,
  buildSeedToolDefinitions,
  tokenize,
  TRIGGER_WEIGHT,
  BM25_WEIGHT,
  KEYWORD_WEIGHT,
} from "../src/lazy-broker/bm25-catalog.ts";
import {
  AuthorizationError,
  BackendUnreachableError,
  CIRCUIT_OPEN_MS,
  CircuitOpenError,
  UnknownToolError,
  ValidationError,
  authorizeCall,
  callTool,
  clearBackendTransports,
  estimateTokenCount,
  getDefaultCatalog,
  inspectToolSchema,
  isMutatingTool,
  listMetaTools,
  registerBackendTransport,
  resetCircuitBreaker,
  searchTools,
} from "../src/lazy-broker/meta-router-mcp.ts";

describe("tools/list surface: exactly 3 meta-tools under the token budget", () => {
  test("exposes exactly mcp_search_tools, mcp_inspect_schema, mcp_call_tool", () => {
    const tools = listMetaTools();
    expect(tools.map((t) => t.name)).toEqual([
      "mcp_search_tools",
      "mcp_inspect_schema",
      "mcp_call_tool",
    ]);
  });

  test("estimated schema footprint is under the 500-token hard budget (target <400)", () => {
    const tokens = estimateTokenCount();
    expect(tokens).toBeLessThan(500);
    expect(tokens).toBeLessThan(400);
    expect(tokens).toBeGreaterThan(0);
  });

  test("meta-tool schemas declare the required inputs", () => {
    const tools = listMetaTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("mcp_search_tools")?.inputSchema.required).toContain("query");
    expect(byName.get("mcp_inspect_schema")?.inputSchema.required).toContain("toolName");
    expect(byName.get("mcp_call_tool")?.inputSchema.required).toEqual(
      expect.arrayContaining(["toolName", "args"]),
    );
  });
});

describe("catalog population: 30+ domain tools across all 5 profiles", () => {
  test("default catalog indexes at least 30 tools", () => {
    expect(getDefaultCatalog().toolCount()).toBeGreaterThanOrEqual(30);
  });

  test("all five Heretek Compose profiles are represented", () => {
    const catalog = getDefaultCatalog();
    expect(catalog.profiles()).toEqual(["core", "appsec", "android", "game", "research"]);
    for (const profile of ["core", "appsec", "android", "game", "research"] as const) {
      expect(catalog.toolsInProfile(profile).length).toBeGreaterThan(0);
    }
  });

  test("required backend servers are all present", () => {
    const seeds = buildSeedToolDefinitions();
    const servers = new Set(seeds.map((s) => s.server));
    for (const server of [
      "ghidra-mcp",
      "radare2-mcp",
      "morluto/rea",
      "iksnerd/adb-mcp",
      "maestro",
      "godot-mcp",
      "blender-mcp",
      "crawl4ai",
      "searxng",
      "computer-use-linux",
    ]) {
      expect(servers.has(server)).toBe(true);
    }
    expect(servers.size).toBeGreaterThanOrEqual(10);
    const catalog = createDefaultCatalog();
    expect(catalog.toolCount()).toBe(seeds.length);
    for (const seed of seeds) {
      expect(catalog.hasTool(seed.name)).toBe(true);
    }
  });

  test("tokenizer lowercases and splits on separators", () => {
    expect(tokenize("Android ADB-Install")).toEqual(["android", "adb", "install"]);
  });

  test("scoring weights match the SPEC formula constants", () => {
    expect(TRIGGER_WEIGHT).toBe(3.0);
    expect(BM25_WEIGHT).toBe(1.0);
    expect(KEYWORD_WEIGHT).toBe(2.0);
  });
});

describe("BM25 search accuracy and latency", () => {
  test("android query ranks an adb tool first", () => {
    const hits = searchTools({ query: "android adb install apk device" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.name.startsWith("adb_")).toBe(true);
    expect(hits[0]?.profile).toBe("android");
  });

  test("ghidra decompile query ranks the ghidra decompiler first", () => {
    const hits = searchTools({ query: "ghidra decompile function pseudocode" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.name).toBe("ghidra_decompile_function");
  });

  test("godot scene query ranks the godot scene inspector first", () => {
    const hits = searchTools({ query: "godot scene tree nodes" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.name).toBe("godot_scene_tree");
  });

  test("profile filter restricts results to that profile", () => {
    const hits = searchTools({ query: "render scene", profile: "game", limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.profile).toBe("game");
    }
    expect(hits[0]?.name).toBe("blender_render");
  });

  test("results carry name/profile/summary but never full schemas", () => {
    const hits = searchTools({ query: "web search" });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(typeof hit.name).toBe("string");
      expect(typeof hit.summary).toBe("string");
      expect("inputSchema" in hit).toBe(false);
      expect("inputSchemaJson" in hit).toBe(false);
    }
  });

  test("search completes well within a reasonable bound", () => {
    const catalog = getDefaultCatalog();
    const start = performance.now();
    for (let i = 0; i < 20; i += 1) {
      catalog.search("android reverse binary godot render search");
    }
    const elapsedMs = performance.now() - start;
    expect(elapsedMs / 20).toBeLessThan(100);
  });

  test("empty query and bad profile/limit fail closed", () => {
    expect(() => searchTools({ query: "   " })).toThrow(ValidationError);
    expect(() => searchTools({ query: "adb", profile: "nope" })).toThrow(Error);
    expect(() => searchTools({ query: "adb", limit: 0 })).toThrow(ValidationError);
    expect(() => searchTools({ query: "adb", limit: 99 })).toThrow(ValidationError);
  });
});

describe("inspect schema path", () => {
  test("returns the full input schema for a single tool", () => {
    const schema = inspectToolSchema("adb_install");
    expect(schema["type"]).toBe("object");
    const properties = schema["properties"] as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["apk", "serial"]);
    expect(schema["required"]).toEqual(expect.arrayContaining(["apk", "serial"]));
  });

  test("unknown tool names fail closed", () => {
    expect(() => inspectToolSchema("does__not_exist")).toThrow(UnknownToolError);
    expect(() => inspectToolSchema("")).toThrow(ValidationError);
  });
});

describe("authorization gate", () => {
  test("mutating flags are set: writes/installs mutate, reads do not", () => {
    expect(isMutatingTool("core_fs_write")).toBe(true);
    expect(isMutatingTool("adb_install")).toBe(true);
    expect(isMutatingTool("maestro_test")).toBe(true);
    expect(isMutatingTool("core_fs_read")).toBe(false);
    expect(isMutatingTool("ghidra_decompile_function")).toBe(false);
    expect(isMutatingTool("searxng_web_search")).toBe(false);
  });

  test("qa-adversary and director cannot call mutating tools", () => {
    expect(() => authorizeCall("qa-adversary", "core_fs_write")).toThrow(AuthorizationError);
    expect(() => authorizeCall("director", "adb_install")).toThrow(AuthorizationError);
  });

  test("qa-adversary and director may call read-only tools", () => {
    expect(() => authorizeCall("qa-adversary", "core_fs_read")).not.toThrow();
    expect(() => authorizeCall("director", "ghidra_decompile_function")).not.toThrow();
  });

  test("staff-backend may call mutating tools", () => {
    expect(() => authorizeCall("staff-backend", "core_fs_write")).not.toThrow();
  });

  test("unknown roles and tools fail closed", () => {
    expect(() => authorizeCall("intruder" as never, "core_fs_read")).toThrow(ValidationError);
    expect(() => authorizeCall("staff-backend", "nope__missing")).toThrow(UnknownToolError);
  });
});

describe("call routing, breaker, and fail-closed backends", () => {
  test("routes a call to the registered backend transport and returns its result", async () => {
    clearBackendTransports();
    resetCircuitBreaker();
    try {
      registerBackendTransport("heretek-core", (tool, args) => ({
        echoedTool: tool.name,
        echoedArgs: args,
      }));
      const out = await callTool(
        { toolName: "core_fs_read", args: { path: "roles/director.md" } },
        { role: "staff-backend" },
      );
      expect(out.ok).toBe(true);
      expect(out.server).toBe("heretek-core");
      expect(out.profile).toBe("core");
      expect(out.result).toEqual({
        echoedTool: "core_fs_read",
        echoedArgs: { path: "roles/director.md" },
      });
    } finally {
      clearBackendTransports();
      resetCircuitBreaker();
    }
  });

  test("unreachable backend fails closed without a registered transport", async () => {
    clearBackendTransports();
    resetCircuitBreaker("searxng_web_search");
    try {
      const promise = callTool(
        { toolName: "searxng_web_search", args: { query: "bm25" } },
        { role: "staff-backend" },
      );
      await expect(promise).rejects.toThrow(BackendUnreachableError);
    } finally {
      resetCircuitBreaker("searxng_web_search");
    }
  });

  test("argument validation fails closed on missing and mistyped fields", async () => {
    clearBackendTransports();
    resetCircuitBreaker("core_fs_read");
    try {
      registerBackendTransport("heretek-core", () => "unreachable");
      await expect(
        callTool({ toolName: "core_fs_read", args: {} }, { role: "staff-backend" }),
      ).rejects.toThrow(ValidationError);
      await expect(
        callTool({ toolName: "core_fs_read", args: { path: 42 } }, { role: "staff-backend" }),
      ).rejects.toThrow(ValidationError);
    } finally {
      clearBackendTransports();
      resetCircuitBreaker("core_fs_read");
    }
  });

  test("denied roles fail closed before any backend contact", async () => {
    clearBackendTransports();
    resetCircuitBreaker("core_fs_write");
    try {
      let contacted = false;
      registerBackendTransport("heretek-core", () => {
        contacted = true;
        return "unreachable";
      });
      await expect(
        callTool(
          { toolName: "core_fs_write", args: { path: "x", contents: "y" } },
          { role: "qa-adversary" },
        ),
      ).rejects.toThrow(AuthorizationError);
      expect(contacted).toBe(false);
    } finally {
      clearBackendTransports();
      resetCircuitBreaker("core_fs_write");
    }
  });

  test("circuit opens for 60s after 3 consecutive backend failures", async () => {
    clearBackendTransports();
    resetCircuitBreaker("blender_render");
    try {
      registerBackendTransport("blender-mcp", () => {
        throw new Error("boom");
      });
      const args = { blend: "scene.blend", frame: 1 };
      await expect(callTool({ toolName: "blender_render", args }, { role: "staff-backend", nowMs: 1_000 })).rejects.toThrow(
        BackendUnreachableError,
      );
      await expect(callTool({ toolName: "blender_render", args }, { role: "staff-backend", nowMs: 2_000 })).rejects.toThrow(
        BackendUnreachableError,
      );
      await expect(callTool({ toolName: "blender_render", args }, { role: "staff-backend", nowMs: 3_000 })).rejects.toThrow(
        BackendUnreachableError,
      );
      await expect(callTool({ toolName: "blender_render", args }, { role: "staff-backend", nowMs: 4_000 })).rejects.toThrow(
        CircuitOpenError,
      );
      // Still open just before the 60s window elapses, closed right after.
      await expect(
        callTool(
          { toolName: "blender_render", args },
          { role: "staff-backend", nowMs: 3_000 + CIRCUIT_OPEN_MS - 1 },
        ),
      ).rejects.toThrow(CircuitOpenError);
      expect(CIRCUIT_OPEN_MS).toBe(60_000);
      await expect(
        callTool(
          { toolName: "blender_render", args },
          { role: "staff-backend", nowMs: 3_000 + CIRCUIT_OPEN_MS + 1 },
        ),
      ).rejects.toThrow(BackendUnreachableError);
    } finally {
      clearBackendTransports();
      resetCircuitBreaker("blender_render");
    }
  });

  test("successful call resets the consecutive-failure count", async () => {
    clearBackendTransports();
    resetCircuitBreaker("core_git_status");
    try {
      const script: Array<"fail" | "ok"> = ["fail", "fail", "ok", "fail", "fail", "ok"];
      registerBackendTransport("heretek-core", () => {
        const step = script.shift();
        if (step === "fail") {
          throw new Error("flaky");
        }
        return { clean: true };
      });
      const input = { toolName: "core_git_status", args: {} };
      await expect(callTool(input, { role: "staff-backend", nowMs: 100 })).rejects.toThrow(
        BackendUnreachableError,
      );
      await expect(callTool(input, { role: "staff-backend", nowMs: 200 })).rejects.toThrow(
        BackendUnreachableError,
      );
      // Two consecutive failures, then a success resets the count: the next
      // two failures must NOT trip the circuit (needs 3 consecutive again).
      const reset = await callTool(input, { role: "staff-backend", nowMs: 300 });
      expect(reset.result).toEqual({ clean: true });
      await expect(callTool(input, { role: "staff-backend", nowMs: 400 })).rejects.toThrow(
        BackendUnreachableError,
      );
      await expect(callTool(input, { role: "staff-backend", nowMs: 500 })).rejects.toThrow(
        BackendUnreachableError,
      );
      const recovered = await callTool(input, { role: "staff-backend", nowMs: 600 });
      expect(recovered).toMatchObject({ ok: true, toolName: "core_git_status" });
      expect(script).toEqual([]);
    } finally {
      clearBackendTransports();
      resetCircuitBreaker("core_git_status");
    }
  });

  test("unknown tools and unknown roles fail closed", async () => {
    await expect(
      callTool({ toolName: "nope__missing", args: {} }, { role: "staff-backend" }),
    ).rejects.toThrow(UnknownToolError);
    await expect(
      callTool({ toolName: "core_fs_read", args: { path: "x" } }, { role: "intruder" }),
    ).rejects.toThrow(ValidationError);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  McpHttpError,
  McpRpcError,
  MCP_PROTOCOL_VERSION,
  StreamableHttpMcpClient,
  parseSseEvents,
} from "../src/lazy-broker/http-transport.ts";
import { gatewayOptionsFromEnv, registerGatewayBackends } from "../src/lazy-broker/gateway.ts";
import {
  AuthorizationError,
  BackendUnreachableError,
  CircuitOpenError,
  callTool,
  clearBackendTransports,
  resetCircuitBreaker,
} from "../src/lazy-broker/meta-router-mcp.ts";
import { createDefaultCatalog } from "../src/lazy-broker/bm25-catalog.ts";
import { FakeMcpServer } from "./helpers/fake-mcp-server.ts";

const TOOLS = {
  core: [
    { name: "fs_read", description: "Read a file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "fs_write", description: "Write a file.", inputSchema: { type: "object" } },
  ],
  blender: [{ name: "render", description: "Render a frame.", inputSchema: { type: "object" } }],
};

describe("parseSseEvents", () => {
  test("joins multi-line data, skips comments and non-data fields", () => {
    const events = parseSseEvents(": hi\nevent: message\ndata: {\"a\":\ndata: 1}\nid: 7\n\ndata:x\n\n");
    expect(events).toEqual(['{"a":\n1}', "x"]);
  });
});

for (const mode of ["json", "sse"] as const) {
  describe(`StreamableHttpMcpClient (${mode} responses)`, () => {
    let server: FakeMcpServer;
    beforeEach(() => {
      server = new FakeMcpServer({ tools: TOOLS, responseMode: mode, pageSize: 1 });
    });
    afterEach(() => server.stop());

    test("initializes once, then echoes Mcp-Session-Id and protocol version", async () => {
      const client = new StreamableHttpMcpClient({ url: `${server.url}/mcp/core`, headers: { "x-heretek-role": "manager" } });
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["fs_read", "fs_write"]);
      const result = await client.callTool("fs_read", { path: "a.txt" });
      expect(result).toMatchObject({ structuredContent: { name: "fs_read", arguments: { path: "a.txt" } } });

      expect(server.initializeCount()).toBe(1);
      expect(client.session).toBe("sess-1");
      expect(client.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      const initialized = server.rpcRequests("notifications/initialized");
      expect(initialized).toHaveLength(1);
      expect(initialized[0]?.sessionId).toBe("sess-1");
      // two tools/list pages (pageSize 1) + one call, all on the session
      const later = server.requests.filter((r) => r.rpcMethod === "tools/list" || r.rpcMethod === "tools/call");
      expect(later).toHaveLength(3);
      for (const request of later) {
        expect(request.sessionId).toBe("sess-1");
        expect(request.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
        expect(request.role).toBe("manager");
      }
    });

    test("concurrent first requests share a single initialize handshake", async () => {
      const client = new StreamableHttpMcpClient({ url: `${server.url}/mcp/core` });
      await Promise.all([client.listTools(), client.callTool("fs_read", { path: "x" }), client.request("ping")]
        .map((p) => p.then(() => "ok", (e: unknown) => (e instanceof McpRpcError ? "rpc" : "other"))));
      expect(server.initializeCount()).toBe(1);
    });

    test("re-initializes once when the server expires the session (404)", async () => {
      const client = new StreamableHttpMcpClient({ url: `${server.url}/mcp/core` });
      await client.listTools();
      server.expireSessions();
      const result = await client.callTool("fs_read", { path: "b" });
      expect(result).toMatchObject({ structuredContent: { name: "fs_read" } });
      expect(server.initializeCount()).toBe(2);
      expect(client.session).toBe("sess-2");
    });

    test("JSON-RPC errors surface as McpRpcError, HTTP failures as McpHttpError", async () => {
      const client = new StreamableHttpMcpClient({ url: `${server.url}/mcp/core` });
      const rpc = await client.callTool("missing", {}).then(() => undefined, (e: unknown) => e);
      expect(rpc).toBeInstanceOf(McpRpcError);
      expect((rpc as McpRpcError).rpcCode).toBe(-32602);
      server.failCallsWith.set("core", 500);
      const http = await client.callTool("fs_read", { path: "x" }).then(() => undefined, (e: unknown) => e);
      expect(http).toBeInstanceOf(McpHttpError);
      expect((http as McpHttpError).status).toBe(500);
    });
  });
}

describe("StreamableHttpMcpClient connection failures", () => {
  test("an unreachable endpoint fails with McpHttpError status 0", async () => {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const deadUrl = `http://127.0.0.1:${probe.port}/mcp/core`;
    probe.stop(true);
    const client = new StreamableHttpMcpClient({ url: deadUrl, timeoutMs: 2_000 });
    const error = await client.listTools().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(McpHttpError);
    expect((error as McpHttpError).status).toBe(0);
  });

  test("rejects non-http URLs", () => {
    expect(() => new StreamableHttpMcpClient({ url: "stdio://x" })).toThrow();
  });
});

describe("gateway options", () => {
  test("defaults to http://127.0.0.1:3000 per-target and validates env", () => {
    expect(gatewayOptionsFromEnv({})).toEqual({ gatewayUrl: "http://127.0.0.1:3000", mode: "per-target" });
    expect(
      gatewayOptionsFromEnv({ HERETEK_GATEWAY_URL: "http://gw:3000", HERETEK_GATEWAY_MODE: "multiplexed", HERETEK_GATEWAY_TOKEN: "t", HERETEK_GATEWAY_TIMEOUT_MS: "500" }),
    ).toEqual({ gatewayUrl: "http://gw:3000", mode: "multiplexed", token: "t", timeoutMs: 500 });
    expect(() => gatewayOptionsFromEnv({ HERETEK_GATEWAY_URL: "ftp://x" })).toThrow();
    expect(() => gatewayOptionsFromEnv({ HERETEK_GATEWAY_MODE: "mesh" })).toThrow();
    expect(() => gatewayOptionsFromEnv({ HERETEK_GATEWAY_TIMEOUT_MS: "-1" })).toThrow();
  });
});

describe("mcp_call_tool through the gateway transport", () => {
  let server: FakeMcpServer;
  beforeEach(() => {
    clearBackendTransports();
    resetCircuitBreaker();
    server = new FakeMcpServer({ tools: TOOLS, responseMode: "sse" });
  });
  afterEach(() => {
    clearBackendTransports();
    resetCircuitBreaker();
    server.stop();
  });

  test("per-target: posts the unprefixed tool name to /mcp/<target>", async () => {
    registerGatewayBackends({ gatewayUrl: server.url, mode: "per-target", role: "staff-backend", token: "s3cret" });
    const out = await callTool({ toolName: "core_fs_read", args: { path: "roles/director.md" } }, { role: "staff-backend" });
    expect(out).toMatchObject({ ok: true, server: "heretek-core", profile: "core" });
    expect(out.result).toMatchObject({ structuredContent: { path: "/mcp/core", name: "fs_read", arguments: { path: "roles/director.md" } } });
    const call = server.rpcRequests("tools/call")[0];
    expect(call?.path).toBe("/mcp/core");
    expect(call?.role).toBe("staff-backend");
    expect(call?.authorization).toBe("Bearer s3cret");
  });

  test("multiplexed: posts the <target>_<tool> catalog name to /mcp", async () => {
    registerGatewayBackends({ gatewayUrl: server.url, mode: "multiplexed" });
    const out = await callTool({ toolName: "core_fs_read", args: { path: "x" } }, { role: "manager" });
    expect(out.result).toMatchObject({ structuredContent: { path: "/mcp", name: "core_fs_read" } });
  });

  test("role check runs before any backend contact", async () => {
    registerGatewayBackends({ gatewayUrl: server.url, mode: "per-target" });
    await expect(
      callTool({ toolName: "core_fs_write", args: { path: "x", contents: "y" } }, { role: "qa-adversary" }),
    ).rejects.toThrow(AuthorizationError);
    expect(server.requests).toHaveLength(0);
  });

  test("backend HTTP errors trip the circuit breaker after 3 failures", async () => {
    const catalog = createDefaultCatalog();
    registerGatewayBackends({ gatewayUrl: server.url, mode: "per-target" });
    server.failCallsWith.set("blender", 502);
    const input = { toolName: "blender_render", args: { blend: "s.blend", frame: 1 } };
    for (const nowMs of [1_000, 2_000, 3_000]) {
      await expect(callTool(input, { role: "staff-backend", nowMs, catalog })).rejects.toThrow(BackendUnreachableError);
    }
    const callsBefore = server.rpcRequests("tools/call").length;
    expect(callsBefore).toBe(3);
    await expect(callTool(input, { role: "staff-backend", nowMs: 4_000, catalog })).rejects.toThrow(CircuitOpenError);
    expect(server.rpcRequests("tools/call")).toHaveLength(callsBefore);
  });

  test("JSON-RPC errors from the backend also count as failures", async () => {
    registerGatewayBackends({ gatewayUrl: server.url, mode: "per-target" });
    server.rpcErrorOn.add("core");
    await expect(callTool({ toolName: "core_git_status", args: {} }, { role: "manager", nowMs: 1 })).rejects.toThrow(
      /Unknown tool: git_status/,
    );
  });

  test("close() ends every session with DELETE", async () => {
    const registration = registerGatewayBackends({ gatewayUrl: server.url, mode: "per-target" });
    await callTool({ toolName: "core_fs_read", args: { path: "x" } }, { role: "manager" });
    expect(await registration.close()).toEqual([]);
    const deletes = server.requests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.sessionId).toBe("sess-1");
  });
});

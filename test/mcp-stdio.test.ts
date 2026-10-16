import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { FakeMcpServer } from "./helpers/fake-mcp-server.ts";

const BROKER = resolve(import.meta.dir, "../src/lazy-broker/meta-router-mcp.ts");

type Message = Record<string, unknown>;

/** Drives a spawned broker over newline-delimited JSON-RPC on stdio. */
class StdioPeer {
  private readonly proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  private readonly waiting = new Map<number | string | null, (m: Message) => void>();
  readonly received: Message[] = [];
  stderr = "";
  private done: Promise<void>;

  constructor(env: Record<string, string>) {
    this.proc = Bun.spawn(["bun", BROKER], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    this.done = this.pump();
    const stderr = this.proc.stderr;
    void new Response(stderr).text().then((text) => {
      this.stderr = text;
    });
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const message = JSON.parse(line) as Message;
        this.received.push(message);
        const id = message["id"] as number | string | null;
        this.waiting.get(id)?.(message);
        this.waiting.delete(id);
        nl = buffer.indexOf("\n");
      }
    }
  }

  sendRaw(line: string): void {
    this.proc.stdin.write(`${line}\n`);
    this.proc.stdin.flush();
  }

  request(id: number | string | null, method: string, params?: Message): Promise<Message> {
    const reply = new Promise<Message>((resolveReply, reject) => {
      this.waiting.set(id, resolveReply);
      setTimeout(() => reject(new Error(`no reply to ${method} (${String(id)}); stderr: ${this.stderr}`)), 8_000);
    });
    this.sendRaw(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
    return reply;
  }

  waitFor(id: number | string | null): Promise<Message> {
    const seen = this.received.find((m) => m["id"] === id);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolveReply) => this.waiting.set(id, resolveReply));
  }

  notify(method: string): void {
    this.sendRaw(JSON.stringify({ jsonrpc: "2.0", method }));
  }

  async close(): Promise<number> {
    this.proc.stdin.end();
    await this.done;
    return this.proc.exited;
  }
}

function toolText(response: Message): Message {
  const result = response["result"] as { content: Array<{ text: string }>; isError?: boolean };
  return JSON.parse(result.content[0]?.text ?? "null") as Message;
}

describe("lazy broker MCP stdio server (spawned process)", () => {
  let gateway: FakeMcpServer;
  let peer: StdioPeer;

  beforeAll(() => {
    gateway = new FakeMcpServer({
      tools: {
        core: [
          { name: "fs_read", description: "Read a workspace file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
          { name: "fs_write", description: "Write a workspace file.", inputSchema: { type: "object" } },
        ],
      },
      responseMode: "sse",
    });
    peer = new StdioPeer({ HERETEK_GATEWAY_URL: gateway.url, HERETEK_BROKER_ROLE: "qa-adversary" });
  });

  afterAll(async () => {
    await peer.close();
    gateway.stop();
  });

  test("initialize negotiates the protocol version", async () => {
    const response = await peer.request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "heretek-lazy-broker" } },
    });
    peer.notify("notifications/initialized");

    const unknownVersion = await peer.request(2, "initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    expect((unknownVersion["result"] as Message)["protocolVersion"]).toBe("2025-11-25");
    const missing = await peer.request(3, "initialize", {});
    expect((missing["error"] as Message)["code"]).toBe(-32602);
  });

  test("tools/list exposes exactly the 3 meta-tools", async () => {
    const response = await peer.request(4, "tools/list");
    const tools = (response["result"] as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(["mcp_search_tools", "mcp_inspect_schema", "mcp_call_tool"]);
  });

  test("ping answers with an empty result", async () => {
    expect(await peer.request("p", "ping")).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  test("tools/call mcp_search_tools returns ranked summaries", async () => {
    const response = await peer.request(5, "tools/call", {
      name: "mcp_search_tools",
      arguments: { query: "android adb install apk", limit: 3 },
    });
    const payload = toolText(response) as { tools: Array<{ name: string }> };
    expect(payload.tools[0]?.name).toBe("adb_install");
    expect(payload.tools.length).toBeLessThanOrEqual(3);
  });

  test("tools/call mcp_call_tool reaches the backend through the gateway", async () => {
    const response = await peer.request(6, "tools/call", {
      name: "mcp_call_tool",
      arguments: { toolName: "core_fs_read", args: { path: "README.md" } },
    });
    expect(response["result"]).toMatchObject({
      content: [{ type: "text", text: "/mcp/core:fs_read" }],
      structuredContent: { name: "fs_read", arguments: { path: "README.md" } },
    });
    const call = gateway.rpcRequests("tools/call").at(-1);
    expect(call?.role).toBe("qa-adversary");
  });

  test("the read-only role is denied mutating tools in-band (isError)", async () => {
    const before = gateway.rpcRequests("tools/call").length;
    const response = await peer.request(7, "tools/call", {
      name: "mcp_call_tool",
      arguments: { toolName: "core_fs_write", args: { path: "x", contents: "y" } },
    });
    expect((response["result"] as Message)["isError"]).toBe(true);
    expect(toolText(response)["error"]).toBe("AUTHORIZATION_DENIED");
    expect(gateway.rpcRequests("tools/call")).toHaveLength(before);
  });

  test("discovery replaced the core seeds with the gateway's live tools", async () => {
    // Discovery runs in the background after startup; poll until it lands.
    let response: Message = {};
    for (let attempt = 0; attempt < 40; attempt += 1) {
      response = await peer.request(`d${attempt}`, "tools/call", {
        name: "mcp_inspect_schema",
        arguments: { toolName: "core_shell_exec" },
      });
      if ((response["result"] as Message)["isError"] === true) break;
      await Bun.sleep(50);
    }
    expect((response["result"] as Message)["isError"]).toBe(true);
    expect(toolText(response)["error"]).toBe("UNKNOWN_TOOL");
    expect(gateway.rpcRequests("tools/list").some((r) => r.path === "/mcp/core")).toBe(true);
  });

  test("protocol errors use the JSON-RPC error codes", async () => {
    const unknownTool = await peer.request(9, "tools/call", { name: "core_fs_read", arguments: {} });
    expect((unknownTool["error"] as Message)["code"]).toBe(-32602);
    const unknownMethod = await peer.request(10, "resources/list");
    expect((unknownMethod["error"] as Message)["code"]).toBe(-32601);
    const badParams = await peer.request(11, "tools/call", { name: "mcp_search_tools", arguments: [] as unknown as Message });
    expect((badParams["error"] as Message)["code"]).toBe(-32602);

    const before = peer.received.length;
    peer.sendRaw("{not json");
    peer.sendRaw(JSON.stringify({ id: 12, method: "ping" }));
    peer.sendRaw(JSON.stringify([{ jsonrpc: "2.0", id: 13, method: "ping" }]));
    await peer.request(14, "ping");
    const errors = peer.received.slice(before).filter((m) => m["error"] !== undefined);
    // Responses may be written out of order (requests run concurrently).
    const codes = errors.map((m) => [m["id"], (m["error"] as Message)["code"]]);
    expect(codes).toHaveLength(3);
    expect(codes).toEqual(expect.arrayContaining([
      [null, -32700],
      [12, -32600],
      [null, -32600],
    ]));
  });

  test("notifications never produce output", async () => {
    const before = peer.received.length;
    peer.notify("notifications/cancelled");
    peer.notify("notifications/initialized");
    await peer.request(15, "ping");
    expect(peer.received.slice(before).map((m) => m["id"])).toEqual([15]);
  });
});

describe("lazy broker process lifecycle", () => {
  test("stays alive while stdin is open and exits 0 when it closes", async () => {
    const peer = new StdioPeer({ HERETEK_BROKER_OFFLINE: "1" });
    await Bun.sleep(300);
    const pong = await peer.request(1, "ping");
    expect(pong["result"]).toEqual({});
    expect(await peer.close()).toBe(0);
  });

  test("an invalid HERETEK_BROKER_ROLE fails closed at startup", async () => {
    const proc = Bun.spawn(["bun", BROKER], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HERETEK_BROKER_ROLE: "root", HERETEK_BROKER_OFFLINE: "1" },
    });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("HERETEK_BROKER_ROLE");
  });
});

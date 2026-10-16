/**
 * In-process fake MCP Streamable HTTP server (Bun.serve) used as a stand-in
 * for agentgateway in tests. Serves `/mcp/<target>` (one target per route,
 * unprefixed names) and `/mcp` (multiplexed, `<target>_<tool>` names), with
 * real session handling and a JSON or SSE response mode.
 */

import type { Server } from "bun";

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface RecordedRequest {
  path: string;
  method: string;
  rpcMethod?: string;
  sessionId: string | null;
  protocolVersion: string | null;
  role: string | null;
  authorization: string | null;
  body: Record<string, unknown> | undefined;
}

export interface FakeMcpServerOptions {
  /** Tools per target name. */
  tools: Record<string, FakeTool[]>;
  responseMode?: "json" | "sse";
  /** Page size for tools/list pagination (default: everything in one page). */
  pageSize?: number;
}

export class FakeMcpServer {
  readonly requests: RecordedRequest[] = [];
  responseMode: "json" | "sse";
  /** When set, tools/call on these targets answers with this HTTP status. */
  failCallsWith = new Map<string, number>();
  /** When set, tools/call on these targets answers with a JSON-RPC error. */
  rpcErrorOn = new Set<string>();
  /** Targets whose every request fails with HTTP 503 (offline backend). */
  offline = new Set<string>();
  private sessions = new Map<string, string>();
  private sessionCounter = 0;
  private server: Server<undefined>;

  constructor(private readonly options: FakeMcpServerOptions) {
    this.responseMode = options.responseMode ?? "json";
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => this.handle(req),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** Drops every live session so the next request with an old id gets 404. */
  expireSessions(): void {
    this.sessions.clear();
  }

  initializeCount(path?: string): number {
    return this.requests.filter((r) => r.rpcMethod === "initialize" && (path === undefined || r.path === path)).length;
  }

  rpcRequests(rpcMethod: string): RecordedRequest[] {
    return this.requests.filter((r) => r.rpcMethod === rpcMethod);
  }

  stop(): void {
    this.server.stop(true);
  }

  private toolsFor(path: string): { tools: FakeTool[]; multiplexed: boolean } | undefined {
    if (path === "/mcp") {
      const tools: FakeTool[] = [];
      for (const [target, list] of Object.entries(this.options.tools)) {
        for (const tool of list) {
          tools.push({ ...tool, name: `${target}_${tool.name}` });
        }
      }
      return { tools, multiplexed: true };
    }
    const match = /^\/mcp\/([a-z0-9-]+)$/.exec(path);
    if (match === null) {
      return undefined;
    }
    const list = this.options.tools[match[1] as string];
    return list === undefined ? undefined : { tools: list, multiplexed: false };
  }

  private respond(id: unknown, payload: Record<string, unknown>, headers: Record<string, string> = {}): Response {
    const message = JSON.stringify({ jsonrpc: "2.0", id, ...payload });
    if (this.responseMode === "sse") {
      // A server notification precedes the response, split across chunks,
      // to exercise incremental SSE parsing.
      const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } });
      const chunks = [`event: message\ndata: ${notification}\n\n`, `: keep-alive\n\nevent: message\nda`, `ta: ${message}\n\n`];
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
            await Bun.sleep(1);
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", ...headers } });
    }
    return new Response(message, { headers: { "content-type": "application/json", ...headers } });
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : undefined;
    const sessionId = req.headers.get("mcp-session-id");
    this.requests.push({
      path,
      method: req.method,
      ...(typeof body?.["method"] === "string" ? { rpcMethod: body["method"] } : {}),
      sessionId,
      protocolVersion: req.headers.get("mcp-protocol-version"),
      role: req.headers.get("x-heretek-role"),
      authorization: req.headers.get("authorization"),
      body,
    });
    const route = this.toolsFor(path);
    if (route === undefined) {
      return new Response("no route", { status: 404 });
    }
    const target = path === "/mcp" ? "*" : path.slice("/mcp/".length);
    if (this.offline.has(target)) {
      return new Response("backend offline", { status: 503 });
    }
    if (req.method === "DELETE") {
      if (sessionId !== null) this.sessions.delete(sessionId);
      return new Response(null, { status: 204 });
    }
    if (req.method !== "POST" || body === undefined) {
      return new Response(null, { status: 405 });
    }
    const accept = req.headers.get("accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      return new Response("bad accept", { status: 406 });
    }
    const rpcMethod = body["method"];
    if (rpcMethod === "initialize") {
      const session = `sess-${++this.sessionCounter}`;
      this.sessions.set(session, path);
      const params = body["params"] as Record<string, unknown>;
      return this.respond(
        body["id"],
        {
          result: {
            protocolVersion: params["protocolVersion"],
            capabilities: { tools: {} },
            serverInfo: { name: `fake${path}`, version: "1.0.0" },
          },
        },
        { "mcp-session-id": session },
      );
    }
    if (sessionId === null) {
      return new Response("missing session", { status: 400 });
    }
    if (this.sessions.get(sessionId) !== path) {
      return new Response("unknown session", { status: 404 });
    }
    if (body["id"] === undefined) {
      return new Response(null, { status: 202 });
    }
    const params = (body["params"] ?? {}) as Record<string, unknown>;
    if (rpcMethod === "tools/list") {
      const pageSize = this.options.pageSize ?? route.tools.length;
      const start = typeof params["cursor"] === "string" ? Number(params["cursor"]) : 0;
      const page = route.tools.slice(start, start + pageSize);
      const next = start + pageSize < route.tools.length ? String(start + pageSize) : undefined;
      return this.respond(body["id"], { result: { tools: page, ...(next ? { nextCursor: next } : {}) } });
    }
    if (rpcMethod === "tools/call") {
      const name = String(params["name"]);
      const known = route.tools.some((t) => t.name === name);
      if (this.failCallsWith.has(target)) {
        return new Response("upstream exploded", { status: this.failCallsWith.get(target) as number });
      }
      if (this.rpcErrorOn.has(target) || !known) {
        return this.respond(body["id"], { error: { code: -32602, message: `Unknown tool: ${name}` } });
      }
      return this.respond(body["id"], {
        result: {
          content: [{ type: "text", text: `${path}:${name}` }],
          structuredContent: { path, name, arguments: params["arguments"] },
        },
      });
    }
    return this.respond(body["id"], { error: { code: -32601, message: `Method not found: ${String(rpcMethod)}` } });
  }
}

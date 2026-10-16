/**
 * http-transport.ts — MCP Streamable HTTP client (JSON-RPC 2.0 over POST).
 *
 * Implements the client side of the MCP Streamable HTTP transport used by
 * agentgateway and by HTTP MCP servers:
 *
 * - every JSON-RPC message is POSTed to one endpoint with
 *   `Accept: application/json, text/event-stream`;
 * - a response is either a single `application/json` body or a
 *   `text/event-stream` whose `data:` events carry JSON-RPC messages (the
 *   response matching the request id ends the exchange; server-initiated
 *   notifications on the stream are skipped);
 * - the `Mcp-Session-Id` returned by `initialize` is echoed on every later
 *   request, together with `MCP-Protocol-Version`;
 * - `initialize` + `notifications/initialized` run once per client, and once
 *   more if the server answers 404 to a request that carried a session id
 *   (the session expired).
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const CLIENT_INFO = { name: "heretek-lazy-broker", version: "0.1.0" } as const;

export class McpHttpError extends Error {
  readonly code = "MCP_HTTP_ERROR";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class McpRpcError extends Error {
  readonly code = "MCP_RPC_ERROR";
  constructor(
    message: string,
    readonly rpcCode: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class McpProtocolError extends Error {
  readonly code = "MCP_PROTOCOL_ERROR";
}

/** A tool descriptor as returned by an MCP server's tools/list. */
export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface StreamableHttpClientOptions {
  /** Full MCP endpoint URL, e.g. http://127.0.0.1:3000/mcp/ghidra. */
  url: string;
  /** Extra headers sent on every request (auth, role propagation). */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  fetch?: FetchLike;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponseFor(message: unknown, id: number): message is JsonRpcResponse {
  return (
    isRecord(message) &&
    message["id"] === id &&
    !("method" in message) &&
    ("result" in message || "error" in message)
  );
}

/** Parses a complete SSE body into the `data` payload of each event. */
export function parseSseEvents(body: string): string[] {
  const events: string[] = [];
  let data: string[] = [];
  const flush = (): void => {
    if (data.length > 0) {
      events.push(data.join("\n"));
    }
    data = [];
  };
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith(":")) {
      continue;
    }
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "data") {
      data.push(value);
    }
  }
  flush();
  return events;
}

/** Reads an SSE stream until the JSON-RPC response with `id` arrives. */
async function readSseResponse(response: Response, id: number, url: string): Promise<JsonRpcResponse> {
  if (response.body === null) {
    throw new McpProtocolError(`MCP endpoint ${url} returned an empty event stream.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value !== undefined) {
        buffer += decoder.decode(value, { stream: !done });
      }
      // Only complete events (terminated by a blank line) are parsed until
      // the stream ends; then the trailing partial event is parsed too.
      const boundary = done ? buffer.length : Math.max(buffer.lastIndexOf("\n\n"), buffer.lastIndexOf("\r\n\r\n"));
      if (boundary > 0) {
        const complete = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary);
        for (const payload of parseSseEvents(complete)) {
          let message: unknown;
          try {
            message = JSON.parse(payload);
          } catch {
            throw new McpProtocolError(`MCP endpoint ${url} sent a non-JSON SSE event.`);
          }
          if (isResponseFor(message, id)) {
            return message;
          }
        }
      }
      if (done) {
        throw new McpProtocolError(
          `MCP endpoint ${url} closed the event stream without a response to request ${id}.`,
        );
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Streamable HTTP MCP client bound to one endpoint. */
export class StreamableHttpMcpClient {
  readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private nextId = 1;
  private sessionId: string | undefined;
  private negotiatedVersion: string | undefined;
  private initializing: Promise<void> | undefined;

  constructor(options: StreamableHttpClientOptions) {
    if (typeof options.url !== "string" || !/^https?:\/\//.test(options.url)) {
      throw new McpProtocolError(`MCP endpoint URL must be http(s), got "${String(options.url)}".`);
    }
    this.url = options.url;
    this.headers = { ...(options.headers ?? {}) };
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Session id assigned by the server during initialize (if any). */
  get session(): string | undefined {
    return this.sessionId;
  }

  /** Protocol version the server agreed to during initialize. */
  get protocolVersion(): string | undefined {
    return this.negotiatedVersion;
  }

  get initialized(): boolean {
    return this.negotiatedVersion !== undefined;
  }

  /** Runs the initialize handshake once; concurrent callers share it. */
  async ensureInitialized(): Promise<void> {
    if (this.negotiatedVersion !== undefined) {
      return;
    }
    if (this.initializing === undefined) {
      this.initializing = this.handshake().finally(() => {
        this.initializing = undefined;
      });
    }
    await this.initializing;
  }

  private async handshake(): Promise<void> {
    this.sessionId = undefined;
    const result = await this.exchange("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, true);
    if (!isRecord(result) || typeof result["protocolVersion"] !== "string") {
      throw new McpProtocolError(`MCP endpoint ${this.url} returned an invalid initialize result.`);
    }
    this.negotiatedVersion = result["protocolVersion"];
    await this.notify("notifications/initialized");
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId !== undefined) {
      headers["mcp-session-id"] = this.sessionId;
    }
    if (this.negotiatedVersion !== undefined) {
      headers["mcp-protocol-version"] = this.negotiatedVersion;
    }
    return headers;
  }

  private async post(body: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new McpHttpError(`MCP endpoint ${this.url} unreachable: ${detail}`, 0);
    }
  }

  /** Sends a JSON-RPC notification (no response expected). */
  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const response = await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      throw new McpHttpError(
        `MCP endpoint ${this.url} rejected notification ${method} with HTTP ${response.status}.`,
        response.status,
      );
    }
  }

  private async exchange(method: string, params: Record<string, unknown> | undefined, isInitialize: boolean): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new McpHttpError(
        `MCP endpoint ${this.url} answered ${method} with HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}.`,
        response.status,
      );
    }
    if (isInitialize) {
      const session = response.headers.get("mcp-session-id");
      if (session !== null && session.length > 0) {
        this.sessionId = session;
      }
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    let message: JsonRpcResponse;
    if (contentType.includes("text/event-stream")) {
      message = await readSseResponse(response, id, this.url);
    } else if (contentType.includes("application/json")) {
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new McpProtocolError(`MCP endpoint ${this.url} returned malformed JSON for ${method}.`);
      }
      const candidate = Array.isArray(parsed) ? parsed.find((m) => isResponseFor(m, id)) : parsed;
      if (!isResponseFor(candidate, id)) {
        throw new McpProtocolError(`MCP endpoint ${this.url} returned no response for ${method} (id ${id}).`);
      }
      message = candidate;
    } else {
      await response.body?.cancel().catch(() => undefined);
      throw new McpProtocolError(
        `MCP endpoint ${this.url} returned unsupported content-type "${contentType}" for ${method}.`,
      );
    }
    if (message.error !== undefined) {
      throw new McpRpcError(
        `MCP ${method} failed at ${this.url}: ${message.error.message} (code ${message.error.code}).`,
        message.error.code,
        message.error.data,
      );
    }
    return message.result;
  }

  /** Sends a request after the handshake; re-initializes once on an expired session. */
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    try {
      return await this.exchange(method, params, false);
    } catch (error) {
      if (error instanceof McpHttpError && error.status === 404 && this.sessionId !== undefined) {
        this.negotiatedVersion = undefined;
        this.sessionId = undefined;
        await this.ensureInitialized();
        return this.exchange(method, params, false);
      }
      throw error;
    }
  }

  /** tools/list, following nextCursor pagination. */
  async listTools(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const result = await this.request("tools/list", cursor === undefined ? undefined : { cursor });
      if (!isRecord(result) || !Array.isArray(result["tools"])) {
        throw new McpProtocolError(`MCP endpoint ${this.url} returned an invalid tools/list result.`);
      }
      for (const tool of result["tools"]) {
        if (!isRecord(tool) || typeof tool["name"] !== "string" || tool["name"].length === 0) {
          throw new McpProtocolError(`MCP endpoint ${this.url} listed a tool without a name.`);
        }
        tools.push(tool as unknown as McpToolDescriptor);
      }
      const next = result["nextCursor"];
      cursor = typeof next === "string" && next.length > 0 ? next : undefined;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          throw new McpProtocolError(`MCP endpoint ${this.url} repeated tools/list cursor "${cursor}".`);
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    return tools;
  }

  /** tools/call; returns the raw CallToolResult. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request("tools/call", { name, arguments: args });
    if (!isRecord(result)) {
      throw new McpProtocolError(`MCP endpoint ${this.url} returned an invalid tools/call result.`);
    }
    return result;
  }

  /** Ends the session (DELETE with Mcp-Session-Id), if one was assigned. */
  async close(): Promise<void> {
    if (this.sessionId === undefined) {
      return;
    }
    const headers = this.buildHeaders();
    this.sessionId = undefined;
    this.negotiatedVersion = undefined;
    const response = await this.fetchImpl(this.url, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
  }
}

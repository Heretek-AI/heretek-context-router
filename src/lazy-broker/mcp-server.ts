/**
 * mcp-server.ts — MCP stdio server for the lazy broker.
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (the MCP stdio
 * transport): one JSON message per line, nothing but protocol messages on
 * stdout, diagnostics on stderr. tools/list exposes ONLY the 3 meta-tools.
 */

import {
  META_TOOL_NAMES,
  ValidationError,
  callTool,
  inspectToolSchema,
  listMetaTools,
  refreshCatalog,
  searchTools,
  type BrokerRole,
  type DiscoveryReport,
} from "./meta-router-mcp.ts";
import { gatewayOptionsFromEnv, registerGatewayBackends, type GatewayRegistration } from "./gateway.ts";

/** Newest first; the first entry is offered when the client's is unknown. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const SERVER_INFO = { name: "heretek-lazy-broker", version: "0.1.0" } as const;

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

const BROKER_ROLES: readonly BrokerRole[] = [
  "director",
  "architect",
  "manager",
  "staff-backend",
  "staff-ui",
  "qa-adversary",
];

/** Fail-closed default: without HERETEK_BROKER_ROLE the broker is read-only. */
export const DEFAULT_SERVER_ROLE: BrokerRole = "director";

type JsonRpcId = string | number | null;

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export type JsonRpcResponse = JsonRpcErrorResponse | JsonRpcSuccessResponse;

export interface ServerContext {
  role: BrokerRole;
  /** Called before each mcp_search_tools (used for lazy re-discovery). */
  beforeSearch?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}

function isBackendCallResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value["content"]);
}

function textResult(payload: unknown, isError: boolean): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function runMetaTool(name: string, args: Record<string, unknown>, ctx: ServerContext): Promise<unknown> {
  if (name === "mcp_search_tools") {
    ctx.beforeSearch?.();
    const input: { query: string; profile?: string; limit?: number } = { query: args["query"] as string };
    if (args["profile"] !== undefined) input.profile = args["profile"] as string;
    if (args["limit"] !== undefined) input.limit = args["limit"] as number;
    return { tools: searchTools(input) };
  }
  if (name === "mcp_inspect_schema") {
    const toolName = args["toolName"];
    if (typeof toolName !== "string") {
      throw new ValidationError("mcp_inspect_schema: toolName must be a string.");
    }
    return { toolName, inputSchema: inspectToolSchema(toolName) };
  }
  const toolArgs = args["args"] ?? {};
  if (!isRecord(toolArgs)) {
    throw new ValidationError("mcp_call_tool: args must be an object.");
  }
  return callTool({ toolName: args["toolName"] as string, args: toolArgs }, { role: ctx.role });
}

/**
 * Handles one parsed JSON-RPC message. Returns the response to write, or
 * undefined for notifications and client responses (nothing is written).
 */
export async function handleMessage(message: unknown, ctx: ServerContext): Promise<JsonRpcResponse | undefined> {
  if (!isRecord(message) || message["jsonrpc"] !== "2.0") {
    const id = isRecord(message) && (typeof message["id"] === "string" || typeof message["id"] === "number")
      ? message["id"]
      : null;
    return errorResponse(id, JSONRPC_INVALID_REQUEST, "Invalid Request: expected a JSON-RPC 2.0 object.");
  }
  const hasId = "id" in message;
  const rawId = message["id"];
  if (hasId && rawId !== null && typeof rawId !== "string" && typeof rawId !== "number") {
    return errorResponse(null, JSONRPC_INVALID_REQUEST, "Invalid Request: id must be a string or number.");
  }
  const id = (rawId ?? null) as JsonRpcId;
  const method = message["method"];
  if (typeof method !== "string") {
    if (hasId && ("result" in message || "error" in message)) {
      // A response to a server-initiated request; the broker sends none.
      return undefined;
    }
    return errorResponse(id, JSONRPC_INVALID_REQUEST, "Invalid Request: method must be a string.");
  }
  if (!hasId) {
    // Notifications (notifications/initialized, notifications/cancelled, ...)
    // never get a response.
    return undefined;
  }
  const params = message["params"];
  if (params !== undefined && !isRecord(params)) {
    return errorResponse(id, JSONRPC_INVALID_PARAMS, "Invalid params: params must be an object.");
  }

  switch (method) {
    case "initialize": {
      if (params === undefined || typeof params["protocolVersion"] !== "string") {
        return errorResponse(id, JSONRPC_INVALID_PARAMS, "Invalid params: initialize requires protocolVersion.");
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(params["protocolVersion"]),
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Search backend tools with mcp_search_tools, read one schema with mcp_inspect_schema, then call it with mcp_call_tool.",
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: listMetaTools() } };
    case "tools/call": {
      const name = params?.["name"];
      if (typeof name !== "string" || !(META_TOOL_NAMES as readonly string[]).includes(name)) {
        return errorResponse(id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${String(name)}`);
      }
      const args = params?.["arguments"] ?? {};
      if (!isRecord(args)) {
        return errorResponse(id, JSONRPC_INVALID_PARAMS, "Invalid params: arguments must be an object.");
      }
      try {
        const payload = await runMetaTool(name, args, ctx);
        if (name === "mcp_call_tool" && isRecord(payload) && isBackendCallResult(payload["result"])) {
          // Pass the backend's CallToolResult through unchanged (text, images,
          // structuredContent, and its own isError flag).
          return { jsonrpc: "2.0", id, result: payload["result"] };
        }
        return { jsonrpc: "2.0", id, result: textResult(payload, false) };
      } catch (error) {
        // Tool execution failures are reported in-band (isError) per MCP so
        // the calling model can read and react to them.
        const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : "TOOL_ERROR";
        const detail = error instanceof Error ? error.message : String(error);
        return { jsonrpc: "2.0", id, result: textResult({ error: code, message: detail }, true) };
      }
    }
    default:
      return errorResponse(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** Parses one stdin line and handles it; parse failures yield -32700. */
export async function handleLine(line: string, ctx: ServerContext): Promise<JsonRpcResponse | undefined> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return errorResponse(null, JSONRPC_PARSE_ERROR, "Parse error: invalid JSON.");
  }
  if (Array.isArray(message)) {
    return errorResponse(null, JSONRPC_INVALID_REQUEST, "Invalid Request: JSON-RPC batches are not supported.");
  }
  return handleMessage(message, ctx);
}

export function roleFromEnv(env: Record<string, string | undefined> = process.env): BrokerRole {
  const raw = env["HERETEK_BROKER_ROLE"];
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_SERVER_ROLE;
  }
  if (!(BROKER_ROLES as readonly string[]).includes(raw)) {
    throw new Error(`HERETEK_BROKER_ROLE "${raw}" is not one of: ${BROKER_ROLES.join(", ")}. Failing closed.`);
  }
  return raw as BrokerRole;
}

function logDiscovery(reports: DiscoveryReport[]): void {
  for (const report of reports) {
    const status = report.ok ? `discovered ${report.toolCount} tools` : `kept ${report.toolCount} seed tools (${report.error})`;
    process.stderr.write(`[heretek-lazy-broker] ${report.server}: ${status}\n`);
  }
}

export interface StdioServerOptions {
  input?: ReadableStream<Uint8Array>;
  write?: (line: string) => void;
  env?: Record<string, string | undefined>;
}

/**
 * Starts the broker: wires every backend through agentgateway (unless
 * HERETEK_BROKER_OFFLINE=1), kicks off catalog discovery in the background,
 * and serves MCP over stdio until stdin closes.
 */
export async function runStdioServer(options: StdioServerOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const role = roleFromEnv(env);
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const input = options.input ?? (Bun.stdin.stream() as ReadableStream<Uint8Array>);

  let registration: GatewayRegistration | undefined;
  let lastDiscoveryMs = 0;
  let discovering: Promise<void> | undefined;
  const ttlMs = Number(env["HERETEK_DISCOVERY_TTL_MS"] ?? 300_000);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`HERETEK_DISCOVERY_TTL_MS must be a positive number. Failing closed.`);
  }
  const discover = (): void => {
    if (registration === undefined || discovering !== undefined) {
      return;
    }
    lastDiscoveryMs = Date.now();
    discovering = refreshCatalog()
      .then(logDiscovery)
      .finally(() => {
        discovering = undefined;
      });
  };
  if (env["HERETEK_BROKER_OFFLINE"] !== "1") {
    registration = registerGatewayBackends({ ...gatewayOptionsFromEnv(env), role });
    discover();
  }
  const ctx: ServerContext = {
    role,
    beforeSearch: () => {
      if (Date.now() - lastDiscoveryMs > ttlMs) {
        discover();
      }
    },
  };

  const pending = new Set<Promise<void>>();
  const dispatch = (line: string): void => {
    const task = handleLine(line, ctx)
      .catch((error: unknown): JsonRpcResponse => {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[heretek-lazy-broker] internal error: ${detail}\n`);
        return errorResponse(null, JSONRPC_INTERNAL_ERROR, `Internal error: ${detail}`);
      })
      .then((response) => {
        if (response !== undefined) {
          write(`${JSON.stringify(response)}\n`);
        }
      });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const reader = input.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value !== undefined) {
      buffer += decoder.decode(value, { stream: !done });
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        dispatch(line);
      }
      newline = buffer.indexOf("\n");
    }
    if (done) {
      break;
    }
  }
  if (buffer.trim().length > 0) {
    dispatch(buffer);
  }
  await Promise.all(pending);
  if (registration !== undefined) {
    for (const failure of await registration.close()) {
      process.stderr.write(`[heretek-lazy-broker] session close failed: ${failure}\n`);
    }
  }
}

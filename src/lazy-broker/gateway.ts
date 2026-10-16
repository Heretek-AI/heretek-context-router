/**
 * gateway.ts — Wires every backend in ROUTING_TABLE to agentgateway over the
 * MCP Streamable HTTP transport.
 *
 * Two layouts are supported (HERETEK_GATEWAY_MODE):
 *
 * - "per-target" (default): one agentgateway route per backend at
 *   `${gateway}/mcp/<target>` holding a single MCP target, so the gateway
 *   forwards tool names unprefixed. Each backend gets its own MCP session,
 *   so one dead backend never blocks the others.
 * - "multiplexed": one route at `${gateway}/mcp` holding every target;
 *   agentgateway exposes tools as `<target>_<tool>`, which is exactly the
 *   broker's catalog name, so calls send the catalog name as-is.
 */

import {
  DEFAULT_GATEWAY_URL,
  GATEWAY_NAME_DELIMITER,
  backendServers,
  endpointFor,
  multiplexedUrl,
  targetUrl,
} from "./backends.ts";
import {
  StreamableHttpMcpClient,
  type FetchLike,
  type McpToolDescriptor,
} from "./http-transport.ts";
import {
  registerBackendDiscovery,
  registerBackendTransport,
  type BrokerRole,
} from "./meta-router-mcp.ts";

export type GatewayMode = "per-target" | "multiplexed";

export interface GatewayOptions {
  gatewayUrl: string;
  mode: GatewayMode;
  /** Role forwarded to the gateway as `x-heretek-role` for its own policy. */
  role?: BrokerRole;
  /** Bearer token for the gateway (HERETEK_GATEWAY_TOKEN). */
  token?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  /** Backends to wire (default: every backend in ROUTING_TABLE). */
  servers?: string[];
}

/** Reads gateway settings from the environment. */
export function gatewayOptionsFromEnv(env: Record<string, string | undefined> = process.env): GatewayOptions {
  const gatewayUrl = env["HERETEK_GATEWAY_URL"] ?? DEFAULT_GATEWAY_URL;
  if (!/^https?:\/\//.test(gatewayUrl)) {
    throw new Error(`HERETEK_GATEWAY_URL must be an http(s) URL, got "${gatewayUrl}". Failing closed.`);
  }
  const rawMode = env["HERETEK_GATEWAY_MODE"] ?? "per-target";
  if (rawMode !== "per-target" && rawMode !== "multiplexed") {
    throw new Error(`HERETEK_GATEWAY_MODE must be "per-target" or "multiplexed", got "${rawMode}". Failing closed.`);
  }
  const rawTimeout = env["HERETEK_GATEWAY_TIMEOUT_MS"];
  let timeoutMs: number | undefined;
  if (rawTimeout !== undefined) {
    timeoutMs = Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`HERETEK_GATEWAY_TIMEOUT_MS must be a positive integer, got "${rawTimeout}". Failing closed.`);
    }
  }
  const token = env["HERETEK_GATEWAY_TOKEN"];
  return {
    gatewayUrl,
    mode: rawMode,
    ...(token !== undefined && token.length > 0 ? { token } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function headersFor(options: GatewayOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.role !== undefined) {
    headers["x-heretek-role"] = options.role;
  }
  if (options.token !== undefined) {
    headers["authorization"] = `Bearer ${options.token}`;
  }
  return headers;
}

/** Per-backend MCP clients created by registerGatewayBackends. */
export interface GatewayRegistration {
  mode: GatewayMode;
  clients: Map<string, StreamableHttpMcpClient>;
  /** Ends every MCP session; resolves to the failure messages (if any). */
  close(): Promise<string[]>;
}

/**
 * Registers a live transport and a discovery source for every backend,
 * routed through agentgateway. Returns the clients so callers can close the
 * MCP sessions on shutdown.
 */
export function registerGatewayBackends(options: GatewayOptions): GatewayRegistration {
  const servers = options.servers ?? backendServers();
  const clients = new Map<string, StreamableHttpMcpClient>();
  const clientOptions = {
    headers: headersFor(options),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  };

  if (options.mode === "per-target") {
    for (const server of servers) {
      const client = new StreamableHttpMcpClient({ url: targetUrl(options.gatewayUrl, server), ...clientOptions });
      clients.set(server, client);
      registerBackendTransport(server, (tool, args) => client.callTool(tool.remoteName, args));
      registerBackendDiscovery(server, () => client.listTools());
    }
  } else {
    const client = new StreamableHttpMcpClient({ url: multiplexedUrl(options.gatewayUrl), ...clientOptions });
    // One multiplexed tools/list serves every backend's discovery in a refresh.
    let shared: { at: number; list: Promise<McpToolDescriptor[]> } | undefined;
    const listAll = (): Promise<McpToolDescriptor[]> => {
      const now = Date.now();
      if (shared === undefined || now - shared.at > 5_000) {
        shared = { at: now, list: client.listTools() };
        shared.list.catch(() => {
          shared = undefined;
        });
      }
      return shared.list;
    };
    for (const server of servers) {
      clients.set(server, client);
      const prefix = `${endpointFor(server).target}${GATEWAY_NAME_DELIMITER}`;
      registerBackendTransport(server, (tool, args) => client.callTool(tool.name, args));
      registerBackendDiscovery(server, async () =>
        (await listAll())
          .filter((tool) => tool.name.startsWith(prefix) && tool.name.length > prefix.length)
          .map((tool) => ({ ...tool, name: tool.name.slice(prefix.length) })),
      );
    }
  }

  return {
    mode: options.mode,
    clients,
    async close(): Promise<string[]> {
      const unique = [...new Set(clients.values())];
      const results = await Promise.allSettled(unique.map((c) => c.close()));
      return results.flatMap((r, i) =>
        r.status === "rejected"
          ? [`${unique[i]?.url}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`]
          : [],
      );
    },
  };
}

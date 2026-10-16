/**
 * backends.ts — Backend registry for the lazy broker.
 *
 * Every domain MCP backend sits behind agentgateway. The broker reaches each
 * one through its own agentgateway route, `${gateway}/mcp/<target>`, where
 * the route holds exactly ONE MCP target, so agentgateway forwards tool names
 * unprefixed. The broker's catalog names follow agentgateway's multiplexing
 * convention `<target>_<tool>` (agentgateway joins target and tool with a
 * single `_` and splits on the first one), so a catalog name is also valid
 * against a multiplexed agentgateway endpoint that serves all targets on one
 * route. Target names therefore must not contain `_`.
 *
 * The canonical deployed gateway config is owned by heretek-devcontainers
 * (compose/agentgateway.yaml); its target names and route paths must match
 * the `target` values below.
 */

import type { BrokerProfile } from "./bm25-catalog.ts";

export interface BackendEndpoint {
  /** agentgateway MCP target name (also the catalog name prefix). */
  target: string;
  /** Heretek Compose profile that ships this backend. */
  profile: BrokerProfile;
}

/** Separator agentgateway uses between target and tool when multiplexing. */
export const GATEWAY_NAME_DELIMITER = "_";

export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3000";

/** Backend MCP server id -> agentgateway target. */
export const ROUTING_TABLE: Readonly<Record<string, BackendEndpoint>> = Object.freeze({
  "heretek-core": { target: "core", profile: "core" },
  "ghidra-mcp": { target: "ghidra", profile: "appsec" },
  "radare2-mcp": { target: "radare2", profile: "appsec" },
  "morluto/rea": { target: "rea", profile: "appsec" },
  "mdb-mcp": { target: "mdb", profile: "appsec" },
  "iksnerd/adb-mcp": { target: "adb", profile: "android" },
  maestro: { target: "maestro", profile: "android" },
  "godot-mcp": { target: "godot", profile: "game" },
  "blender-mcp": { target: "blender", profile: "game" },
  crawl4ai: { target: "crawl4ai", profile: "research" },
  searxng: { target: "searxng", profile: "research" },
  "computer-use-linux": { target: "gui", profile: "research" },
});

for (const [server, endpoint] of Object.entries(ROUTING_TABLE)) {
  if (!/^[a-z0-9-]+$/.test(endpoint.target)) {
    throw new Error(`Backend "${server}" has invalid gateway target "${endpoint.target}". Failing closed.`);
  }
}

export function backendServers(): string[] {
  return Object.keys(ROUTING_TABLE);
}

export function endpointFor(server: string): BackendEndpoint {
  const endpoint = ROUTING_TABLE[server];
  if (endpoint === undefined) {
    throw new Error(`No route for backend server "${server}". Failing closed.`);
  }
  return endpoint;
}

/** Catalog name for a backend tool: `<target>_<remoteName>`. */
export function catalogToolName(server: string, remoteName: string): string {
  if (remoteName.length === 0) {
    throw new Error(`Backend "${server}" exposed an empty tool name. Failing closed.`);
  }
  return `${endpointFor(server).target}${GATEWAY_NAME_DELIMITER}${remoteName}`;
}

/** Remote (upstream) tool name from a catalog name owned by `server`. */
export function remoteToolName(server: string, catalogName: string): string {
  const prefix = `${endpointFor(server).target}${GATEWAY_NAME_DELIMITER}`;
  if (!catalogName.startsWith(prefix) || catalogName.length === prefix.length) {
    throw new Error(
      `Tool "${catalogName}" does not carry the "${prefix}" prefix of backend "${server}". Failing closed.`,
    );
  }
  return catalogName.slice(prefix.length);
}

/** Drops trailing slashes without a regex, so a hostile URL stays linear. */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

/** Per-target MCP endpoint on the gateway: `${gateway}/mcp/<target>`. */
export function targetUrl(gatewayUrl: string, server: string): string {
  return `${stripTrailingSlashes(gatewayUrl)}/mcp/${endpointFor(server).target}`;
}

/** Multiplexed MCP endpoint on the gateway (all targets, prefixed names). */
export function multiplexedUrl(gatewayUrl: string): string {
  return `${stripTrailingSlashes(gatewayUrl)}/mcp`;
}

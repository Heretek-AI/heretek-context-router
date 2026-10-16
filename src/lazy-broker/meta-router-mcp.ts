#!/usr/bin/env bun
/**
 * meta-router-mcp.ts — Lazy meta-tool discovery broker.
 *
 * Exposes EXACTLY 3 meta-tools in its tools/list surface so the upfront
 * schema token footprint stays under 500 tokens (target under 400), while
 * the full backend catalog (30+ domain tools across 5 profiles) is
 * discoverable lazily:
 *
 *   1. mcp_search_tools({ query, profile?, limit? }) — top-K names/profiles/
 *      one-line summaries, never full schemas.
 *   2. mcp_inspect_schema({ toolName }) — full inputSchema for one tool.
 *   3. mcp_call_tool({ toolName, args }) — circuit breaker (opens 60s after
 *      3 consecutive failures) + CEL-style role authorization
 *      (qa-adversary and director cannot call mutating tools) + routing to
 *      the target backend over a registered transport (fail-closed when the
 *      backend is unreachable).
 *
 * Run directly (`bun src/lazy-broker/meta-router-mcp.ts`, or the
 * `heretek-lazy-broker` package bin) it serves MCP over stdio, wires every
 * backend through agentgateway's Streamable HTTP endpoint
 * (HERETEK_GATEWAY_URL, default http://127.0.0.1:3000) and replaces the
 * offline seed catalog with each backend's live tools/list.
 */

import {
  assertValidBrokerProfile,
  createDefaultCatalog,
  parseInputSchema,
  type BackendToolDef,
  type BrokerProfile,
  type RankedTool,
  type ToolCatalog,
} from "./bm25-catalog.ts";
import { ROUTING_TABLE, catalogToolName, endpointFor, type BackendEndpoint } from "./backends.ts";
import type { McpToolDescriptor } from "./http-transport.ts";

export { ROUTING_TABLE, type BackendEndpoint };

export const META_TOOL_NAMES = ["mcp_search_tools", "mcp_inspect_schema", "mcp_call_tool"] as const;

export type MetaToolName = (typeof META_TOOL_NAMES)[number];

export interface MetaToolInputSchema {
  type: "object";
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

export interface MetaToolDef {
  name: MetaToolName;
  description: string;
  inputSchema: MetaToolInputSchema;
}

export type BrokerRole =
  | "director"
  | "architect"
  | "manager"
  | "staff-backend"
  | "staff-ui"
  | "qa-adversary";

const ALL_BROKER_ROLES: readonly BrokerRole[] = [
  "director",
  "architect",
  "manager",
  "staff-backend",
  "staff-ui",
  "qa-adversary",
] as const;

/** Roles denied mutating backend calls (read-only observers / planners). */
const READ_ONLY_ROLES: readonly BrokerRole[] = ["director", "qa-adversary"] as const;

export const CIRCUIT_FAILURE_THRESHOLD = 3;
export const CIRCUIT_OPEN_MS = 60_000;

export type BackendTransport = (
  tool: BackendToolDef,
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

/** Lists a backend's live tools (MCP tools/list) for catalog discovery. */
export type BackendDiscovery = () => Promise<McpToolDescriptor[]>;

export class UnknownToolError extends Error {
  readonly code = "UNKNOWN_TOOL";
}

export class AuthorizationError extends Error {
  readonly code = "AUTHORIZATION_DENIED";
}

export class CircuitOpenError extends Error {
  readonly code = "CIRCUIT_OPEN";
}

export class BackendUnreachableError extends Error {
  readonly code = "BACKEND_UNREACHABLE";
}

export class ValidationError extends Error {
  readonly code = "VALIDATION_FAILED";
}

interface BreakerState {
  consecutiveFailures: number;
  openUntilMs: number;
}

let defaultCatalog: ToolCatalog | undefined;
const transports = new Map<string, BackendTransport>();
const discoveries = new Map<string, BackendDiscovery>();
const breakers = new Map<string, BreakerState>();

/** Singleton default catalog seeded with all backend tools. */
export function getDefaultCatalog(): ToolCatalog {
  if (defaultCatalog === undefined) {
    defaultCatalog = createDefaultCatalog();
  }
  return defaultCatalog;
}

/** Returns exactly the 3 meta-tool definitions exposed in tools/list. */
export function listMetaTools(): MetaToolDef[] {
  return [
    {
      name: "mcp_search_tools",
      description: "Search backend MCP tools by keywords. Returns names and summaries.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords, e.g. android adb." },
          profile: { type: "string", description: "Profile filter: core, appsec, android, game, research." },
          limit: { type: "number", description: "Max results, 1-25. Default 5." },
        },
        required: ["query"],
      },
    },
    {
      name: "mcp_inspect_schema",
      description: "Return the full input schema for one backend tool.",
      inputSchema: {
        type: "object",
        properties: {
          toolName: { type: "string", description: "Backend tool name." },
        },
        required: ["toolName"],
      },
    },
    {
      name: "mcp_call_tool",
      description: "Call a backend tool after auth and breaker checks.",
      inputSchema: {
        type: "object",
        properties: {
          toolName: { type: "string", description: "Backend tool name." },
          args: { type: "object", description: "Arguments matching its schema." },
        },
        required: ["toolName", "args"],
      },
    },
  ];
}

/**
 * Estimated schema token footprint of the tools/list surface.
 * Heuristic: 1 token ~= 4 characters of the canonical JSON encoding.
 */
export function estimateTokenCount(): number {
  const encoded = JSON.stringify(listMetaTools());
  return Math.ceil(encoded.length / 4);
}

export interface SearchToolsInput {
  query: string;
  profile?: string;
  limit?: number;
}

export interface ToolSummary {
  name: string;
  profile: BrokerProfile;
  server: string;
  summary: string;
}

function toSummary(hit: RankedTool): ToolSummary {
  return { name: hit.name, profile: hit.profile, server: hit.server, summary: hit.summary };
}

/** Lazy discovery: top-K tool names/profiles/summaries, never full schemas. */
export function searchTools(input: SearchToolsInput, catalog: ToolCatalog = getDefaultCatalog()): ToolSummary[] {
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new ValidationError("searchTools: query must be a non-empty string.");
  }
  if (input.profile !== undefined) {
    if (typeof input.profile !== "string") {
      throw new ValidationError("searchTools: profile must be a string.");
    }
    assertValidBrokerProfile(input.profile);
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 25)) {
    throw new ValidationError("searchTools: limit must be an integer in 1..25.");
  }
  return catalog
    .search(input.query, { profile: input.profile, limit: input.limit })
    .map(toSummary);
}

/** Returns the full inputSchema object for a single backend tool. */
export function inspectToolSchema(
  toolName: string,
  catalog: ToolCatalog = getDefaultCatalog(),
): Record<string, unknown> {
  if (typeof toolName !== "string" || toolName.length === 0) {
    throw new ValidationError("inspectToolSchema: toolName must be a non-empty string.");
  }
  if (!catalog.hasTool(toolName)) {
    throw new UnknownToolError(`Unknown backend tool "${toolName}".`);
  }
  return parseInputSchema(catalog.getTool(toolName));
}

function assertValidBrokerRole(role: string): asserts role is BrokerRole {
  if (!(ALL_BROKER_ROLES as readonly string[]).includes(role)) {
    throw new ValidationError(
      `Unknown role "${role}". Expected one of: ${ALL_BROKER_ROLES.join(", ")}.`,
    );
  }
}

/** True when the named backend tool mutates external state. */
export function isMutatingTool(toolName: string, catalog: ToolCatalog = getDefaultCatalog()): boolean {
  if (!catalog.hasTool(toolName)) {
    throw new UnknownToolError(`Unknown backend tool "${toolName}".`);
  }
  return catalog.getTool(toolName).mutating;
}

/**
 * CEL-style role authorization: qa-adversary and director are read-only
 * observers/planners and cannot invoke mutating backend tools.
 */
export function authorizeCall(
  role: BrokerRole,
  toolName: string,
  catalog: ToolCatalog = getDefaultCatalog(),
): void {
  assertValidBrokerRole(role);
  const mutating = isMutatingTool(toolName, catalog);
  if (mutating && (READ_ONLY_ROLES as readonly string[]).includes(role)) {
    throw new AuthorizationError(
      `Role "${role}" is denied mutating tool "${toolName}" (read-only role).`,
    );
  }
}

/** Registers the in-process transport used to reach a backend server. */
export function registerBackendTransport(server: string, transport: BackendTransport): void {
  if (typeof server !== "string" || server.length === 0) {
    throw new ValidationError("registerBackendTransport: server must be a non-empty string.");
  }
  if (typeof transport !== "function") {
    throw new ValidationError("registerBackendTransport: transport must be a function.");
  }
  transports.set(server, transport);
}

export function unregisterBackendTransport(server: string): void {
  transports.delete(server);
}

export function hasBackendTransport(server: string): boolean {
  return transports.has(server);
}

function breakerFor(toolName: string): BreakerState {
  let state = breakers.get(toolName);
  if (state === undefined) {
    state = { consecutiveFailures: 0, openUntilMs: 0 };
    breakers.set(toolName, state);
  }
  return state;
}

function recordSuccess(toolName: string): void {
  breakers.set(toolName, { consecutiveFailures: 0, openUntilMs: 0 });
}

function recordFailure(toolName: string, nowMs: number): void {
  const state = breakerFor(toolName);
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    state.openUntilMs = nowMs + CIRCUIT_OPEN_MS;
  }
}

/** Resets breaker state for one tool, or every tool when omitted. */
export function resetCircuitBreaker(toolName?: string): void {
  if (toolName === undefined) {
    breakers.clear();
    return;
  }
  breakers.delete(toolName);
}

/** Test hook: clears all registered backend transports and discoveries. */
export function clearBackendTransports(): void {
  transports.clear();
  discoveries.clear();
}

/** Registers the tools/list source used to discover a backend's tools. */
export function registerBackendDiscovery(server: string, discovery: BackendDiscovery): void {
  endpointFor(server);
  if (typeof discovery !== "function") {
    throw new ValidationError("registerBackendDiscovery: discovery must be a function.");
  }
  discoveries.set(server, discovery);
}

/** Test hook: replaces the default catalog with a fresh offline seed catalog. */
export function resetDefaultCatalog(): void {
  defaultCatalog = createDefaultCatalog();
}

function oneLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/**
 * Converts a backend tools/list entry into a catalog definition. The tool
 * counts as mutating unless the backend annotates it `readOnlyHint: true`
 * (fail-closed: read-only roles may only call tools declared read-only).
 */
export function toolDefFromDescriptor(server: string, descriptor: McpToolDescriptor): BackendToolDef {
  const endpoint = endpointFor(server);
  if (typeof descriptor.name !== "string" || descriptor.name.length === 0) {
    throw new ValidationError(`Backend "${server}" listed a tool without a name.`);
  }
  const title = descriptor.title ?? descriptor.annotations?.title ?? "";
  const description =
    oneLine(descriptor.description ?? "") || oneLine(title) || `${descriptor.name} (${server})`;
  const schema = descriptor.inputSchema ?? { type: "object", properties: {} };
  if (!isPlainRecord(schema)) {
    throw new ValidationError(`Backend "${server}" tool "${descriptor.name}" has a non-object inputSchema.`);
  }
  const keywords = new Set<string>([endpoint.target, ...server.split(/[^a-zA-Z0-9]+/).filter((k) => k.length > 0)]);
  for (const word of title.split(/[^a-zA-Z0-9]+/)) {
    if (word.length > 0) {
      keywords.add(word.toLowerCase());
    }
  }
  return {
    server,
    profile: endpoint.profile,
    name: catalogToolName(server, descriptor.name),
    description,
    boostKeywords: [...keywords],
    inputSchemaJson: JSON.stringify(schema),
    mutating: descriptor.annotations?.readOnlyHint !== true,
    remoteName: descriptor.name,
    source: "discovered",
  };
}

export interface DiscoveryReport {
  server: string;
  ok: boolean;
  toolCount: number;
  error?: string;
}

export interface RefreshCatalogOptions {
  catalog?: ToolCatalog;
  /** Restrict discovery to these backend servers (default: all registered). */
  servers?: string[];
}

/**
 * Discovers live tools from every registered backend and upserts them into
 * the catalog. A backend whose discovery succeeds has its seed (or older
 * discovered) entries replaced wholesale; a backend that fails keeps its
 * current entries so search keeps working offline.
 */
export async function refreshCatalog(options: RefreshCatalogOptions = {}): Promise<DiscoveryReport[]> {
  const catalog = options.catalog ?? getDefaultCatalog();
  const servers = options.servers ?? [...discoveries.keys()];
  return Promise.all(
    servers.map(async (server): Promise<DiscoveryReport> => {
      const discovery = discoveries.get(server);
      if (discovery === undefined) {
        return { server, ok: false, toolCount: 0, error: "no discovery registered" };
      }
      try {
        const descriptors = await discovery();
        const definitions = descriptors.map((d) => toolDefFromDescriptor(server, d));
        catalog.replaceServerTools(server, definitions);
        return { server, ok: true, toolCount: definitions.length };
      } catch (error) {
        return {
          server,
          ok: false,
          toolCount: catalog.toolsForServer(server).length,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkSchemaArgs(schema: Record<string, unknown>, args: Record<string, unknown>, toolName: string): void {
  const required = schema["required"];
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((r) => typeof r === "string")) {
      throw new ValidationError(`Tool "${toolName}" schema has a corrupt required list.`);
    }
    for (const field of required as string[]) {
      if (!(field in args)) {
        throw new ValidationError(`Tool "${toolName}" call is missing required argument "${field}".`);
      }
    }
  }
  const properties = schema["properties"];
  if (properties !== undefined) {
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
      throw new ValidationError(`Tool "${toolName}" schema has corrupt properties.`);
    }
    for (const [field, declared] of Object.entries(properties as Record<string, unknown>)) {
      if (!(field in args) || typeof declared !== "object" || declared === null) {
        continue;
      }
      const expected = (declared as Record<string, unknown>)["type"];
      const actual = args[field];
      if (actual === undefined || actual === null) {
        continue;
      }
      const matches =
        (expected === "string" && typeof actual === "string") ||
        (expected === "number" && typeof actual === "number") ||
        (expected === "integer" && typeof actual === "number" && Number.isInteger(actual)) ||
        (expected === "boolean" && typeof actual === "boolean") ||
        (expected === "object" && typeof actual === "object" && !Array.isArray(actual)) ||
        (expected === "array" && Array.isArray(actual));
      if (!matches) {
        throw new ValidationError(
          `Tool "${toolName}" argument "${field}" must be of type ${String(expected)}.`,
        );
      }
    }
  }
}

export interface CallToolInput {
  toolName: string;
  args: Record<string, unknown>;
}

export interface CallToolOptions {
  role?: BrokerRole | string;
  nowMs?: number;
  catalog?: ToolCatalog;
}

export interface CallToolResult {
  ok: true;
  toolName: string;
  server: string;
  profile: BrokerProfile;
  result: unknown;
}

/**
 * Routes a backend tool call through breaker -> authorization -> argument
 * validation -> backend transport. Fails closed at every stage; backend
 * transport failures trip the per-tool circuit breaker.
 */
export async function callTool(input: CallToolInput, options: CallToolOptions = {}): Promise<CallToolResult> {
  const nowMs = options.nowMs ?? Date.now();
  const catalog = options.catalog ?? getDefaultCatalog();
  const role: BrokerRole = (options.role ?? "staff-backend") as BrokerRole;

  if (typeof input.toolName !== "string" || input.toolName.length === 0) {
    throw new ValidationError("callTool: toolName must be a non-empty string.");
  }
  if (!isPlainRecord(input.args)) {
    throw new ValidationError("callTool: args must be a plain object.");
  }
  if (!catalog.hasTool(input.toolName)) {
    throw new UnknownToolError(`Unknown backend tool "${input.toolName}".`);
  }

  const state = breakerFor(input.toolName);
  if (nowMs < state.openUntilMs) {
    throw new CircuitOpenError(
      `Circuit for tool "${input.toolName}" is open until ${new Date(state.openUntilMs).toISOString()} after ${state.consecutiveFailures} consecutive failures.`,
    );
  }

  assertValidBrokerRole(role);
  authorizeCall(role, input.toolName, catalog);

  const definition = catalog.getTool(input.toolName);
  checkSchemaArgs(parseInputSchema(definition), input.args, input.toolName);

  const endpoint: BackendEndpoint | undefined = ROUTING_TABLE[definition.server];
  if (endpoint === undefined) {
    recordFailure(input.toolName, nowMs);
    throw new BackendUnreachableError(
      `No route for backend server "${definition.server}" (tool "${input.toolName}").`,
    );
  }
  const transport = transports.get(definition.server);
  if (transport === undefined) {
    recordFailure(input.toolName, nowMs);
    throw new BackendUnreachableError(
      `Backend "${definition.server}" (gateway target "${endpoint.target}") unreachable: no live transport registered for tool "${input.toolName}".`,
    );
  }
  let result: unknown;
  try {
    result = await transport(definition, input.args);
  } catch (error) {
    recordFailure(input.toolName, nowMs);
    const detail = error instanceof Error ? error.message : String(error);
    throw new BackendUnreachableError(
      `Backend "${definition.server}" call to "${input.toolName}" failed: ${detail}`,
    );
  }
  recordSuccess(input.toolName);
  return {
    ok: true,
    toolName: definition.name,
    server: definition.server,
    profile: definition.profile,
    result,
  };
}

if (import.meta.main) {
  const { runStdioServer } = await import("./mcp-server.ts");
  try {
    await runStdioServer();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[heretek-lazy-broker] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

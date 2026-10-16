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

export interface BackendEndpoint {
  transport: "stdio";
  command: string;
}

/**
 * Static routing table: backend MCP server -> launch endpoint.
 * A live call additionally requires a registered in-process transport
 * (registerBackendTransport); without one the router fails closed with
 * BackendUnreachableError instead of silently dropping the call.
 */
export const ROUTING_TABLE: Record<string, BackendEndpoint> = {
  "heretek-core": { transport: "stdio", command: "heretek-core-mcp" },
  "ghidra-mcp": { transport: "stdio", command: "ghidra-mcp" },
  "radare2-mcp": { transport: "stdio", command: "radare2-mcp" },
  "morluto/rea": { transport: "stdio", command: "rea-mcp" },
  "iksnerd/adb-mcp": { transport: "stdio", command: "adb-mcp" },
  maestro: { transport: "stdio", command: "maestro-mcp" },
  "godot-mcp": { transport: "stdio", command: "godot-mcp" },
  "blender-mcp": { transport: "stdio", command: "blender-mcp" },
  crawl4ai: { transport: "stdio", command: "crawl4ai-mcp" },
  searxng: { transport: "stdio", command: "searxng-mcp" },
  "computer-use-linux": { transport: "stdio", command: "computer-use-mcp" },
};

export type BackendTransport = (
  tool: BackendToolDef,
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

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

/** Test hook: clears all registered backend transports. */
export function clearBackendTransports(): void {
  transports.clear();
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

  const endpoint = ROUTING_TABLE[definition.server];
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
      `Backend "${definition.server}" unreachable via ${endpoint.transport}:${endpoint.command} (no live transport registered for tool "${input.toolName}").`,
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

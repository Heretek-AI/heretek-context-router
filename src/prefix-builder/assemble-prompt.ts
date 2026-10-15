import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskBrief, ToolboxProfile } from "../handoff/envelopes.ts";

export type RoleId =
  | "director"
  | "architect"
  | "manager"
  | "staff-backend"
  | "staff-ui"
  | "qa-adversary";

export const ALL_ROLES: readonly RoleId[] = [
  "director",
  "architect",
  "manager",
  "staff-backend",
  "staff-ui",
  "qa-adversary",
] as const;

const ROLE_FILES: Record<RoleId, string> = {
  director: "director.md",
  architect: "architect.md",
  manager: "manager.md",
  "staff-backend": "staff-backend.md",
  "staff-ui": "staff-ui.md",
  "qa-adversary": "qa-adversary.md",
};

export function assertValidRole(role: string): asserts role is RoleId {
  if (!(role in ROLE_FILES)) {
    throw new Error(
      `Unknown role "${role}". Expected one of: ${ALL_ROLES.join(", ")}.`,
    );
  }
}

/**
 * Layer 1: Static Base Engine Invariant. A compile-time constant occupying
 * bytes 0..B1 of every assembled prompt. It contains no timestamps, no
 * UUIDs, no random nonces, and no per-task state, so the provider KV cache
 * for the frozen prefix survives role switches.
 */
export const BASE_ENGINE_INVARIANT: string = [
  "# Heretek Context Router -- Base Engine Invariant (Layer 1)",
  "",
  "Execution substrate: POSIX/Linux. Paths are forward-slash, workspace-relative.",
  "Package manager: bun. Install with `bun install`, test with `bun test`,",
  "typecheck with `bun run check` (`tsc --noEmit`, strict mode).",
  "",
  "Zero-stubs mandate: implement every interface, function, route, schema,",
  "and test with exact logic. Placeholders, skeleton files, deferred work,",
  "dummy passes, swallowed errors, and mock fallbacks are rejected fail-closed.",
  "",
  "Static superset tool protocol: every role speaks one fixed tool surface.",
  "Tool definitions are canonicalized per RFC 8785 JCS (tools sorted by name,",
  "object keys sorted recursively) so definitions are deterministic across turns.",
  "Role capability differences are enforced at execution time by the permission",
  "matrix and the lazy broker authorization gate, never by mutating this prefix.",
  "",
  "Fail-closed discipline: invalid states are rejected immediately with a",
  "descriptive domain error. Permissive defaults are forbidden.",
  "",
  "End of Layer 1. Layer 2 (shared architectural invariants) follows verbatim.",
  "",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalizeValue(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Sorts tools alphabetically by `name` and recursively sorts all JSON
 * object keys lexicographically (RFC 8785 JCS) so tool definitions are
 * fully deterministic across turns and machines.
 */
export function canonicalizeToolSchemas(
  tools: Array<Record<string, unknown>>,
): string {
  const sorted = [...tools].sort((a, b) => {
    const nameA = typeof a["name"] === "string" ? (a["name"] as string) : "";
    const nameB = typeof b["name"] === "string" ? (b["name"] as string) : "";
    if (nameA < nameB) return -1;
    if (nameA > nameB) return 1;
    return 0;
  });
  return JSON.stringify(sorted.map(canonicalizeValue));
}

function resolveRolesDir(workspaceRoot: string): string {
  const primary = join(workspaceRoot, "roles");
  if (existsSync(join(primary, "00-shared-context.md"))) {
    return primary;
  }
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const fallback = join(moduleDir, "..", "..", "roles");
  if (existsSync(join(fallback, "00-shared-context.md"))) {
    return fallback;
  }
  throw new Error(
    `Role prompt directory not found. Looked in "${primary}" (from workspaceRoot) ` +
      `and "${fallback}" (module-relative). Provide a workspaceRoot containing roles/.`,
  );
}

function loadRoleText(rolesDir: string, fileName: string): string {
  const full = join(rolesDir, fileName);
  if (!existsSync(full)) {
    throw new Error(`Role prompt file not found: "${full}". Failing closed.`);
  }
  return readFileSync(full, "utf8");
}

export interface AssembleOptions {
  role: RoleId;
  workspaceRoot: string;
  taskBrief?: TaskBrief;
  activeProfile?: ToolboxProfile;
}

export interface AssembledPrompt {
  systemPrompt: string;
  frozenPrefixBytes: number;
  cacheBreakpoints: [number, number];
}

/**
 * Assembles the cache-stable system prompt. Layer 1 (bytes 0..B1) is the
 * static base invariant, Layer 2 (bytes B1..B2) is the verbatim contents of
 * `roles/00-shared-context.md`, and Layer 3 (bytes B2..end) carries the
 * role suffix plus mutation scope and toolbox profile. The frozen prefix
 * (bytes 0..frozenPrefixBytes) is identical for every role by construction.
 */
export function assemblePrefixCachedPrompt(
  options: AssembleOptions,
): AssembledPrompt {
  assertValidRole(options.role);
  if (typeof options.workspaceRoot !== "string" || options.workspaceRoot.length === 0) {
    throw new Error("workspaceRoot must be a non-empty string. Failing closed.");
  }
  const profile: ToolboxProfile = options.activeProfile ?? "core";
  if (!["core", "appsec", "android", "game", "research"].includes(profile)) {
    throw new Error(
      `Unknown toolbox profile "${String(profile)}". Expected one of: core, appsec, android, game, research.`,
    );
  }

  const rolesDir = resolveRolesDir(options.workspaceRoot);
  const layer1 = BASE_ENGINE_INVARIANT;
  const layer2 = loadRoleText(rolesDir, "00-shared-context.md");
  const roleBody = loadRoleText(rolesDir, ROLE_FILES[options.role]);

  const ownedPaths =
    options.taskBrief && options.taskBrief.ownedPaths.length > 0
      ? options.taskBrief.ownedPaths.join(", ")
      : "NONE";

  const layer3 = [
    roleBody.endsWith("\n") ? roleBody : roleBody + "\n",
    "",
    `Authorized Mutation Scope: ${ownedPaths}`,
    `Active Toolbox Profile: ${profile}`,
    "",
  ].join("\n");

  const systemPrompt = layer1 + layer2 + layer3;
  const b1 = Buffer.byteLength(layer1, "utf8");
  const b2 = b1 + Buffer.byteLength(layer2, "utf8");

  return {
    systemPrompt,
    frozenPrefixBytes: b2,
    cacheBreakpoints: [b1, b2],
  };
}

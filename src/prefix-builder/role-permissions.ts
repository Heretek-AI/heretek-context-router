import type { RoleId } from "./assemble-prompt.ts";

export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionRule {
  match: string;
  effect: PermissionEffect;
  description: string;
}

/**
 * Matches an OpenCode v2 tool-call address of the form `<tool>` or
 * `<tool>:<path>` against a rule glob supporting `*` (any run within an
 * address, slashes included), `**` (any run across segments), and `?`
 * (single character). Matching is case-sensitive over the full address string.
 */
export function matchRulePattern(pattern: string, address: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          regex += "(?:.*/)?";
        }
      } else {
        regex += "[^:]*";
      }
    } else if (ch === "?") {
      regex += "[^:]";
    } else {
      regex += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  regex += "$";
  return new RegExp(regex).test(address);
}

/**
 * Evaluates the permission matrix for a role under OpenCode v2
 * last-match-wins semantics: rules are scanned in order and the LAST rule
 * whose `match` glob matches the address decides. Addresses that match no
 * rule are denied fail-closed. `ask` resolves to denied for non-interactive
 * execution (fail-closed); callers that can prompt may treat it as a
 * checkpoint before proceeding.
 */
export function evaluatePermission(
  role: RoleId,
  address: string,
): PermissionEffect {
  const rules = ROLE_PERMISSION_MATRIX[role];
  if (rules === undefined) {
    throw new Error(`Unknown role "${role}". Failing closed.`);
  }
  let decision: PermissionEffect = "deny";
  for (const rule of rules) {
    if (matchRulePattern(rule.match, address)) {
      decision = rule.effect;
    }
  }
  return decision;
}

/**
 * Exact OpenCode v2 last-match-wins permission ruleset for the six roles.
 * Broad baseline rules come first; narrow terminal rules come last so they
 * win. Tool-call addresses use `<tool>` or `<tool>:<path>` form, e.g.
 * `edit:src/prefix-builder/assemble-prompt.ts` or `bash:bun test`.
 */
export const ROLE_PERMISSION_MATRIX: Record<RoleId, PermissionRule[]> = {
  director: [
    { match: "read:*", effect: "allow", description: "Director may read any workspace path for planning." },
    { match: "read", effect: "allow", description: "Director may issue bare reads." },
    { match: "glob:*", effect: "allow", description: "Director may glob the workspace for discovery." },
    { match: "grep:*", effect: "allow", description: "Director may search workspace content." },
    { match: "mcp_search_tools", effect: "allow", description: "Director may discover lazy tools." },
    { match: "mcp_inspect_schema", effect: "allow", description: "Director may inspect a single tool schema." },
    { match: "mcp_call_tool:read*", effect: "allow", description: "Director may route read-only tool calls." },
    { match: "task dispatch", effect: "allow", description: "Director may dispatch typed task briefs." },
    { match: "edit:*", effect: "deny", description: "Director never edits files directly; mutations flow through dispatched briefs." },
    { match: "edit", effect: "deny", description: "Director bare edit is denied." },
    { match: "write:*", effect: "deny", description: "Director never writes files directly." },
    { match: "write", effect: "deny", description: "Director bare write is denied." },
    { match: "bash:mutate*", effect: "deny", description: "Director may not run mutating shell operations." },
    { match: "mcp_call_tool:mutate*", effect: "deny", description: "Director may not route mutating tool calls." },
  ],
  architect: [
    { match: "read:*", effect: "allow", description: "Architect may read the full workspace to design stable contracts." },
    { match: "read", effect: "allow", description: "Architect may issue bare reads." },
    { match: "glob:*", effect: "allow", description: "Architect may glob the workspace." },
    { match: "grep:*", effect: "allow", description: "Architect may search workspace content." },
    { match: "mcp_search_tools", effect: "allow", description: "Architect may discover lazy tools." },
    { match: "mcp_inspect_schema", effect: "allow", description: "Architect may inspect a single tool schema." },
    { match: "bash:bun test*", effect: "allow", description: "Architect may run contract conformance tests." },
    { match: "bash:bun run check*", effect: "allow", description: "Architect may run the type checker." },
    { match: "edit:*", effect: "deny", description: "Architect baseline: no edits outside contract trees." },
    { match: "write:*", effect: "deny", description: "Architect baseline: no writes outside contract trees." },
    { match: "edit:contracts/**", effect: "allow", description: "Architect owns contract surfaces; terminal allow wins last." },
    { match: "write:contracts/**", effect: "allow", description: "Architect owns contract surfaces; terminal allow wins last." },
    { match: "edit:tokens/**", effect: "allow", description: "Architect owns token vocabularies; terminal allow wins last." },
    { match: "write:tokens/**", effect: "allow", description: "Architect owns token vocabularies; terminal allow wins last." },
  ],
  manager: [
    { match: "read:*", effect: "allow", description: "Manager may read any workspace path for coordination." },
    { match: "read", effect: "allow", description: "Manager may issue bare reads." },
    { match: "glob:*", effect: "allow", description: "Manager may glob the workspace." },
    { match: "grep:*", effect: "allow", description: "Manager may search workspace content." },
    { match: "mcp_search_tools", effect: "allow", description: "Manager may discover lazy tools for staffing." },
    { match: "mcp_inspect_schema", effect: "allow", description: "Manager may inspect a single tool schema." },
    { match: "task dispatch", effect: "allow", description: "Manager may dispatch typed task briefs to staff." },
    { match: "bash:bun test*", effect: "allow", description: "Manager may run the suite to check receipts." },
    { match: "bash:bun run check*", effect: "allow", description: "Manager may run the type checker to check receipts." },
    { match: "edit:*", effect: "deny", description: "Manager never edits implementation files." },
    { match: "edit", effect: "deny", description: "Manager bare edit is denied." },
    { match: "write:*", effect: "deny", description: "Manager never writes files directly." },
    { match: "write", effect: "deny", description: "Manager bare write is denied." },
  ],
  "staff-backend": [
    { match: "read:*", effect: "allow", description: "Staff-backend may read the full workspace." },
    { match: "read", effect: "allow", description: "Staff-backend may issue bare reads." },
    { match: "glob:*", effect: "allow", description: "Staff-backend may glob the workspace." },
    { match: "grep:*", effect: "allow", description: "Staff-backend may search workspace content." },
    { match: "mcp_search_tools", effect: "allow", description: "Staff-backend may discover lazy tools." },
    { match: "mcp_inspect_schema", effect: "allow", description: "Staff-backend may inspect a single tool schema." },
    { match: "mcp_call_tool:*", effect: "allow", description: "Staff-backend may route authorized tool calls." },
    { match: "bash:bun *", effect: "allow", description: "Staff-backend may run bun workflows (test, install, check)." },
    { match: "edit:ui/web/**", effect: "deny", description: "Staff-backend may not touch presentation surfaces." },
    { match: "write:ui/web/**", effect: "deny", description: "Staff-backend may not write presentation surfaces." },
    { match: "edit:src/**", effect: "allow", description: "Staff-backend owns server sources; terminal allow wins last." },
    { match: "write:src/**", effect: "allow", description: "Staff-backend owns server sources; terminal allow wins last." },
    { match: "edit:test/**", effect: "allow", description: "Staff-backend owns co-located backend tests; terminal allow wins last." },
    { match: "write:test/**", effect: "allow", description: "Staff-backend owns co-located backend tests; terminal allow wins last." },
  ],
  "staff-ui": [
    { match: "read:*", effect: "allow", description: "Staff-ui may read the full workspace including contracts." },
    { match: "read", effect: "allow", description: "Staff-ui may issue bare reads." },
    { match: "glob:*", effect: "allow", description: "Staff-ui may glob the workspace." },
    { match: "grep:*", effect: "allow", description: "Staff-ui may search workspace content." },
    { match: "mcp_search_tools", effect: "allow", description: "Staff-ui may discover lazy tools." },
    { match: "mcp_inspect_schema", effect: "allow", description: "Staff-ui may inspect a single tool schema." },
    { match: "mcp_call_tool:*", effect: "allow", description: "Staff-ui may route authorized tool calls." },
    { match: "bash:bun *", effect: "allow", description: "Staff-ui may run bun workflows (test, check)." },
    { match: "edit:src/**", effect: "deny", description: "Staff-ui may not touch server sources." },
    { match: "write:src/**", effect: "deny", description: "Staff-ui may not write server sources." },
    { match: "edit:ui/web/**", effect: "allow", description: "Staff-ui owns presentation surfaces; terminal allow wins last." },
    { match: "write:ui/web/**", effect: "allow", description: "Staff-ui owns presentation surfaces; terminal allow wins last." },
    { match: "edit:test/**", effect: "allow", description: "Staff-ui owns co-located UI tests; terminal allow wins last." },
    { match: "write:test/**", effect: "allow", description: "Staff-ui owns co-located UI tests; terminal allow wins last." },
  ],
  "qa-adversary": [
    { match: "read:*", effect: "allow", description: "QA may read any workspace path for auditing." },
    { match: "read", effect: "allow", description: "QA may issue bare reads." },
    { match: "glob:*", effect: "allow", description: "QA may glob the workspace." },
    { match: "grep:*", effect: "allow", description: "QA may search workspace content." },
    { match: "mcp_search_tools", effect: "allow", description: "QA may discover lazy tools for adversarial probes." },
    { match: "mcp_inspect_schema", effect: "allow", description: "QA may inspect a single tool schema." },
    { match: "bash:bun test*", effect: "allow", description: "QA may run the test suite including sabotage runs." },
    { match: "bash:bun run check*", effect: "allow", description: "QA may run the type checker." },
    { match: "bash:git *", effect: "allow", description: "QA may run git for sabotage revert verification." },
    { match: "edit:src/**", effect: "deny", description: "QA never edits product sources; sabotage is transient and always reverted." },
    { match: "write:src/**", effect: "deny", description: "QA never writes product sources." },
    { match: "edit:*", effect: "deny", description: "QA terminal baseline: no durable edits to product paths." },
    { match: "write:*", effect: "deny", description: "QA terminal baseline: no durable writes to product paths." },
    { match: "mcp_call_tool:mutate*", effect: "deny", description: "QA may not route mutating tool calls." },
  ],
};

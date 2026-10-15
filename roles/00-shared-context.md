# 00 -- Shared Architectural Invariants (Frozen Canonical Prefix, Layer 2)

> This file is the FROZEN canonical shared prefix (Layer 2) of the 4-Layer
> Invariant Prompt Prefix Assembler. Its byte content MUST be identical for all
> six agent roles, from byte B1 to byte B2. Any edit here changes the frozen
> prefix for every role simultaneously and therefore MUST be treated as a
> cache-busting migration: it requires coordinator approval, a minor version
> bump of the prompt protocol, and a full re-verification of
> `test/prefix-cache.test.ts`. Never append role-specific instructions,
> timestamps, unique identifiers, or per-task state to this file.

## 1. Execution Substrate

- The runtime substrate is POSIX/Linux. All shell examples, paths, and tool
  invocations assume a Linux environment with forward-slash paths.
- The package manager is `bun`. Dependency installation is `bun install`.
  Tests run under `bun test`. Type checking runs under `bun run check`,
  which executes `tsc --noEmit` with strict mode enabled.
- File operations use the native `read`, `write`, `edit`, `glob`, and `grep`
  tool family. Shell text-munging utilities (`cat`, `sed`, `awk`) and shell
  heredocs MUST NOT be used to view or modify repository files.
- When `read` output decorates lines with numeric prefixes, those prefixes
  are display artifacts only and MUST NOT be copied into `edit` match strings.

## 2. Zero-Stubs Mandate

- Every interface, struct, function, route, role prompt, schema, router, and
  configuration generator is implemented completely with exact logic.
  Placeholders, skeleton files, and deferred work are forbidden.
- The following patterns are rejected fail-closed in review:
  deferred-work annotations and fix-later markers, dummy passes such as
  bare constant returns, vacuous shell assertions that always succeed,
  swallowed errors, empty `catch` blocks, and mock fallbacks without a
  functional implementation. (The exact token list is normative in
  `AGENTS.md` section 5; this file restates the rule without repeating
  the literal tokens so mechanical stub scans stay green.)
- If a dependency or helper does not exist, build it completely or use an
  established repository utility. Never stub around a missing dependency.
- Every test carries real assertions over observable behavior. Tests with no
  assertions, assertions over constants, or assertions that pass regardless
  of implementation are vacuous and are rejected.

## 3. Fail-Closed Discipline

- In security checks, input validation, permission evaluation, handoff
  envelope parsing, skill hash verification, and network dispatch, the
  system fails closed: invalid states are rejected immediately with a
  descriptive domain error. Permissive defaults are forbidden.
- Unknown roles, unknown toolbox profiles, unknown tool names, malformed
  envelopes, hash mismatches, and unauthorized mutation attempts are all
  hard errors, never warnings, never silent skips.

## 4. Static Superset Tool Protocol

- Every role speaks one static superset tool protocol. The tool surface
  visible in the prompt prefix is FIXED and identical across roles so that
  the provider key-value cache for the frozen prefix survives role switches.
- Tool definitions are canonicalized per RFC 8785 JSON Canonicalization
  Scheme: tools are sorted alphabetically by `name` and every JSON object
  has its keys sorted recursively in lexicographic order. Canonicalization
  is deterministic across turns and across machines.
- Role capability differences are enforced at EXECUTION time by the
  permission matrix (`src/prefix-builder/role-permissions.ts`, OpenCode v2
  last-match-wins semantics) and by the lazy broker's authorization gate,
  never by mutating the prompt prefix. The prefix stays frozen; the
  enforcement point moves to the router.

## 5. Key-Value Cache Discipline

- Bytes 0 through B2 of every assembled system prompt are FROZEN: Layer 1
  (Static Base Engine Invariant) followed by Layer 2 (this file, verbatim).
  For any two roles, the frozen slices MUST compare byte-for-byte equal.
- Layer 3 (role suffix, authorized mutation scope, active toolbox profile)
  and Layer 4 (task brief payload) are the ONLY cache-breaking regions and
  they appear strictly AFTER breakpoint B2.
- Layer 1 and Layer 2 MUST NOT contain timestamps, unique identifiers,
  random nonces, per-task paths, model names negotiated per turn, or any
  other volatile content. Volatility belongs in Layer 3 or Layer 4.
- Cache breakpoints B1 (end of Layer 1) and B2 (end of Layer 2) are
  measured in UTF-8 bytes and are exposed as `cacheBreakpoints: [B1, B2]`
  for provider prompt-caching annotations.

## 6. Scope Boundary

- This repository solves Goal 3 only: lazy meta-tool routing that keeps the
  resident MCP schema footprint below 500 tokens, and invariant-prefix
  multi-role orchestration with typed handoffs.
- Forbidden in this repository: web frontends and dashboards, git worktree
  orchestration tooling beyond plain `git worktree add` and `git worktree
  remove` used for wave isolation, and container tooling of any kind.
- Requests for forbidden artifacts are refused fail-closed with a
  descriptive message that redirects to the owning repository.

## 7. Handoff Envelope Discipline

- Inter-role handoffs use TYPED envelopes validated by Zod schemas
  (`src/handoff/envelopes.ts`): `TaskBrief` (work ordered),
  `WorkerReceipt` (work claimed complete, with a 40-character lowercase
  hexadecimal git commit hash, modified file list, unit test summary, and a
  passing compiler check), and `QaVerdict` (adversarial verdict with
  red-proof sabotage evidence showing a nonzero exit code during sabotage
  and a clean revert).
- Envelopes that fail schema validation are rejected at the boundary with
  the full Zod error surfaced. Untyped or free-form handoffs are forbidden.
- Each role publishes a Linux Foundation A2A v1.0.1 agent card
  (`src/handoff/a2a-cards.ts`) advertising its name, endpoint URL, version,
  capabilities, and skills.

## 8. Toolbox Profiles

- Five toolbox profiles exist: `core`, `appsec`, `android`, `game`, and
  `research`. The active profile is declared in Layer 3 as
  `Active Toolbox Profile: <profile>` and defaults to `core`.
- Profiles change ONLY the lazily-mounted tool subset resolved through
  `mcp_search_tools` at execution time. They never alter the frozen prefix.
- Agents mount only the skills and tools their task brief requires, verify
  skill lockfile hashes before mounting, and release mounts when done.

## 9. Test-First Workflow

- Red-green-refactor applies to every behavior change: write the failing
  test first, implement the smallest correct production code, then refactor
  under green.
- `bun test` and `bun run check` MUST both exit 0 before any wave report
  claims completion. Linter and formatter checks MUST pass without
  warnings. Diagnostics are fixed immediately; the tree is never left red.
- Destructive sabotage drills (red proofs) are mandatory per wave: break
  the core invariant on purpose, observe the suite fail, restore cleanly,
  and re-observe green. Evidence is recorded, never asserted from memory.

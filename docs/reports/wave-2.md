# Wave 2 Report — Lazy Meta-Tool Discovery Broker

- Stage ID: wave-2 (`wave-2-lazy-broker`)
- Spec: `docs/prompts/SPEC.md` Section 2.2 (from `MASTER_BUILD_PROMPT.md` Section 2.2)
- Worktree: `worktrees/wave-2`, branch `wave-2-lazy-broker`
- Date: 2026-10-15

## Summary of Deliverables

All Wave 2 specification items are implemented with exact logic, zero stubs,
and real-assertion tests:

1. **`src/lazy-broker/bm25-catalog.ts`** — Pure-TypeScript in-memory tool
   catalog (Map + inverted index; no native dependencies, deterministic under
   `bun test`). Stores backend MCP tool definitions (`server`, `profile`,
   `name`, `description`, `boostKeywords`, `inputSchemaJson`, plus an explicit
   `mutating` flag consumed by the authorization gate). Implements Okapi BM25
   (k1 = 1.2, b = 0.75) plus trigger-keyword scoring with the exact SPEC
   formula `Score = TriggerMatch * 3.0 + BM25 * 1.0 + KeywordBoost * 2.0`
   (exported weight constants `TRIGGER_WEIGHT`/`BM25_WEIGHT`/`KEYWORD_WEIGHT`
   asserted equal to 3.0/1.0/2.0 in tests). Fail-closed on duplicate names,
   unknown profiles, empty/term-less queries, bad limits, and empty catalogs.
   Pre-populated with **34 domain tools across all 5 Heretek Compose
   profiles** (`core`, `appsec`, `android`, `game`, `research`), covering
   every required backend: `ghidra-mcp`, `radare2-mcp`, `morluto/rea`,
   `iksnerd/adb-mcp`, `maestro`, `godot-mcp`, `blender-mcp`, `crawl4ai`,
   `searxng`, `computer-use-linux`.
2. **`src/lazy-broker/meta-router-mcp.ts`** — Lazy broker surface:
   - `listMetaTools()` returns **exactly 3** meta-tools
     (`mcp_search_tools`, `mcp_inspect_schema`, `mcp_call_tool`); anything
     else (a 4th tool) breaks the count test fail-closed.
   - `estimateTokenCount()` (1 token ~= 4 JSON chars) measures **~240
     tokens**, under the 500-token hard budget and the 400-token target.
   - `searchTools({ query, profile?, limit? })` returns top-K
     name/profile/one-line-summary hits, never full schemas.
   - `inspectToolSchema({ toolName })` returns the full `inputSchema` for
     one tool; unknown names throw `UnknownToolError`.
   - `callTool({ toolName, args }, { role?, nowMs?, catalog? })` pipelines
     per-tool circuit breaker (opens for exactly 60s after 3 consecutive
     backend failures; success resets the count) -> CEL-style role
     authorization (`qa-adversary` and `director` are denied mutating tools)
     -> required-field + primitive-type argument validation -> static
     `ROUTING_TABLE` lookup -> registered-transport dispatch. Missing
     transports and backend errors throw `BackendUnreachableError`
     fail-closed (and count toward the breaker); auth/validation failures do
     not. Transports are pluggable via `registerBackendTransport`, so routing
     is fully implemented, not bypassed.
   - Typed errors: `UnknownToolError`, `AuthorizationError`,
     `CircuitOpenError`, `BackendUnreachableError`, `ValidationError`, each
     with a stable `code`.
3. **`src/index.ts`** — re-exports the full lazy-broker surface alongside
   the existing Wave 1 exports.
4. **Tests** — `test/lazy-broker.test.ts` (29 tests): exact 3-tool list,
   token budget <500 and <400, schema required-field declarations, 30+
   indexed tools, 5-profile coverage, all 10 required servers present,
   Android/Ghidra/Godot top-1 ranking accuracy, profile filtering,
   summary-only results, latency bound, fail-closed search inputs, inspect
   success/unknown paths, mutating-flag classification, role allow/deny
   matrix (including no-backend-contact on denial), routed-call success with
   echoed payload, unreachable-backend failure, arg validation, 60s circuit
   open/close boundaries, failure-count reset across flakiness, and unknown
   tool/role rejection.
5. **`scripts/accept/wave-2.sh`** (executable, `set -euo pipefail`, no
   permissive fallbacks) and **this report**.

## Test Results (full outputs)

### `bun run check` (`tsc --noEmit`) — exit 0

```text
$ tsc --noEmit
```

(no diagnostics)

### `bun test` — exit 0, 60 pass / 0 fail / 767 assertions

```text
bun test v1.4.2 (744846f84)

 60 pass
 0 fail
 767 expect() calls
Ran 60 tests across 3 files. [52.00ms]
```

### `bash scripts/accept/wave-2.sh` — exit 0

```text
=== wave-2 accept: typecheck ===
$ tsc --noEmit
=== wave-2 accept: test suite ===
bun test v1.4.2 (744846f84)

 60 pass
 0 fail
 767 expect() calls
Ran 60 tests across 3 files. [52.00ms]
=== wave-2 accept: token budget + tool count + catalog size ===
PASS: 3 meta-tools, ~240 estimated tokens (<500), 34 indexed tools across 5 profiles
=== wave-2 accept: BM25 ranking spot check ===
PASS: BM25 top-1 correct for android (adb__install), ghidra (ghidra__decompile_function), godot (godot__scene_tree)
=== wave-2 accept: ALL CHECKS PASSED ===
```

### `bash scripts/accept/wave-1.sh` (regression) — exit 0

```text
=== wave-1 accept: ALL CHECKS PASSED ===
```

(Wave 1 frozen-prefix spot check reports 8268 bytes on this worktree; the
prefix-equality contract itself passes unchanged. The byte delta versus the
wave-1 report predates Wave 2 — no `roles/` file was touched in this wave,
confirmed by `git diff --stat HEAD -- roles/` returning empty.)

## Self-Audit Notes

- Zero-stub scan
  `grep -rEn "TODO|FIXME|XXX|HACK|implement later|not implemented|echo \"passed\"|\|\| true|set \+e" src roles test scripts`
  returns zero matches (exit 1); no `return true;` dummy passes in
  `src`/`test` (exit 1); no empty catch blocks; every test asserts observable
  behavior (767 assertions across 60 tests, including 29 new Wave 2 tests).
- Token budget: measured ~240 estimated tokens for the full tools/list
  surface — comfortably under both the 500-token hard budget and the
  400-token target — while 34 backend tools stay lazily discoverable.
- Scope check: no WebUI, worktree-manager, or Docker artifacts; all new files
  fall inside the SPEC section 1 tree (`src/lazy-broker/`, `test/`,
  `scripts/accept/`, `docs/reports/`).
- Commit: `feat(wave-2): lazy meta-tool discovery broker`
  on branch `wave-2-lazy-broker` (hash recorded below).

# Wave 2 Verification Report — Lazy Meta-Tool Discovery Broker (`agency-drift-guard`)

- Worktree: `worktrees/wave-2`, branch `wave-2-lazy-broker`
- Date (UTC): 2026-10-16
- Verifier role: Drift Guard (auditor only; no code modified)
- Sources read in full: `AGENTS.md`, `docs/prompts/SPEC.md` (§§1, 2.2),
  `docs/prompts/verify-stage.md` (§2), `docs/reports/wave-2.md`,
  `docs/evidence/wave-2/red-proofs.log`, `docs/reports/wave-1.md`
- Code audited: `src/lazy-broker/bm25-catalog.ts` (611 lines),
  `src/lazy-broker/meta-router-mcp.ts` (454 lines),
  `test/lazy-broker.test.ts` (375 lines), `src/index.ts`,
  `scripts/accept/wave-2.sh`

## 2a. Zero-stubs check — PASS

- `grep -rEn "TODO|FIXME|XXX|HACK|implement later|not implemented|echo \"passed\"|\|\| true|set \+e"`
  over `src/`, `roles/`, `test/`, `scripts/`: **zero matches** (independently re-run).
  `configs/` does not exist yet in Wave 2 — correct per SPEC §2.3 (Wave 3 scope);
  not faked, same exclusion QA documented.
- `grep "return true;" src`: **zero matches**.
- `grep "catch" src/lazy-broker`: 2 hits, both non-empty and fail-closed —
  `meta-router-mcp.ts:439` (`catch (error)` → `recordFailure` + `throw BackendUnreachableError`),
  `bm25-catalog.ts:604` (`catch` → `throw` corrupt-schema error). No swallowed errors.
- Manual review: no dummy passes, no mock fallbacks (transports are pluggable
  dispatch via `registerBackendTransport` + `ROUTING_TABLE`, exercised by tests),
  no vacuous tests — every test asserts observable behavior (29 Wave 2 tests,
  137 assertions; 767 total). Weights asserted exact (`TRIGGER_WEIGHT=3.0`,
  `BM25_WEIGHT=1.0`, `KEYWORD_WEIGHT=2.0`).

## 2b. Token count <500 check — PASS (independently measured)

- Ran `bun -e` against the worktree myself:
  `{"count":3,"names":["mcp_search_tools","mcp_inspect_schema","mcp_call_tool"],"tokens":240,"tools":34,"profiles":["core","appsec","android","game","research"]}`
- `tools/list` exposes **exactly 3 meta-tools** (`mcp_search_tools`,
  `mcp_inspect_schema`, `mcp_call_tool`); estimated footprint **~240 tokens**,
  under the 500-token hard budget AND the <400 target.
- Independently ran `bun test`: **60 pass / 0 fail / 767 assertions, exit 0**.
- QA red-proof (reviewed in `red-proofs.log`): 4th tool injected into
  `listMetaTools()` → `test/lazy-broker.test.ts` failed exit 1 (28 pass / 1 fail,
  exact-name-list assertion at line 33); restored via
  `git checkout -- src/lazy-broker/meta-router-mcp.ts`, 29/29 green + `tsc` clean.
  Assertion is truly fail-closed. Second key assertion (token budget
  `<500 and <400`) is a hard numeric bound that fails on inflation by construction.

## 2c. Prefix equality check — PASS (no Wave 2 regression)

- Independently ran `bun test test/prefix-cache.test.ts`: **13 pass / 0 fail, exit 0**.
- `git diff --stat HEAD -- roles/` returns **empty** — no role file touched in Wave 2.
- Wave-1 regression accept passes per QA log (frozen prefix 8268 bytes,
  breakpoints [1089,8268], director vs qa-adversary identical). Contract intact.

## 2d. Scope check — PASS

- No WebUI, worktree-manager, or Docker artifacts (`find` for
  `*docker*`, `Dockerfile*`, `*worktree*manager*`, `*.html`: zero hits).
- All new files inside the SPEC §1 tree (`src/lazy-broker/`, `test/`,
  `scripts/accept/`, `docs/reports/`, `docs/evidence/`). `configs/` correctly
  absent until Wave 3. Working tree clean; nothing outside the tree.

## 2e. Spec fidelity (§2.2) — PASS

- BM25 formula: `trigger * TRIGGER_WEIGHT + bm25 * BM25_WEIGHT + boost * KEYWORD_WEIGHT`
  (`bm25-catalog.ts:574`) with weights 3.0/1.0/2.0 — matches
  `Trigger*3.0 + BM25*1.0 + Keyword*2.0`; k1=1.2, b=0.75 standard Okapi.
- 5 profiles × 34 tools (≥30 required): core/appsec/android/game/research; all 10
  required servers present (`ghidra-mcp`, `radare2-mcp`, `morluto/rea`,
  `iksnerd/adb-mcp`, `maestro`, `godot-mcp`, `blender-mcp`, `crawl4ai`,
  `searxng`, `computer-use-linux`).
- 3 meta-tools semantics: search returns name/profile/summary only
  (test asserts no `inputSchema` key); inspect returns one full schema /
  `UnknownToolError`; call pipelines breaker → auth → validation → transport.
- Circuit breaker: opens after 3 consecutive failures (`CIRCUIT_FAILURE_THRESHOLD=3`),
  `CIRCUIT_OPEN_MS=60_000`; boundary-tested (open at -1ms, closed at +1ms);
  success resets count; auth/validation failures do not trip it.
- Auth: `READ_ONLY_ROLES = ["director", "qa-adversary"]` denied mutating tools;
  denial occurs before backend contact (test asserts `contacted === false`).
- `tsc --noEmit` independently verified exit 0.

VERDICT: PASS

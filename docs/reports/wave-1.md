# Wave 1 Report — 4-Layer Invariant Prompt Prefix Assembler & Typed Handoffs

- Stage ID: wave-1 (`wave-1-prefix-roles`)
- Spec: `docs/prompts/SPEC.md` Section 2.1 (from `MASTER_BUILD_PROMPT.md` Section 2.1)
- Worktree: `worktrees/wave-1`, branch `wave-1-prefix-roles`
- Date: 2026-10-15

## Summary of Deliverables

All Wave 1 specification items are implemented with exact logic, zero stubs,
and real-assertion tests:

1. **Role prompts** — `roles/00-shared-context.md` (frozen canonical shared
   prefix, Layer 2: substrate, zero-stubs mandate, fail-closed discipline,
   static superset tool protocol, KV cache discipline, scope boundary,
   handoff envelope discipline, toolbox profiles, test-first workflow; no
   timestamps, UUIDs, or non-ASCII bytes) plus the six role files
   (`director.md`, `architect.md`, `manager.md`, `staff-backend.md`,
   `staff-ui.md`, `qa-adversary.md`), each with role-specific instructions,
   Authorized Mutation Scope semantics, and toolbox profile reference.
2. **`src/prefix-builder/assemble-prompt.ts`** — `canonicalizeToolSchemas`
   (alphabetical by `name`, recursive lexicographic key sort per RFC 8785
   JCS) and `assemblePrefixCachedPrompt` (Layer 1 static invariant bytes
   0..B1, Layer 2 shared-context bytes B1..B2, Layer 3 role suffix plus
   `Authorized Mutation Scope` plus `Active Toolbox Profile`; frozen prefix
   identical for every role by construction). Exports `RoleId`, `ALL_ROLES`,
   `BASE_ENGINE_INVARIANT`, option/result types, and fail-closed validation
   for unknown roles, empty workspace roots, and unknown profiles.
3. **`src/prefix-builder/role-permissions.ts`** — `PermissionRule`
   (`match` glob / `effect` allow-deny-ask / `description`),
   `ROLE_PERMISSION_MATRIX` for all six roles (baseline rules first,
   narrow terminal rules last), plus `matchRulePattern` glob matcher and
   `evaluatePermission` implementing OpenCode v2 last-match-wins semantics
   with fail-closed deny on no-match and unknown roles.
4. **`src/handoff/envelopes.ts`** — Zod strict schemas `TaskBriefSchema`
   (workspace-relative non-escaping `ownedPaths`, non-empty acceptance
   criteria), `WorkerReceiptSchema` (40-char lowercase hex `commitHash`,
   `modifiedFiles`, consistent `unitTestSummary`, `compilerCheckPassed`
   literal `true`), `QaVerdictSchema` (`redProofEvidence` with
   `exitCodeDuringSabotage >= 1` and `revertedCleanly` literal `true`),
   plus inferred TS types and supporting schemas.
5. **`src/handoff/a2a-cards.ts`** — `generateA2AAgentCard(role, baseUrl)`
   producing Linux Foundation A2A v1.0.1 cards (`name`, `url`, `version`
   and `protocolVersion` `1.0.1`, streaming capability, text modes, per-role
   skills, provider), fail-closed on unknown roles and non-HTTP(S) URLs.
6. **`src/index.ts`** — explicit barrel re-exports of the Wave 1 surface.
7. **Tests** — `test/prefix-cache.test.ts` (12 tests: JCS canonicalization
   determinism plus all 15 role-pair frozen-prefix equalities, B1 slicing,
   B1..B2 verbatim content, ASCII purity, volatility absence, Layer 3
   specificity, brief/profile rendering, fail-closed cases) and
   `test/handoff.test.ts` (19 tests: brief/receipt/verdict accept-reject
   coverage, six-role A2A card validity, full permission matrix behavior
   including last-match-wins).
8. **`scripts/accept/wave-1.sh`** (executable, `set -euo pipefail`, no
   permissive fallbacks) and **this report**.

## Test Results (full outputs)

### `bun run check` (`tsc --noEmit`) — exit 0

```text
$ tsc --noEmit
```

(no diagnostics)

### `bun test` — exit 0, 31 pass / 0 fail / 630 assertions

```text
bun test v1.4.2 (744846f84)

 31 pass
 0 fail
 630 expect() calls
Ran 31 tests across 2 files. [43.00ms]
```

### `bash scripts/accept/wave-1.sh` — exit 0

```text
=== wave-1 accept: typecheck ===
$ tsc --noEmit
=== wave-1 accept: test suite ===
bun test v1.4.2 (744846f84)

 31 pass
 0 fail
 630 expect() calls
Ran 31 tests across 2 files. [41.00ms]
=== wave-1 accept: prefix equality spot check (director vs qa-adversary) ===
PASS: frozen prefix identical for director and qa-adversary (8101 bytes, breakpoints [1089,8101])
=== wave-1 accept: ALL CHECKS PASSED ===
```

## Self-Audit Notes

- Zero-stub scan
  `grep -rEn "TODO|FIXME|XXX|HACK|implement later|not implemented|echo \"passed\"|\|\| true|set \+e" src roles test scripts`
  returns zero matches (exit 1); no `return true;` dummy passes in
  `src`/`test`; no empty catch blocks; every test asserts observable
  behavior (630 assertions across 31 tests).
- Frozen prefix is pure ASCII by test enforcement, so UTF-8 byte offsets
  B1/B2 coincide with string indices and the SPEC slice contract
  (`slice(0, frozenPrefixBytes)`) is byte-exact. The one mechanical-scan
  risk (literal stub tokens inside the mandate prose of
  `roles/00-shared-context.md`) was resolved by restating the rule without
  the literal tokens and pointing at normative `AGENTS.md` section 5.
- Scope check: no WebUI, worktree-manager, or Docker artifacts; all files
  fall inside the SPEC section 1 tree (`roles/`, `src/`, `test/`,
  `scripts/accept/`, `docs/reports/`).
- Commit: `feat(wave-1): 4-layer prefix assembler, 6 roles, typed handoffs`
  on branch `wave-1-prefix-roles` (hash recorded in the coordinator log).

# Wave 1 Drift Guard Verification — `docs/reports/wave-1-verification.md`

- Stage: wave-1 (`wave-1-prefix-roles`)
- Worktree: `/home/john/Projects/Heretek-AI-Rebuild/heretek-context-router/worktrees/wave-1`
- Spec: `docs/prompts/SPEC.md` §2.1 + §1 file tree; checklist `docs/prompts/verify-stage.md` §2 (2a–2e)
- Auditor: agency-drift-guard (independent, adversarial; no code modified)
- Date (UTC): 2026-10-15
- Bun: v1.4.2 (744846f84)

## 0. Inputs read in full before any other work

- `AGENTS.md`, `docs/prompts/SPEC.md`, `docs/prompts/verify-stage.md`,
  `docs/reports/wave-1.md`, `docs/evidence/wave-1/red-proofs.log`
- `src/prefix-builder/assemble-prompt.ts`, `src/prefix-builder/role-permissions.ts`,
  `src/handoff/envelopes.ts`, `src/handoff/a2a-cards.ts`, `src/index.ts`
- `test/prefix-cache.test.ts`, `test/handoff.test.ts`,
  `scripts/accept/wave-1.sh`, `roles/00-shared-context.md`, `Makefile`
- `git ls-files` tree + live runs below (executed, not asserted from memory)

## 2a. Zero-stubs check — PASS

- `grep` for `TODO|FIXME|XXX|HACK|implement later|not implemented|echo "passed"|\|\| true|set \+e`
  across `src/`, `roles/`, `test/`, `scripts/`: **zero matches in all four dirs**
  (native grep, one dir at a time). `configs/` does not exist in Wave 1 — it is a
  Wave 3 deliverable per SPEC §2.3, so its absence is expected, not a gap
  (scanning it returns exit 2 for missing dir; canonical Wave 1 scan omits it).
- `grep "return true;" src`: zero matches (no dummy passes).
- `grep "catch.*\{\s*\}" src`: zero matches (no empty catches).
- Manual review: `assemble-prompt.ts` (191 lines), `role-permissions.ts` (169 lines),
  `envelopes.ts` (116 lines), `a2a-cards.ts` (219 lines) are fully implemented —
  no placeholders, no mock fallbacks, all error paths throw descriptive fail-closed
  errors (unknown role/profile/URL). Tests carry 630 assertions across 31 tests;
  no assertion-free or constant-asserting (vacuous) tests found.
- `Makefile` is fail-closed (`bun install` + `bun run check` + `bun test`,
  no `|| true`, no `set +e`).

## 2b/2c. Prefix equality check (verify-stage §2c; Wave 1 has no §2b token budget) — PASS

Independent live run by this auditor (not copied from any report):

- `bun test`: **31 pass / 0 fail / 630 expect() calls** (exit 0).
- `bun run check` (`tsc --noEmit`): clean, exit 0.
- `bash scripts/accept/wave-1.sh`: exit 0, spot check
  `PASS: frozen prefix identical for director and qa-adversary (8268 bytes, breakpoints [1089,8268])`.
- Full 6-role sweep by this auditor: B1=1089, B2=8268, frozenPrefixBytes=8268
  identical for all roles; all **15/15 role pairs byte-for-byte equal** 0..B2
  (`ALL_EQUAL=true`). Per-role total prompt bytes differ only in Layer 3
  (director 11038, architect 10729, manager 10696, staff-backend 11155,
  staff-ui 10857, qa-adversary 11324) — suffix variance AFTER B2, as specified.
- Frozen prefix is pure ASCII (test-enforced), so UTF-8 byte offsets B1/B2
  coincide with string indices and the SPEC `slice(0, frozenPrefixBytes)`
  contract is byte-exact.
- Red-proof validity (from `red-proofs.log` §1c, reviewed in full): sabotage
  `const systemPrompt = \`[SABOTAGE:${options.role}:${Date.now()}]\` + layer1 + …`
  at `src/prefix-builder/assemble-prompt.ts:182` produced **3/13 failures,
  exit 1** in `test/prefix-cache.test.ts`; restore via
  `git checkout -- src/prefix-builder/assemble-prompt.ts` left zero diff and
  returned to 31/31 green + `tsc` clean. The equality assertion is proven
  fail-closed, non-vacuous. Working tree observed clean by this auditor
  (`git status --short` empty, `git diff --stat` empty).

## 2d. Scope check (AGENTS.md §4.2) — PASS

- No WebUI, worktree-manager, or Docker artifacts: no `Dockerfile` /
  `docker-compose*` / `*.dockerfile` anywhere; file tree (`git ls-files`) is
  exactly `AGENTS.md`, `MASTER_BUILD_PROMPT.md`, `Makefile`, `package.json`,
  `tsconfig.json`, `roles/*.md` (7 files), `src/{index,prefix-builder/*,handoff/*}.ts`
  (5 files), `test/*.test.ts` (2 files), `scripts/accept/wave-1.sh`,
  `docs/prompts/*`, `docs/reports/wave-1.md`, `docs/evidence/wave-1/red-proofs.log`.
  All inside the SPEC §1 tree (+ docs/prompts + reports/evidence scaffolding).
  `src/lazy-broker/`, `src/skills/`, `configs/` correctly absent (Wave 2/3 scope).
- Only `docker|webui|worktree` hit in `src roles test scripts Makefile` is the
  normative scope-boundary prose in `roles/00-shared-context.md:89`
  (forbidden-artifact declaration), not an artifact.

## 2e-i. Spec fidelity (§2.1) — PASS

1. `canonicalizeToolSchemas`: sorts by `name`, recursively sorts keys (JCS) —
   independently re-probed deterministic (`a===b`, alpha-first). PASS.
2. `assemblePrefixCachedPrompt`: Layer 1 = `BASE_ENGINE_INVARIANT` bytes 0..B1
   (no timestamps/UUIDs), Layer 2 = verbatim `roles/00-shared-context.md`
   bytes B1..B2 (test asserts `subarray(b1,b2) === shared` file content),
   Layer 3 = role body + `Authorized Mutation Scope:` + `Active Toolbox Profile:`
   (defaults `NONE`/`core`); `frozenPrefixBytes === B2`; unknown role /
   empty workspaceRoot / unknown profile all throw fail-closed. PASS.
3. `ROLE_PERMISSION_MATRIX`: 6 roles, baseline-first / terminal-last ordering,
   `evaluatePermission` last-match-wins with deny-on-no-match + unknown-role
   throw — independently probed (architect `edit:contracts/api.json` allow,
   `quantum:teleport` deny, ghost-role throw). PASS.
4. Zod envelopes: `TaskBriefSchema` (workspace-relative non-escaping ownedPaths,
   non-empty criteria, strict), `WorkerReceiptSchema` (40-char lowercase-hex
   `commitHash`, consistent summary, `compilerCheckPassed` literal true),
   `QaVerdictSchema` (`exitCodeDuringSabotage >= 1`, `revertedCleanly` literal
   true) — accept paths tested and all three reject paths independently
   re-probed by this auditor (escaping path / short hash / exit-0 all rejected). PASS.
5. `generateA2AAgentCard`: A2A v1.0.1 (`version` + `protocolVersion` `1.0.1`,
   streaming true, text modes, ≥2 skills/role, `Heretek-AI` provider,
   `<baseUrl>/a2a/<role>` URL) for all 6 roles; trailing-slash strip +
   non-HTTP(S)/unknown-role fail-closed — independently re-probed. PASS.

## 2e-ii. Gate artifacts — PASS

- `docs/reports/wave-1.md` exists (deliverables + full `tsc`/`bun test`/accept outputs).
- `docs/evidence/wave-1/red-proofs.log` exists (202 lines: `make check` exit 0,
  accept exit 0, full sabotage transcript with failure excerpts, restore proof,
  post-restore green, zero-stub scan).

## Non-blocking observations (doc nits, NOT verdict-affecting)

1. `docs/reports/wave-1.md` says `test/prefix-cache.test.ts` has "12 tests";
   the file actually contains 13 (4 JCS + 9 prefix) and `test/handoff.test.ts`
   18, totalling the correctly reported 31. Count prose only; no code impact.
2. Frozen-prefix byte size quoted as 8101 in `wave-1.md` vs 8268 observed by QA
   and this auditor — role-file content evolution between runs; the invariant
   (identical bytes across roles within each run) holds in all runs. QA log
   already documents this delta.

## Independent fail-closed probes by this auditor (all read-only, `bun -e`)

- PROBE1 PASS: escaping `ownedPaths: ["../outside"]` rejected.
- PROBE2 PASS: short `commitHash` rejected.
- PROBE3 PASS: `exitCodeDuringSabotage: 0` rejected.
- PROBE4 PASS: unmatched address denies; architect contracts terminal-allow wins.
- PROBE5 PASS: JCS canonicalization deterministic + name-sorted.
- PROBE6 PASS: A2A card shape + URL; non-HTTP base URL rejected.

VERDICT: PASS

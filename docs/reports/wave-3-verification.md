# Wave 3 Verification Report — Drift Guard Audit

- Stage: wave-3 (`wave-3-skills-configs`), SPEC §2.3
- Worktree: `worktrees/wave-3`, branch `wave-3-skills-configs` (confirmed via `git branch --show-current`)
- Auditor role: agency-drift-guard (read-only; no code modified; report left uncommitted)
- Inputs read in full: `AGENTS.md`, `docs/prompts/SPEC.md`, `docs/prompts/verify-stage.md`, `docs/reports/wave-3.md`, `docs/evidence/wave-3/red-proofs.log`
- Independent runs by auditor: `bun test` (73 pass / 0 fail / 794 assertions, exit 0), `bun run check` (`tsc --noEmit`, exit 0), `bash scripts/accept/wave-3.sh` (ALL CHECKS PASSED), plus direct `bun -e` probes of broker/prefix/skill-mounter cited below.

## 2a. Zero-stubs check — PASS

- `grep -rEn "TODO|FIXME|XXX|HACK|implement later|not implemented|echo \"passed\"|\|\| true|set \+e" src roles configs test scripts` → zero matches (exit 1). Independently re-run by auditor: same result.
- `grep -rn "return true;" src test` → zero matches (exit 1).
- `catch` blocks in `src/skills/skill-mounter.ts` (lines 174, 185, 222, 282, 288, 384, 390) all throw typed fail-closed errors (`SkillLockError`, `SkillLockVersionError`, `SkillHashMismatchError`, `GrimoireHashMismatchError`); no empty `catch (e) {}` blocks.
- Tests are non-vacuous: `test/skill-mounter.test.ts` (13 tests) asserts error classes (`SkillHashMismatchError`, `SkillLockVersionError`, `GrimoireHashMismatchError`, `UnknownSkillError`), error `code` fields, skill names, and expected-vs-actual digest divergence — not constants.

## 2b. Token count <500 check — PASS

- Auditor probe: `listMetaTools()` returns exactly 3 tools (`mcp_search_tools,mcp_inspect_schema,mcp_call_tool`); `estimateTokenCount()` = **240 tokens** (< 500 hard budget, < 400 SPEC §2.2 target).
- `configs/opencode.base.json`: `mcp` object contains ONLY `heretek-lazy-broker` + `context-mode` (2 keys); `tokenBudget.maxUpfrontSchemaTokens` = 500; wires `@heretek-ai/opencode-harness`, `heretek-lazy-broker`, `n2-qln`, `context-mode`. Accept script config gate passes.
- Regression intact: wave-2 accept reports the same 3 meta-tools / ~240 tokens / 34 indexed tools.

## 2c. Prefix equality check — PASS

- Auditor probe: `assemblePrefixCachedPrompt` for all 6 roles (`director,architect,manager,staff-backend,staff-ui,qa-adversary`) → frozen prefix identical byte-for-byte, `frozenPrefixBytes` = **8268**, `cacheBreakpoints` = **[1089,8268]**, `EQUAL:true`.
- `test/prefix-cache.test.ts` passes within the green 73/73 suite; wave-1 accept regression passes (8268 identical bytes).

## 2d. Scope check — PASS

- No WebUI (no html/frontend/dashboard artifacts), no Docker (no Dockerfile/compose), no worktree-manager tooling beyond wave isolation; `find` scan for such artifacts returns nothing.
- All new/changed files fall inside the SPEC §1 tree: `src/skills/skill-mounter.ts`, `src/index.ts` (re-export), `skills/lazy-search/SKILL.md`, `skills/red-proof/SKILL.md`, `.skill-lock.json`, `grimoire.lock`, `configs/opencode.base.json`, `configs/agentgateway.yaml`, `test/skill-mounter.test.ts`, `scripts/accept/wave-3.sh`, `README.md`, `.gitignore` hygiene, `docs/reports/wave-3.md`, `docs/evidence/wave-3/red-proofs.log`.
- `git status --short` shows only untracked `docs/evidence/wave-3/` (the QA evidence file, intentionally uncommitted for handoff); no stray modifications. `README.md` documents production usage of all four modules.

## 2e. Fidelity check (SPEC §2.3) — PASS

1. **Skill-mounter SHA tree fail-closed** (`src/skills/skill-mounter.ts:215-252,353-371,429-459`): deterministic SHA-256 over sorted POSIX relpaths with `rel+"\0"+bytes+"\0"` feeds; symlinks/non-regular files/missing dirs/missing `SKILL.md`/empty dirs all rejected; `verifySkillLock` throws `SkillHashMismatchError` (with expected vs actual digests) on first mismatch; `mountSkill` re-verifies hash, rejects absolute/`..` paths and unknown names (`UnknownSkillError`).
2. **`.skill-lock.json` v3**: `version: 3` enforced exactly (`SkillLockVersionError` otherwise, `skill-mounter.ts:294`); 2 entries with 64-char hex hashes — `lazy-search → 93afc763…975a6`, `red-proof → 02108e2a…8aa5b1`. Auditor's `verifySkillLock` recomputation matches both.
3. **Grimoire JCS hash**: auditor recomputed `SHA-256(canonicalizeJson(declarations))` = `4204cf0a6166b6902f229910e6c5a6276aa1f6599c51d07d6bf5535c540679a5`, matching `grimoire.lock` `declaration_hash`; `verifyGrimoireLock` passes green.
4. **`configs/opencode.base.json`**: lazy-only (2 MCP servers), token budget 500 (see 2b).
5. **`configs/agentgateway.yaml`**: ingress `port: 3000` on `127.0.0.1`, 11 profile-scoped backends (`:3101`–`:3111`), 3 CEL policies (deny mutating calls from `qa-adversary`/`director`; allow only 5 known profiles; route only to registered backends), all `rejectFailClosed`.
6. **`src/index.ts`**: re-exports all four modules (prefix-builder, handoff, lazy-broker, skills); `tsc --noEmit` clean.
7. **QA red-proofs reviewed** (`docs/evidence/wave-3/red-proofs.log`): `make check` exit 0; wave-3 + wave-2 + wave-1 accepts all exit 0; sabotage (one-byte append to `skills/lazy-search/SKILL.md`) → `test/skill-mounter.test.ts` FAILS exit 1 with `SkillHashMismatchError` showing expected `93afc763…` vs computed `da26aa0d…` divergence (3 positive tests fail, non-vacuous); `git checkout -- <file>` restores clean; post-restore green (13/13 targeted, 73/73 full). Two independently fail-closed assertions confirmed: (i) tampered tree hash rejected on verify, (ii) tampered skill refused on mount — plus sandboxed tamper check in the accept script. Auditor did not re-sabotage (read-only constraint); fail-closed behavior is additionally proven by the sandboxed tamper tests inside the green suite itself (`test/skill-mounter.test.ts:103-125`), which the auditor ran green.

## Binding verdict

VERDICT: PASS

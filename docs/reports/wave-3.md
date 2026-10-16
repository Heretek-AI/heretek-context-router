# Wave 3 Report — Skill Lockfile Verifier, Configs & Final Entrypoint

- Stage ID: wave-3 (`wave-3-skills-configs`)
- Spec: `docs/prompts/SPEC.md` Section 2.3 (from `MASTER_BUILD_PROMPT.md` Section 2.3)
- Worktree: `worktrees/wave-3`, branch `wave-3-skills-configs`
- Date: 2026-10-16

## Summary of Deliverables

All Wave 3 specification items are implemented with exact logic, zero stubs,
and real-assertion tests:

1. **`src/skills/skill-mounter.ts`** — Skill lockfile verifier with 100% real
   logic over `node:crypto` / `node:fs` / `node:path`:
   - `loadSkillLock()` reads `.skill-lock.json` and enforces version exactly
     `3` (`SkillLockVersionError` otherwise), non-empty skills array, unique
     names, and 64-char lowercase hex `skillFolderHash` values.
   - `computeTreeHash()` builds a deterministic SHA-256 digest: recursively
     collect regular files, sort relative POSIX paths byte-wise, feed
     `relPath + "\0" + fileBytes + "\0"` per file. Symlinks, non-regular
     files, missing dirs, missing `SKILL.md`, and empty dirs are rejected
     fail-closed. Verified deterministic across repeated calls.
   - `verifySkillLock()` recomputes every locked tree hash and throws
     `SkillHashMismatchError` (with expected vs actual digests) on the first
     mismatch; `equalHashes()` compares digests in constant time.
   - `verifyGrimoireLock()` loads `grimoire.lock`, requires a `declarations`
     object plus hex `declaration_hash`, recomputes
     `SHA-256(canonicalizeJson(declarations))` per RFC 8785 JCS
     (recursive lexicographic key sort, `JSON.stringify` emission) and throws
     `GrimoireHashMismatchError` on mismatch.
   - `mountSkill()` optionally verifies the grimoire, resolves the named
     entry workspace-relative (rejects absolute/`..` paths), re-verifies its
     tree hash, and returns `{ name, skillDir, skillFolderHash, skillMd }`.
     Unknown names throw `UnknownSkillError`; empty `SKILL.md` is rejected.
2. **`skills/lazy-search/SKILL.md` + `skills/red-proof/SKILL.md`** — two real
   task-scoped skills (lazy broker protocol; red-proof sabotage protocol).
3. **`.skill-lock.json`** (version 3) with real computed hashes:
   - `lazy-search` → `93afc76317bd961f318d059972da2f04b2532835375e4cb935a50860e3f975a6`
   - `red-proof` → `02108e2af8ef271efafdf1c5f9814238b9aaf78e8b3311211730cc88ac8aa5b1`
4. **`grimoire.lock`** with RFC 8785 JCS `declaration_hash`
   `4204cf0a6166b6902f229910e6c5a6276aa1f6599c51d07d6bf5535c540679a5`
   over declarations `{metaTools, profiles, router, skillLockVersion, skills}`.
5. **`configs/opencode.base.json`** — wires `@heretek-ai/opencode-harness`,
   `heretek-lazy-broker`, `n2-qln`, and `context-mode`, while loading ONLY
   `heretek-lazy-broker` + `context-mode` as MCP servers (all domain backends
   stay lazy behind the `:3000` gateway); `tokenBudget.maxUpfrontSchemaTokens`
   is 500 (measured broker surface is ~240 tokens).
6. **`configs/agentgateway.yaml`** — `:3000` ingress listener, 11
   profile-scoped backend MCP targets (`:3101`–`:3111`), and 3 CEL policies:
   deny mutating calls from `qa-adversary`/`director`, allow only the 5 known
   profiles, and route only to registered backends (fail-closed).
7. **`src/index.ts`** — final entrypoint re-exporting all four modules
   (prefix-builder, handoff, lazy-broker, skills).
8. **`test/skill-mounter.test.ts`** (13 tests): version-3 lock shape, green
   verification with hash echo, grimoire verification, positive mounts for
   both skills (content assertions), grimoire-gated mount, unknown-skill
   rejection, sandboxed one-byte tamper → `SkillHashMismatchError` with
   divergent digests, tampered mount refusal, hash determinism, bad-version
   rejection, and tampered-grimoire rejection.
9. **`scripts/accept/wave-3.sh`** (executable, `set -euo pipefail`):
   typecheck + full suite + positive lock/grimoire/mount check + sandboxed
   tamper-rejection check + config assertions + `.gitignore` evidence hygiene.
10. **`README.md`** production usage; **`.gitignore`** now un-ignores
    `docs/evidence/**/red-proofs.log` while keeping `*.log` for other logs.

## Test Results (full outputs)

### `bun run check` (`tsc --noEmit`) — exit 0

```text
$ tsc --noEmit
```

(no diagnostics)

### `bun test` — exit 0, 73 pass / 0 fail / 794 assertions

```text
bun test v1.4.2 (744846f84)

 73 pass
 0 fail
 794 expect() calls
Ran 73 tests across 4 files. [67.00ms]
```

### `bash scripts/accept/wave-3.sh` — exit 0

```text
=== wave-3 accept: typecheck ===
$ tsc --noEmit
=== wave-3 accept: test suite ===
bun test v1.4.2 (744846f84)

 73 pass
 0 fail
 794 expect() calls
Ran 73 tests across 4 files. [67.00ms]
=== wave-3 accept: skill lock verification (positive) ===
PASS: 2 locked skills verify; grimoire 4204cf0a6166...; mounted lazy-search
=== wave-3 accept: tamper rejection spot check (sandboxed) ===
PASS: tampered skill directory rejected fail-closed (SkillHashMismatchError)
=== wave-3 accept: production configs ===
PASS: opencode.base.json (lazy router + context-mode only, <500 tokens) and agentgateway.yaml (CEL, :3000)
=== wave-3 accept: gitignore evidence hygiene ===
PASS: .gitignore keeps red-proofs.log tracked
=== wave-3 accept: ALL CHECKS PASSED ===
```

### Regressions — exit 0

```text
=== wave-1 accept: ALL CHECKS PASSED ===
(frozen prefix identical for director and qa-adversary, 8268 bytes)
=== wave-2 accept: ALL CHECKS PASSED ===
(3 meta-tools, ~240 estimated tokens (<500), 34 indexed tools across 5 profiles;
 BM25 top-1 correct for android/adb__install, ghidra/ghidra__decompile_function, godot/godot__scene_tree)
```

## Self-Audit Notes

- Zero-stub scan
  `grep -rEn "TODO|FIXME|XXX|HACK|implement later|not implemented|echo \"passed\"|\|\| true|set \+e" src roles configs test scripts`
  returns zero matches (exit 1); no `return true;` in `src`/`test`; no empty
  catch blocks; every new test asserts observable behavior (tamper tests assert
  the thrown error class, code, skill name, and digest divergence — not constants).
- Token budget unchanged: ~240 estimated tokens for the 3-meta-tool surface,
  under the 500 hard budget and 400 target; `opencode.base.json` loads only the
  lazy broker + context-mode.
- Scope check: no WebUI, worktree-manager, or Docker artifacts; all new files
  fall inside the SPEC section 1 tree (`src/skills/`, `skills/`, `configs/`,
  `.skill-lock.json`, `grimoire.lock`, `test/`, `scripts/accept/`,
  `docs/reports/`, `README.md`, `.gitignore` hygiene).
- Commit: `feat(wave-3): skill lockfile verifier, configs, entrypoint`
  on branch `wave-3-skills-configs`.

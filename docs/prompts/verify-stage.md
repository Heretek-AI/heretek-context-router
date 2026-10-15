# verify-stage.md — Triad Verification Checklist (Binding for Every Wave)

> This checklist is executed by `agency-qa` and `agency-drift-guard` at the end
> of EVERY wave (Waves 1–3). No wave merges to `main` without all boxes checked,
> a `VERDICT: PASS` in `docs/reports/wave-<N>-verification.md`, and sabotage
> evidence in `docs/evidence/wave-<N>/red-proofs.log`.

## 0. Preconditions (Programmer self-verification, must already be done)

- [ ] `bun test` exits 0 in the wave worktree (full output pasted in
      `docs/reports/wave-<N>.md`).
- [ ] `bun run check` (`tsc --noEmit`) exits 0 in the wave worktree (full
      output pasted in `docs/reports/wave-<N>.md`).
- [ ] Wave accept script exists at `scripts/accept/wave-<N>.sh`, is executable,
      and exits 0.

## 1. QA Gate (`agency-qa`)

- [ ] **1a. `make check`:** run from the repository root of the wave worktree.
      MUST exit 0 (`bun install` + `bun run check` + `bun test`, fail-closed,
      no `|| true`, no `set +e`). Paste full output into
      `docs/evidence/wave-<N>/red-proofs.log` header.
- [ ] **1b. Accept scripts:** run `bash scripts/accept/wave-<N>.sh` (and all
      prior waves' accept scripts for regression). MUST exit 0. Paste output
      into the red-proofs log.
- [ ] **1c. Red-Proof Sabotage (mandatory, per wave):** deliberately break the
      wave's core invariant, confirm the test suite FAILS (exit code >= 1),
      then restore cleanly with `git checkout -- <file>` and confirm green
      again. Minimum sabotages:
      - Wave 1: prepend a role name at byte 0 of `assemblePrefixCachedPrompt`
        output (or inject a timestamp/UUID into Layer 1) and confirm
        `test/prefix-cache.test.ts` fails immediately.
      - Wave 2: add a 4th tool to the `tools/list` response (or inflate schema
        tokens above the budget) and confirm `test/lazy-broker.test.ts` fails.
      - Wave 3: tamper one byte of a locked skill directory and confirm
        `test/skill-mounter.test.ts` fails (hash mismatch, fail-closed).
- [ ] **1d. Evidence file:** write the full sabotage transcript (commands run,
      exit codes observed, failure output excerpts, restore command, post-restore
      green run) to `docs/evidence/wave-<N>/red-proofs.log`.

## 2. Drift Guard Gate (`agency-drift-guard`)

- [ ] **2a. Zero-stubs check:** the following MUST return zero matches across
      `src/`, `roles/`, `configs/`, `test/`, `scripts/`:
      `grep -rEn "TODO|FIXME|XXX|HACK|implement later|not implemented|echo \"passed\"|\\|\\| true|set \\+e" <dirs>`
      plus manual review for `return true;` dummy passes, empty `catch` blocks,
      mock fallbacks, and vacuous (assertion-free or constant-asserting) tests.
- [ ] **2b. Token count <500 check (Waves 2–3):** assert the `tools/list`
      response of the lazy meta-router exposes at most 3 meta-tools and the
      estimated total schema token footprint is `< 500` tokens (target `< 400`
      per SPEC §2.2). Cite the measured number in the verification report.
- [ ] **2c. Prefix equality check (Waves 1–3):** assert byte-for-byte prefix
      equality from byte 0 to breakpoint B2 across all 6 roles
      (`promptA.systemPrompt.slice(0, promptA.frozenPrefixBytes) ===
      promptB.systemPrompt.slice(0, promptB.frozenPrefixBytes)` for every role
      pair). Cite `test/prefix-cache.test.ts` result in the verification report.
- [ ] **2d. Scope check:** no WebUI, git worktree manager, or Docker artifacts
      introduced (`AGENTS.md` §4.2). No files outside the SPEC §1 file tree
      without coordinator approval.
- [ ] **2e. Verdict:** issue exactly one of the following lines in
      `docs/reports/wave-<N>-verification.md`:
      - `VERDICT: PASS` — all checks green; merge to `main` is authorized.
      - `VERDICT: FAIL` — cite each failing check with file/line evidence;
        merge is BLOCKED until the Programmer remediates and QA re-proves.

## 3. Merge Authorization (Coordinator only, after 1 + 2)

- [ ] `docs/reports/wave-<N>.md` exists with deliverables + test outputs.
- [ ] `docs/evidence/wave-<N>/red-proofs.log` exists with sabotage transcript.
- [ ] `docs/reports/wave-<N>-verification.md` contains `VERDICT: PASS`.
- [ ] Only then: merge the wave branch into `main`, remove the worktree, and
      verify `make check && make accept` exits 0 on `main`.

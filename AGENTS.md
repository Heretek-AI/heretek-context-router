# AGENTS.md — `heretek-context-router` Agent Operating Contract

> This file is binding on every agent (`agency-coordinator`, `agency-programmer`,
> `agency-qa`, `agency-drift-guard`) working in this repository. Read it in full
> before any implementation, test, or verification step. It is complemented by
> `docs/prompts/SPEC.md` (the authoritative build specification) and
> `docs/prompts/verify-stage.md` (the triad verification checklist).

## 1. Zero Prompt Summarization Rule (Non-Negotiable)

- NEVER summarize, paraphrase, truncate, or compress `MASTER_BUILD_PROMPT.md`,
  `docs/prompts/SPEC.md`, or any prompt file when handing work to another agent.
- Every subagent dispatch MUST instruct the subagent to `read` `AGENTS.md` and
  `docs/prompts/SPEC.md` directly from disk, in full, using the native `read`
  tool before doing any other work.
- Copying excerpts into a dispatch prompt instead of pointing at the files is a
  violation. The subagent reads the source of truth; the dispatcher does not
  retell it.
- `docs/prompts/SPEC.md` contains the VERBATIM content of `MASTER_BUILD_PROMPT.md`
  Sections 1 and 2. Any drift between them must be reported and fixed, never
  papered over.

## 2. Explicit Subagent Roles

Every delegation MUST declare its role explicitly via `"agent"`:

| Role | `agent` value | Responsibility |
|------|---------------|----------------|
| Coordinator | `agency-coordinator` | Wave planning, worktree lifecycle, merge gating. Never merges without QA + Drift Guard sign-off. |
| Programmer | `agency-programmer` | Implements production code and tests per `SPEC.md`. Zero stubs. Runs `bun test` and `bun run check` locally before reporting done. |
| QA | `agency-qa` | Runs `make check`, wave accept scripts (`scripts/accept/wave-*.sh`), and Red-Proof Sabotage per wave. Records evidence in `docs/evidence/wave-<N>/red-proofs.log`. |
| Drift Guard | `agency-drift-guard` | Audits scope, spec fidelity, and zero-stub compliance. Issues `VERDICT: PASS` or `VERDICT: FAIL` in `docs/reports/wave-<N>-verification.md`. |

- Never invent a new role name. Never assign QA work to the Programmer or
  implementation work to QA/Drift Guard.
- The binding triad gate (Section 6) requires all three verification voices
  (Programmer self-verification + QA + Drift Guard) before any merge to `main`.

## 3. Vanilla `read` / `edit` / `write` Hygiene

- Use native `read`, `write`, `edit`, `glob`, and `grep` for all file operations.
- NEVER use `cat`, `sed`, `awk`, or shell heredocs to view or modify files.
- NEVER include `read` line-number prefixes (e.g. `12: `) in `edit`
  `oldString`/`newString` values. Copy file content exactly, without prefixes.
- Fix `<diagnostics>` (type errors, lint errors) immediately when they are
  reported. Do not leave the tree in a failing state.
- Prefer one larger `read` over many small slices; use `grep` to locate content
  in large files first.

## 4. Strict Scope & Refusal Boundary for `heretek-context-router`

### 4.1 In-Scope (Goal 3)

This repository exists to solve exactly ONE goal:

- **Goal 3a — Stop OpenCode v2 context window overload:** cut 262,500 MCP schema
  tokens down to **<500 tokens** via **Lazy Meta-Tool Routing** (the
  `src/lazy-broker/*` stdio MCP server exposing ONLY 3 meta-tools:
  `mcp_search_tools`, `mcp_inspect_schema`, `mcp_call_tool`, backed by an
  embedded SQLite FTS5 / Okapi BM25 tool catalog).
- **Goal 3b — Prevent KV prompt cache invalidation across the 6 specialized
  agent roles:** via the **4-Layer Invariant Prompt Prefix Assembler**
  (`src/prefix-builder/assemble-prompt.ts`) and **Typed Handoff Envelopes**
  (`src/handoff/envelopes.ts`, Zod schemas `TaskBriefSchema`,
  `WorkerReceiptSchema`, `QaVerdictSchema`) plus Linux Foundation A2A
  `agent-card.json` manifests (`src/handoff/a2a-cards.ts`).

### 4.2 Forbidden — Refuse Immediately

The following are **FORBIDDEN IN THIS REPO**. If asked to build any of them
here, refuse fail-closed with a descriptive message and redirect to the correct
repository:

- **WebUI** — no web frontends, dashboards, or browser apps in this repo.
- **Git worktree manager** — no worktree orchestration tooling beyond the plain
  `git worktree add/remove` commands used for wave isolation.
- **Docker** — no Dockerfiles, compose files, or container tooling in this repo.

Refusal template:

> `REFUSED (scope boundary, AGENTS.md §4.2): <requested item> is forbidden in
> heretek-context-router, which is scoped exclusively to Goal 3 (Lazy Meta-Tool
> Routing <500 tokens + 4-Layer Invariant Prefix + Typed Handoffs).`

## 5. Zero Stubs, Zero Mocks, Zero Vacuous Tests Mandate

- Every interface, struct, function, route, role prompt, schema, router, and
  config generator must be **100% implemented with exact logic**. No
  placeholders, no skeleton files, no deferred work.
- Prohibited patterns (fail-closed — reject any diff containing them):
  - `TODO`, `FIXME`, `XXX`, `HACK`, `implement later`, `not implemented`
  - Dummy passes: `return true;`, `cmd: "true"`, `echo "passed"`
  - Swallowed errors: `catch (e) {}`, `|| true`, `set +e`, empty `catch` blocks
  - Empty mock fallbacks without functional implementation
  - Tests with no assertions, assertions on constants, or assertions that pass
    regardless of implementation (vacuous tests)
- If a dependency or helper does not exist, build it completely or use an
  established repository utility. Never stub around it.
- QA and Drift Guard MUST run the zero-stubs check every wave:
  `grep -rEn "TODO|FIXME|XXX|HACK|implement later|not implemented|return true;|echo \"passed\"|\\|\\| true|set \\+e" src roles configs test scripts`
  must return zero matches (excluding this very rule's mention in `AGENTS.md`).

## 6. Binding Triad Gate Rule

No wave merges to `main` unless ALL of the following hold:

1. **Programmer self-verification:** `bun test` and `bun run check`
   (`tsc --noEmit`) both exit 0 in the wave worktree. Evidence: wave report in
   `docs/reports/wave-<N>.md` with command outputs.
2. **QA Red-Proof Sabotage:** QA runs `make check`, `bash
   scripts/accept/wave-<N>.sh`, AND a sabotage proof per wave (e.g. prepend a
   role name at byte 0 of `assemblePrefixCachedPrompt` and confirm
   `test/prefix-cache.test.ts` fails immediately; restore cleanly with
   `git checkout -- <file>`). Evidence: `docs/evidence/wave-<N>/red-proofs.log`.
3. **Drift Guard verdict:** Drift Guard audits spec fidelity, scope, and
   zero-stub compliance and issues exactly `VERDICT: PASS` in
   `docs/reports/wave-<N>-verification.md`. `VERDICT: FAIL` blocks the merge,
   no exceptions, no overrides.

Merging with a missing or failing gate artifact is a process violation. When in
doubt, fail closed: block the merge and report.

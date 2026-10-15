# MASTER COORDINATOR BUILD PROMPT: REPO 3 — `heretek-context-router`
**Target Repository:** `/home/john/Projects/Heretek-AI-Rebuild/heretek-context-router`  
**GitHub Remote:** `https://github.com/Heretek-AI/heretek-context-router`  
**Package Name:** `@heretek-ai/heretek-context-router`  
**Primary Session Agent:** `agency-coordinator` (`opencode-go/muse-spark-1.3-contributor`)  
**Required Triad Subagents:** `agency-programmer`, `agency-qa`, `agency-drift-guard`

---

## 0. CRITICAL MUSE 1.3 HARNESS SUPPLEMENT (READ FIRST — NON-NEGOTIABLE)

You are running on `opencode-go/muse-spark-1.3-contributor`. Obey these six rules on every turn:

1. **ZERO PROMPT SUMMARIZATION WHEN CALLING SUBAGENTS:**
   - In Wave 0, write this entire specification into `docs/prompts/SPEC.md` and `AGENTS.md`. Every subagent call MUST instruct the subagent to `read` `AGENTS.md` and `docs/prompts/SPEC.md` directly from disk.
2. **EXPLICIT SUBAGENT ROLES:**
   - Always pass `"agent": "agency-programmer"`, `"agent": "agency-qa"`, or `"agent": "agency-drift-guard"` when calling `subagent`.
3. **VANILLA `read` / `edit` / `write` HYGIENE:**
   - Use native `read`, `write`, `edit`, `glob`, and `grep`—never `cat` or `sed`. Never include `read` line numbers (`12: `) in `edit` `oldString`/`newString`. Fix `<diagnostics>` immediately.
4. **STRICT SCOPE & REFUSAL BOUNDARY FOR `heretek-context-router`:**
   - This repository solves Goal 3: **stopping OpenCode v2 context window overload (cutting 262,500 MCP schema tokens down to <500 tokens via Lazy Meta-Tool Routing)** and **preventing KV prompt cache invalidation across the 6 specialized agent roles (via the 4-Layer Invariant Prompt Prefix Assembler and Typed Handoff Envelopes)**.
   - **FORBIDDEN IN THIS REPO:** Do NOT build a WebUI, git worktree manager, or Docker containers here.
5. **ZERO STUBS, ZERO MOCKS, ZERO VACUOUS TESTS:**
   - Every role prompt, schema, BM25/SQLite lazy tool catalog router, and config generator must be 100% implemented and tested.
6. **BINDING TRIAD GATE:**
   - Every wave requires `agency-qa` Red-Proof Sabotage (`docs/evidence/wave-<N>/red-proofs.log`) and `agency-drift-guard` `VERDICT: PASS` (`docs/reports/wave-<N>-verification.md`) before merging to `main`.

---

## 1. TARGET REPOSITORY ARCHITECTURE & FILE TREE

```text
/home/john/Projects/Heretek-AI-Rebuild/heretek-context-router/
├── AGENTS.md
├── Makefile
├── package.json                    # @heretek-ai/heretek-context-router
├── tsconfig.json
├── .skill-lock.json                # Version 3 lockfile (vercel-labs/skills format with skillFolderHash)
├── grimoire.lock                   # RFC 8785 JCS declaration_hash lockfile
├── configs/
│   ├── opencode.base.json          # Base OpenCode v2 config loading ONLY lazy router + context-mode (<500 tokens)
│   └── agentgateway.yaml           # Rust agentgateway CEL RBAC policy & backend MCP targets (ports/profiles)
├── roles/
│   ├── 00-shared-context.md        # Frozen canonical shared prefix (Layer 2: identical byte-for-byte across all 6 roles)
│   ├── director.md                 # Role 1: L0 Chief Orchestrator (edit denied; outputs Kanban DAG tasks)
│   ├── architect.md                # Role 2: L1 Principal Architect (edit restricted to contracts/** and tokens/**)
│   ├── manager.md                  # Role 3: L1 Tech Lead (edit denied; dispatches worktrees, requires QA PASS)
│   ├── staff-backend.md            # Role 4: L2 Polyglot Systems Builder (implements src/** + AppSec/Android profiles on demand)
│   ├── staff-ui.md                 # Role 5: L2 Design Engineer & UI Crafter (implements ui/web/** + DOM geometry gate)
│   └── qa-adversary.md             # Role 6: L2 Adversarial QA & SRE Auditor (edit denied on src/**; red-proof sabotage)
├── src/
│   ├── index.ts
│   ├── prefix-builder/
│   │   ├── assemble-prompt.ts      # 4-Layer Invariant Prompt Prefix Builder + RFC 8785 JCS tool schema canonicalizer
│   │   └── role-permissions.ts     # Generates exact OpenCode v2 permissions array per role +Superset Tool Masking
│   ├── handoff/
│   │   ├── envelopes.ts            # Zod schemas: TaskBriefSchema, WorkerReceiptSchema, QaVerdictSchema
│   │   └── a2a-cards.ts            # Generates Linux Foundation A2A `agent-card.json` manifests for each role
│   ├── lazy-broker/
│   │   ├── bm25-catalog.ts         # Embedded SQLite FTS5 / Okapi BM25 tool catalog indexing 100+ backend MCP tools
│   │   └── meta-router-mcp.ts      # Stdio MCP server exposing ONLY 3 meta-tools (`mcp_search_tools`, `mcp_inspect_schema`, `mcp_call_tool`) + profile wake hook
│   └── skills/
│       └── skill-mounter.ts        # Verifies `.skill-lock.json` tree SHA hashes and mounts task-scoped skills on demand
└── test/
    ├── prefix-cache.test.ts        # Proves byte-for-byte prefix equality from byte 0 to breakpoint 2 across all 6 roles!
    ├── handoff.test.ts             # Tests TaskBrief, WorkerReceipt, QaVerdict, and A2A agent cards
    ├── lazy-broker.test.ts         # Proves BM25 tool search ranks Android/Ghidra/Godot tools accurately in <5ms & token count <500
    └── skill-mounter.test.ts       # Proves tampered skill folder SHA is rejected fail-closed
```

---

## 2. EXACT MODULE SPECIFICATIONS (WRITE TO `docs/prompts/SPEC.md` IN WAVE 0)

### 2.1 Wave 1 Specification: 4-Layer Invariant Prompt Prefix Assembler & Typed Handoffs (`src/prefix-builder/*` & `src/handoff/*`)

1. **`src/prefix-builder/assemble-prompt.ts` (From Reports `01b` §7.2 & `03b` §5.4 / §6.3):**
   - **Why This Matters:** If role instructions or timestamps appear at Token 0, switching between `director`, `staff-backend`, and `qa-adversary` destroys the LLM provider's KV cache.
   - `export function canonicalizeToolSchemas(tools: Array<Record<string, unknown>>): string`:
     - Sorts tools alphabetically by `name`, and recursively sorts all JSON object keys lexicographically (RFC 8785 JCS) so tool definitions are 100% deterministic across turns.
   - `export function assemblePrefixCachedPrompt(options: { role: RoleId; workspaceRoot: string; taskBrief?: TaskBrief; activeProfile?: "core" | "appsec" | "android" | "game" | "research" }): { systemPrompt: string; frozenPrefixBytes: number; cacheBreakpoints: [number, number] }`:
     - **Layer 1 (Bytes `0 .. B1`):** Static Base Engine Invariant (POSIX/Linux, zero-stubs mandate, static superset tool protocol, **NO timestamps or UUIDs**).
     - **Layer 2 (Bytes `B1 .. B2`):** Full contents of `roles/00-shared-context.md`.
     - **Layer 3 (Bytes `B2 .. end`):** Role-specific suffix loaded from `roles/<role>.md` + `Authorized Mutation Scope: ${taskBrief?.ownedPaths.join(", ") ?? "NONE"}` + `Active Toolbox Profile: ${activeProfile ?? "core"}`.
     - **Contract:** For ANY two roles `roleA` and `roleB`, `promptA.systemPrompt.slice(0, promptA.frozenPrefixBytes) === promptB.systemPrompt.slice(0, promptB.frozenPrefixBytes)` MUST be `true`!

2. **`src/prefix-builder/role-permissions.ts` (From Report `03b` §6.1):**
   - Exports `ROLE_PERMISSION_MATRIX: Record<RoleId, PermissionRule[]>` matching the exact OpenCode v2 last-match-wins permission ruleset for `director`, `architect`, `manager`, `staff-backend`, `staff-ui`, and `qa-adversary`.

3. **`src/handoff/envelopes.ts` & `src/handoff/a2a-cards.ts` (From Report `03b` §4.1 & §6.2):**
   - Exports Zod schemas `TaskBriefSchema`, `WorkerReceiptSchema` (requiring 40-char git `commitHash`, `modifiedFiles`, `unitTestSummary`, `compilerCheckPassed`), and `QaVerdictSchema` (requiring `redProofEvidence` with `exitCodeDuringSabotage >= 1` and `revertedCleanly: true`).
   - Exports `generateA2AAgentCard(role: RoleId, baseUrl: string)` producing a valid Linux Foundation A2A v1.0.1 `agent-card.json`.

---

### 2.2 Wave 2 Specification: Lazy Meta-Tool Discovery Broker (`src/lazy-broker/*`)

1. **`src/lazy-broker/bm25-catalog.ts` (Inspired by `n2-QLN` & `MCPHub $smart` in Report `03a` §4.1):**
   - Uses `bun:sqlite` (in-memory or persisted SQLite database) to store backend MCP tool definitions (`server`, `profile`, `name`, `description`, `boostKeywords`, `inputSchemaJson`).
   - Implements Okapi BM25 + trigger keyword scoring:
     $$\text{Score} = \text{TriggerMatch} \times 3.0 + \text{BM25} \times 1.0 + \text{KeywordBoost} \times 2.0$$
   - Pre-populates the catalog with the 5 Heretek Compose profiles (`core`, `appsec`, `android`, `game`, `research` — including `ghidra-mcp`, `radare2-mcp`, `morluto/rea`, `iksnerd/adb-mcp`, `maestro`, `godot-mcp`, `blender-mcp`, `crawl4ai`, `searxng`, `computer-use-linux`).
2. **`src/lazy-broker/meta-router-mcp.ts`:**
   - Exposes **ONLY 3 meta-tools** in its `tools/list` response (keeping total schema token footprint `< 400` tokens!):
     1. `mcp_search_tools({ query: string, profile?: string, limit?: number })`: Returns top-$K$ matching tool names, profiles, and 1-line summaries (without dumping 50 full schemas).
     2. `mcp_inspect_schema({ toolName: string })`: Returns the full `inputSchema` for that single requested tool so the agent can call it accurately.
     3. `mcp_call_tool({ toolName: string, args: Record<string, unknown> })`: Checks the circuit breaker (trips open for 60s after 3 consecutive failures), checks CEL-style role authorization (`qa-adversary` and `director` cannot call mutating tools), and routes the call to the target backend MCP server.

---

### 2.3 Wave 3 Specification: Skill Lockfile Verifier (`src/skills/skill-mounter.ts`) & Production Configs (`configs/*`)

1. **`src/skills/skill-mounter.ts` (From Report `03a` §5.1 & §5.2):**
   - Reads `.skill-lock.json` (version 3) and `grimoire.lock` (verifying RFC 8785 JCS `declaration_hash`).
   - Computes deterministic SHA-256 tree hash of local skill directories; refuses to mount any skill whose directory hash mismatches `skillFolderHash` in `.skill-lock.json` (fail-closed).
2. **`configs/opencode.base.json` & `configs/agentgateway.yaml`:**
   - Generates the production `opencode.base.json` (wiring `@heretek-ai/opencode-harness`, `heretek-lazy-broker`, `n2-qln`, and `context-mode`) and `configs/agentgateway.yaml` (CEL policies for `:3000`).

---

## 3. WAVE-BY-WAVE TRIAD EXECUTION PLAN FOR `agency-coordinator`

### Step 0 (Coordinator Bootstrap on `main`)
1. Write `AGENTS.md`, `docs/prompts/SPEC.md`, `docs/prompts/verify-stage.md`, `Makefile`, `package.json`, and `tsconfig.json`.
2. Commit baseline scaffolding to `main`.

### Wave 1: 4-Layer Prompt Prefix Assembler, 6 Role Prompts & Typed Handoff Envelopes
1. Create worktree: `git worktree add -b wave-1-prefix-roles worktrees/wave-1 main`
2. Dispatch **Programmer (`agency-programmer`)**:
```json
{
  "agent": "agency-programmer",
  "description": "Wave 1 Programmer: Implement 4-layer prompt prefix builder, 6 role prompts, and handoff schemas",
  "prompt": "You are the Programmer Agent for Wave 1 in `/home/john/Projects/Heretek-AI-Rebuild/heretek-context-router/worktrees/wave-1` on branch `wave-1-prefix-roles`.\n\nFIRST: Read `AGENTS.md` and `docs/prompts/SPEC.md` in full.\nSECOND: Implement:\n1. `roles/00-shared-context.md` (comprehensive shared architectural invariants) and the 6 role files (`director.md`, `architect.md`, `manager.md`, `staff-backend.md`, `staff-ui.md`, `qa-adversary.md`).\n2. `src/prefix-builder/assemble-prompt.ts` and `src/prefix-builder/role-permissions.ts`.\n3. `src/handoff/envelopes.ts` and `src/handoff/a2a-cards.ts`.\n4. Write `test/prefix-cache.test.ts` and `test/handoff.test.ts`, `scripts/accept/wave-1.sh`, and `docs/reports/wave-1.md`.\n5. Verify `bun test` and `bun run check` exit 0, then commit."
}
```
3. Dispatch **QA (`agency-qa`)** to run `make check`, `bash scripts/accept/wave-1.sh`, and perform Red-Proof Sabotage (prepend role name at byte 0 of `assemblePrefixCachedPrompt` and confirm `test/prefix-cache.test.ts` fails immediately; restore cleanly with `git checkout --`). Record in `docs/evidence/wave-1/red-proofs.log`.
4. Dispatch **Drift Guard (`agency-drift-guard`)** to audit Wave 1 and issue `VERDICT: PASS` in `docs/reports/wave-1-verification.md`.
5. Merge `wave-1-prefix-roles` into `main` and remove worktree.

### Wave 2: Lazy Meta-Tool Discovery Broker (`bm25-catalog.ts` & `meta-router-mcp.ts`)
1. Create worktree: `git worktree add -b wave-2-lazy-broker worktrees/wave-2 main`
2. Dispatch **Programmer (`agency-programmer`)** to implement `src/lazy-broker/bm25-catalog.ts`, `src/lazy-broker/meta-router-mcp.ts`, `test/lazy-broker.test.ts` (asserting that `tools/list` returns <= 3 meta-tools and `< 500` estimated tokens while indexing 30+ domain tools across the 5 profiles), `scripts/accept/wave-2.sh`, and `docs/reports/wave-2.md`.
3. Dispatch **QA (`agency-qa`)** and **Drift Guard (`agency-drift-guard`)** to verify and red-proof Wave 2 (`VERDICT: PASS`).
4. Merge `wave-2-lazy-broker` into `main` and remove worktree.

### Wave 3: Skill Lockfile Verifier (`skill-mounter.ts`), Configs (`opencode.base.json`, `agentgateway.yaml`) & Final Entrypoint
1. Create worktree: `git worktree add -b wave-3-skills-configs worktrees/wave-3 main`
2. Dispatch **Programmer (`agency-programmer`)** to implement `src/skills/skill-mounter.ts`, `.skill-lock.json`, `grimoire.lock`, `configs/opencode.base.json`, `configs/agentgateway.yaml`, `src/index.ts`, `test/skill-mounter.test.ts`, `scripts/accept/wave-3.sh`, `README.md`, and `docs/reports/wave-3.md`.
3. Dispatch **QA (`agency-qa`)** and **Drift Guard (`agency-drift-guard`)** to verify and red-proof Wave 3 (`VERDICT: PASS`).
4. Merge `wave-3-skills-configs` into `main`, remove worktree, and verify `make check && make accept` exits 0 on `main`.

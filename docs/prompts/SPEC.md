# SPEC.md — Authoritative Build Specification for `heretek-context-router`

> PROVENANCE: The content below (Sections 1 and 2, including §§2.1, 2.2, 2.3)
> is reproduced VERBATIM from `MASTER_BUILD_PROMPT.md` with zero summarization,
> zero truncation, and zero paraphrase. In case of any discrepancy between this
> file and `MASTER_BUILD_PROMPT.md`, `MASTER_BUILD_PROMPT.md` governs and this
> file must be corrected to match it byte-for-byte.

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

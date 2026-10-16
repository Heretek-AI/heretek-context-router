# heretek-context-router

Lazy meta-tool routing (<500 tokens) and 4-layer invariant prompt prefix
routing for OpenCode v2 multi-agent orchestration.

## Production usage

### 1. Install and verify

```bash
bun install
bun run check   # tsc --noEmit, strict
bun test        # full suite: prefix-cache, handoff, lazy-broker, skill-mounter
bash scripts/accept/wave-3.sh  # Wave 3 gate (also run wave-1/wave-2 for regression)
```

### 2. Prompt prefix (KV-cache stable, Goal 3b)

```ts
import { assemblePrefixCachedPrompt } from "./src/index.ts";

const prompt = assemblePrefixCachedPrompt({
  role: "staff-backend",
  workspaceRoot: process.cwd(),
  activeProfile: "android",
});
// prompt.systemPrompt.slice(0, prompt.frozenPrefixBytes) is identical
// byte-for-byte for all 6 roles (Layers 1+2 frozen).
```

### 3. Lazy tool discovery (Goal 3a, <500 tokens upfront)

```ts
import { searchTools, inspectToolSchema, callTool } from "./src/index.ts";

const hits = searchTools({ query: "android adb install apk", profile: "android" });
const schema = inspectToolSchema({ toolName: hits[0].name });
await callTool({ toolName: hits[0].name, args: {} }, { role: "staff-backend" });
```

Only 3 meta-tools (`mcp_search_tools`, `mcp_inspect_schema`, `mcp_call_tool`,
~240 estimated tokens) are loaded. Point OpenCode at
`configs/opencode.base.json`, which loads ONLY `heretek-lazy-broker` plus
`context-mode`; every domain backend (`n2-qln`, `ghidra-mcp`, `adb-maestro`,
`godot`, research) resolves lazily through the `agentgateway` on `:3000`
(see `configs/agentgateway.yaml` CEL policies).

### 4. Task-scoped skills (Wave 3, verified mount)

Skills ship with SHA-256 tree hashes pinned in `.skill-lock.json` (version 3)
and a `grimoire.lock` RFC 8785 JCS `declaration_hash`:

```ts
import { verifySkillLock, verifyGrimoireLock, mountSkill } from "./src/index.ts";

verifySkillLock({ workspaceRoot: process.cwd() });      // throws on any mismatch
verifyGrimoireLock({ workspaceRoot: process.cwd() });   // throws on tamper
const skill = mountSkill({
  workspaceRoot: process.cwd(),
  skillName: "lazy-search",
  verifyGrimoire: true,                                 // verify both locks
});
console.log(skill.skillMd); // SKILL.md content, safe to inject into context
```

Any tampered byte inside a locked skill directory changes the tree hash and
`mountSkill`/`verifySkillLock` refuse fail-closed with
`SkillHashMismatchError` — proven by `test/skill-mounter.test.ts`.

### 5. Layout

- `src/prefix-builder/` — 4-layer invariant prefix + per-role permissions
- `src/handoff/` — typed handoff envelopes + A2A agent cards
- `src/lazy-broker/` — BM25 catalog + 3-meta-tool stdio broker
- `src/skills/skill-mounter.ts` — lockfile verifier + task-scoped mounter
- `skills/` — mountable skill dirs (`lazy-search`, `red-proof`), each with `SKILL.md`
- `configs/` — `opencode.base.json`, `agentgateway.yaml`
- `roles/` — frozen shared context + 6 role prompts

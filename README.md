# heretek-context-router

Lazy meta-tool routing (<500 tokens) and 4-layer invariant prompt prefix
routing for OpenCode v2 multi-agent orchestration.

## Production usage

### 1. Install and verify

```bash
bun install
bun run check   # tsc --noEmit, strict
bun test        # prefix-cache, handoff, lazy-broker, http transport, discovery, stdio server, skill-mounter
make accept     # runs scripts/accept/wave-1.sh, wave-2.sh, wave-3.sh in order; stops at the first failure
```

CI (`.github/workflows/ci.yml`) runs `make check` and `make accept` on every
pull request and on pushes to `main`.

### 2. Prompt prefix (KV-cache stable, Goal 3b)

The prefix assembler is a library, not an MCP server. Callers (the harness
plugin, or any orchestrator) import it and use the result as the system
prompt for each role:

```ts
import { assemblePrefixCachedPrompt } from "@heretek-ai/heretek-context-router/src/index.ts";

const prompt = assemblePrefixCachedPrompt({
  role: "staff-backend",
  workspaceRoot: "/path/to/workspace",   // must contain roles/
  activeProfile: "android",
});
// prompt.systemPrompt.slice(0, prompt.frozenPrefixBytes) is identical
// byte-for-byte for all 6 roles (Layers 1+2 frozen); prompt.cacheBreakpoints
// are the byte offsets to place provider cache breakpoints at.
```

### 3. Lazy tool discovery (Goal 3a, <500 tokens upfront)

The broker is an MCP stdio server exposing only 3 meta-tools
(`mcp_search_tools`, `mcp_inspect_schema`, `mcp_call_tool`, ~240 estimated
tokens). Install its `heretek-lazy-broker` bin once so it runs from any
working directory:

```bash
bun link            # from this repo; puts heretek-lazy-broker on ~/.bun/bin
```

`configs/opencode.base.json` registers it with the OpenCode v2 native shape
(`plugins` + `mcp.servers.<name> = { type: "local", command, environment }`)
and nothing else:

```json
"mcp": { "servers": { "heretek-lazy-broker": {
  "type": "local", "command": ["heretek-lazy-broker"],
  "environment": { "HERETEK_GATEWAY_URL": "http://127.0.0.1:3000" } } } }
```

Broker environment:

| Variable | Default | Meaning |
|----------|---------|---------|
| `HERETEK_GATEWAY_URL` | `http://127.0.0.1:3000` | agentgateway base URL |
| `HERETEK_GATEWAY_MODE` | `per-target` | `per-target` (`/mcp/<target>` routes) or `multiplexed` (one `/mcp` route) |
| `HERETEK_GATEWAY_TOKEN` | unset | sent as `Authorization: Bearer …` |
| `HERETEK_GATEWAY_TIMEOUT_MS` | `30000` | per-request timeout |
| `HERETEK_BROKER_ROLE` | `director` | caller role for the authorization gate; also sent to the gateway as `x-heretek-role`. The default is read-only (fail closed): set a writer role per agent to allow mutating tools |
| `HERETEK_DISCOVERY_TTL_MS` | `300000` | re-run discovery on the next search after this long |
| `HERETEK_BROKER_OFFLINE` | unset | `1` = do not contact the gateway; serve the offline seed catalog |

How a call flows: `mcp_call_tool` -> circuit breaker (open 60s after 3
consecutive backend failures) -> role check (`director` and `qa-adversary`
cannot call mutating tools) -> argument check against the tool's schema ->
MCP Streamable HTTP `tools/call` to agentgateway. The transport POSTs
JSON-RPC, accepts `application/json` or `text/event-stream` replies, runs
`initialize` once per backend and echoes the `Mcp-Session-Id` it gets back
(re-initializing once if the session expires).

Catalog: at startup the broker calls `tools/list` on every backend through
the gateway and replaces that backend's entries in the BM25 catalog. The 34
built-in tools are only an offline seed, kept for a backend until its
discovery succeeds. Discovered tools count as mutating unless the backend
marks them `readOnlyHint: true`.

Tool names follow agentgateway's multiplexing convention, `<target>_<tool>`
(agentgateway joins target and tool with `_` and splits on the first `_`, so
target names never contain `_`). In `per-target` mode each route holds one
target, so agentgateway forwards names unprefixed and the broker sends the
bare `<tool>`; in `multiplexed` mode it sends the full `<target>_<tool>`.

| Backend | Target | Profile |
|---------|--------|---------|
| heretek-core | `core` | core |
| ghidra-mcp | `ghidra` | appsec |
| radare2-mcp | `radare2` | appsec |
| morluto/rea | `rea` | appsec |
| mdb-mcp | `mdb` | appsec |
| iksnerd/adb-mcp | `adb` | android |
| maestro | `maestro` | android |
| godot-mcp | `godot` | game |
| blender-mcp | `blender` | game |
| crawl4ai | `crawl4ai` | research |
| searxng | `searxng` | research |
| computer-use-linux | `gui` | research |

#### Gateway config

This repo does not ship a gateway config. The deployed one is
`heretek-devcontainers/compose/agentgateway.yaml`, which is canonical. For the broker to reach a
backend it needs one route per target in agentgateway's schema, for example:

```yaml
binds:
- port: 3000
  listeners:
  - routes:
    - name: ghidra
      matches:
      - path:
          pathPrefix: /mcp/ghidra
      backends:
      - mcp:
          targets:
          - name: ghidra
            mcp:
              host: http://ghidra-mcp:8089/mcp
```

That shape passes `agentgateway --validate-only` (v1.6.0). It was also
tested end to end with the broker: discovery and calls worked in both
`per-target` and `multiplexed` modes, with SSE replies and session ids. Role
enforcement lives in the broker, so it holds no matter how the gateway is
configured.

Library use (the same three operations, no stdio):

```ts
import { searchTools, inspectToolSchema, callTool } from "@heretek-ai/heretek-context-router/src/index.ts";

const hits = searchTools({ query: "android adb install apk", profile: "android" });
const schema = inspectToolSchema(hits[0].name);
await callTool({ toolName: hits[0].name, args: { serial: "emulator-5554", apk: "app.apk" } }, { role: "staff-backend" });
```

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
- `src/lazy-broker/` — BM25 catalog (`bm25-catalog.ts`), meta-tools + auth +
  breaker + discovery (`meta-router-mcp.ts`, also the `heretek-lazy-broker`
  bin), stdio server (`mcp-server.ts`), Streamable HTTP client
  (`http-transport.ts`), gateway wiring (`gateway.ts`, `backends.ts`)
- `src/skills/skill-mounter.ts` — lockfile verifier + task-scoped mounter
- `skills/` — mountable skill dirs (`lazy-search`, `red-proof`), each with `SKILL.md`
- `configs/` — `opencode.base.json`
- `roles/` — frozen shared context + 6 role prompts

### Deviation from the original build spec

`docs/prompts/SPEC.md` and `MASTER_BUILD_PROMPT.md` list a `context-mode` MCP
entry and a local `configs/agentgateway.yaml`. Both were removed on purpose:

- The prefix assembler is a library, so it has no MCP server to register.
- The local gateway file was not valid for agentgateway v1.6.0 and pointed at
  ports nothing listens on. The devcontainers copy is the one that is deployed.

The spec files are kept verbatim per AGENTS.md section 1.

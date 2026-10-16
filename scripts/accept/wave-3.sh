#!/usr/bin/env bash
# Wave 3 accept script: Skill Lockfile Verifier + production configs.
# Fail-closed: strict mode, no permissive fallbacks.
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "=== wave-3 accept: typecheck ==="
bun run check

echo "=== wave-3 accept: test suite ==="
bun test

echo "=== wave-3 accept: skill lock verification (positive) ==="
bun -e '
import { verifySkillLock, verifyGrimoireLock, mountSkill } from "./src/skills/skill-mounter.ts";
const root = process.cwd();
const results = verifySkillLock({ workspaceRoot: root });
if (results.length < 1) {
  console.error("FAIL: expected at least 1 locked skill");
  process.exit(1);
}
for (const r of results) {
  if (r.expectedHash !== r.actualHash) {
    console.error(`FAIL: skill ${r.name} hash mismatch`);
    process.exit(1);
  }
}
const g = verifyGrimoireLock({ workspaceRoot: root });
if (!g.declarationHash) {
  console.error("FAIL: grimoire declaration_hash missing");
  process.exit(1);
}
const mounted = mountSkill({ workspaceRoot: root, skillName: results[0].name, verifyGrimoire: true });
if (!mounted.skillMd.includes("SKILL") && mounted.skillMd.length === 0) {
  console.error("FAIL: mounted skill has empty SKILL.md");
  process.exit(1);
}
console.log(`PASS: ${results.length} locked skills verify; grimoire ${g.declarationHash.slice(0, 12)}...; mounted ${mounted.name}`);
'

echo "=== wave-3 accept: tamper rejection spot check (sandboxed) ==="
bun -e '
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeTreeHash, verifySkillLock, SkillHashMismatchError } from "./src/skills/skill-mounter.ts";
const dir = mkdtempSync(join(tmpdir(), "wave3-accept-"));
try {
  mkdirSync(join(dir, "skills", "victim"), { recursive: true });
  writeFileSync(join(dir, "skills", "victim", "SKILL.md"), "# Victim\n\nPristine.\n");
  const pristine = computeTreeHash(join(dir, "skills", "victim"));
  const lock = join(dir, ".skill-lock.json");
  writeFileSync(lock, JSON.stringify({ version: 3, skills: [{ name: "victim", skillDir: "skills/victim", skillFolderHash: pristine }] }));
  verifySkillLock({ workspaceRoot: dir, lockPath: lock });
  appendFileSync(join(dir, "skills", "victim", "SKILL.md"), "tamper\n");
  let rejected = false;
  try {
    verifySkillLock({ workspaceRoot: dir, lockPath: lock });
  } catch (error) {
    if (error instanceof SkillHashMismatchError) rejected = true;
    else throw error;
  }
  if (!rejected) {
    console.error("FAIL: tampered skill directory was NOT rejected");
    process.exit(1);
  }
  console.log("PASS: tampered skill directory rejected fail-closed (SkillHashMismatchError)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
'

echo "=== wave-3 accept: production configs ==="
bun -e '
import { readFileSync, existsSync, statSync } from "node:fs";
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
if (!existsSync("configs/opencode.base.json")) fail("configs/opencode.base.json missing");
const base = JSON.parse(readFileSync("configs/opencode.base.json", "utf8"));
// OpenCode v2 native shape: mcp.servers.<name> = { type: "local", command: [...] }
const servers = base.mcp?.servers ?? {};
const names = Object.keys(servers);
if (names.length !== 1 || names[0] !== "heretek-lazy-broker") {
  fail(`opencode.base.json must load ONLY heretek-lazy-broker under mcp.servers, got: ${names.join(", ") || "(none)"}`);
}
const broker = servers["heretek-lazy-broker"];
if (broker.type !== "local" || !Array.isArray(broker.command) || broker.command.length === 0) {
  fail("heretek-lazy-broker must be a local MCP server with a command array");
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const binPath = pkg.bin?.[broker.command[0]];
if (typeof binPath !== "string") fail(`command "${broker.command[0]}" is not a package.json bin entry`);
if (!readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env bun\n")) fail(`${binPath} lacks a bun shebang`);
if ((statSync(binPath).mode & 0o111) === 0) fail(`${binPath} is not executable`);
if (JSON.stringify(base).includes("context-mode")) fail("context-mode is a library, not an MCP server; it must not be registered");
if (!(base.plugins ?? []).includes("@heretek-ai/opencode-harness")) fail("plugins must include @heretek-ai/opencode-harness");
if (base.tokenBudget?.maxUpfrontSchemaTokens !== 500) fail("tokenBudget.maxUpfrontSchemaTokens must be 500");
if (existsSync("configs/agentgateway.yaml")) {
  fail("configs/agentgateway.yaml must not exist: heretek-devcontainers compose/agentgateway.yaml is canonical");
}
console.log(`PASS: opencode.base.json loads only heretek-lazy-broker via bin ${binPath}; no duplicate gateway config`);
'

echo "=== wave-3 accept: broker bin serves MCP over stdio ==="
bun -e '
const pkg = JSON.parse(await Bun.file("package.json").text());
const bin = pkg.bin["heretek-lazy-broker"];
const proc = Bun.spawn([`./${bin}`], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, HERETEK_BROKER_OFFLINE: "1" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "accept", version: "1" } } }) + "\n");
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
proc.stdin.end();
const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
const code = await proc.exited;
const byId = new Map(lines.map((m) => [m.id, m]));
const tools = byId.get(2)?.result?.tools?.map((t) => t.name) ?? [];
if (code !== 0 || byId.get(1)?.result?.protocolVersion !== "2025-06-18" || tools.length !== 3 || lines.length !== 2) {
  console.error(`FAIL: broker stdio handshake (exit ${code}): ${JSON.stringify(lines)}`);
  process.exit(1);
}
console.log(`PASS: ${bin} answered initialize + tools/list over stdio (${tools.join(", ")}) and exited 0`);
'

echo "=== wave-3 accept: gitignore evidence hygiene ==="
if ! grep -q '!docs/evidence/\*\*/red-proofs.log' .gitignore; then
  echo "FAIL: .gitignore must un-ignore docs/evidence/**/red-proofs.log" >&2
  exit 1
fi
echo "PASS: .gitignore keeps red-proofs.log tracked"

echo "=== wave-3 accept: ALL CHECKS PASSED ==="

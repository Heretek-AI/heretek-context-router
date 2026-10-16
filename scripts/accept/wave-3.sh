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
import { readFileSync, existsSync } from "node:fs";
if (!existsSync("configs/opencode.base.json")) {
  console.error("FAIL: configs/opencode.base.json missing");
  process.exit(1);
}
const base = JSON.parse(readFileSync("configs/opencode.base.json", "utf8"));
const mcpNames = Object.keys(base.mcp ?? {});
if (mcpNames.length !== 2 || !mcpNames.includes("heretek-lazy-broker") || !mcpNames.includes("context-mode")) {
  console.error(`FAIL: opencode.base.json must load ONLY heretek-lazy-broker + context-mode, got: ${mcpNames.join(", ")}`);
  process.exit(1);
}
if (base.tokenBudget?.maxUpfrontSchemaTokens !== 500) {
  console.error("FAIL: tokenBudget.maxUpfrontSchemaTokens must be 500");
  process.exit(1);
}
for (const dep of ["@heretek-ai/opencode-harness", "heretek-lazy-broker", "n2-qln", "context-mode"]) {
  if (!JSON.stringify(base).includes(dep)) {
    console.error(`FAIL: opencode.base.json must wire ${dep}`);
    process.exit(1);
  }
}
if (!existsSync("configs/agentgateway.yaml")) {
  console.error("FAIL: configs/agentgateway.yaml missing");
  process.exit(1);
}
const gw = readFileSync("configs/agentgateway.yaml", "utf8");
for (const needle of ["port: 3000", "cel:", "qa-adversary", "director"]) {
  if (!gw.includes(needle)) {
    console.error(`FAIL: agentgateway.yaml missing required fragment: ${needle}`);
    process.exit(1);
  }
}
console.log("PASS: opencode.base.json (lazy router + context-mode only, <500 tokens) and agentgateway.yaml (CEL, :3000)");
'

echo "=== wave-3 accept: gitignore evidence hygiene ==="
if ! grep -q '!docs/evidence/\*\*/red-proofs.log' .gitignore; then
  echo "FAIL: .gitignore must un-ignore docs/evidence/**/red-proofs.log" >&2
  exit 1
fi
echo "PASS: .gitignore keeps red-proofs.log tracked"

echo "=== wave-3 accept: ALL CHECKS PASSED ==="

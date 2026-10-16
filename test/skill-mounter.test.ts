import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GrimoireHashMismatchError,
  SkillHashMismatchError,
  SkillLockVersionError,
  UnknownSkillError,
  computeTreeHash,
  listLockedSkills,
  loadSkillLock,
  mountSkill,
  verifyGrimoireLock,
  verifySkillLock,
} from "../src/skills/skill-mounter.ts";

const WORKSPACE_ROOT = process.cwd();
const LOCK_PATH = join(WORKSPACE_ROOT, ".skill-lock.json");
const GRIMOIRE_PATH = join(WORKSPACE_ROOT, "grimoire.lock");

describe("skill lockfile: positive verification", () => {
  test("lockfile is version 3 with two locked skills", () => {
    const lock = loadSkillLock(LOCK_PATH);
    expect(lock.version).toBe(3);
    expect(lock.skills.map((s) => s.name).sort()).toEqual(["lazy-search", "red-proof"]);
  });

  test("verifySkillLock passes green and echoes matching hashes", () => {
    const results = verifySkillLock({ workspaceRoot: WORKSPACE_ROOT });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.expectedHash).toBe(r.actualHash);
      expect(r.expectedHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("listLockedSkills reports both skills", () => {
    expect(listLockedSkills(LOCK_PATH).sort()).toEqual(["lazy-search", "red-proof"]);
  });

  test("grimoire declaration_hash verifies against RFC 8785 JCS canonicalization", () => {
    const { declarationHash } = verifyGrimoireLock({ workspaceRoot: WORKSPACE_ROOT });
    expect(declarationHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("mountSkill: positive mounts", () => {
  test("mounts lazy-search with SKILL.md content", () => {
    const mounted = mountSkill({ workspaceRoot: WORKSPACE_ROOT, skillName: "lazy-search" });
    expect(mounted.name).toBe("lazy-search");
    expect(mounted.skillDir).toBe("skills/lazy-search");
    expect(mounted.skillFolderHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mounted.skillMd).toContain("Lazy Search Skill");
    expect(mounted.skillMd.length).toBeGreaterThan(100);
  });

  test("mounts red-proof with SKILL.md content", () => {
    const mounted = mountSkill({ workspaceRoot: WORKSPACE_ROOT, skillName: "red-proof" });
    expect(mounted.name).toBe("red-proof");
    expect(mounted.skillMd).toContain("Red-Proof Skill");
  });

  test("mount with verifyGrimoire succeeds when grimoire is intact", () => {
    const mounted = mountSkill({
      workspaceRoot: WORKSPACE_ROOT,
      skillName: "lazy-search",
      verifyGrimoire: true,
    });
    expect(mounted.name).toBe("lazy-search");
  });

  test("unknown skill name is rejected fail-closed", () => {
    expect(() =>
      mountSkill({ workspaceRoot: WORKSPACE_ROOT, skillName: "no-such-skill" }),
    ).toThrow(UnknownSkillError);
  });
});

describe("fail-closed: tamper detection", () => {
  let sandbox: string;
  let sandboxLock: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "skill-tamper-"));
    mkdirSync(join(sandbox, "skills", "victim"), { recursive: true });
    writeFileSync(join(sandbox, "skills", "victim", "SKILL.md"), "# Victim\n\nPristine content.\n");
    const pristine = computeTreeHash(join(sandbox, "skills", "victim"));
    sandboxLock = join(sandbox, ".skill-lock.json");
    writeFileSync(
      sandboxLock,
      JSON.stringify({
        version: 3,
        skills: [{ name: "victim", skillDir: "skills/victim", skillFolderHash: pristine }],
      }),
    );
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("one appended byte changes the tree hash and verifySkillLock throws SkillHashMismatchError", () => {
    const before = verifySkillLock({ workspaceRoot: sandbox, lockPath: sandboxLock });
    expect(before).toHaveLength(1);
    appendFileSync(join(sandbox, "skills", "victim", "SKILL.md"), "tampered-byte\n");
    let thrown: unknown = null;
    try {
      verifySkillLock({ workspaceRoot: sandbox, lockPath: sandboxLock });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SkillHashMismatchError);
    const mismatch = thrown as SkillHashMismatchError;
    expect(mismatch.code).toBe("SKILL_HASH_MISMATCH");
    expect(mismatch.skillName).toBe("victim");
    expect(mismatch.expectedHash).not.toBe(mismatch.actualHash);
  });

  test("mountSkill refuses a tampered skill directory fail-closed", () => {
    appendFileSync(join(sandbox, "skills", "victim", "SKILL.md"), "evil\n");
    expect(() =>
      mountSkill({ workspaceRoot: sandbox, skillName: "victim", lockPath: sandboxLock }),
    ).toThrow(SkillHashMismatchError);
  });

  test("computeTreeHash is deterministic across repeated calls", () => {
    const a = computeTreeHash(join(sandbox, "skills", "victim"));
    const b = computeTreeHash(join(sandbox, "skills", "victim"));
    expect(a).toBe(b);
  });
});

describe("fail-closed: lockfile and grimoire rejection paths", () => {
  test("wrong lockfile version is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-version-"));
    try {
      const bad = join(dir, ".skill-lock.json");
      writeFileSync(bad, JSON.stringify({ version: 2, skills: [] }));
      expect(() => loadSkillLock(bad)).toThrow(SkillLockVersionError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tampered grimoire declaration_hash is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "grimoire-tamper-"));
    try {
      const pristine = JSON.parse(readFileSync(GRIMOIRE_PATH, "utf8")) as {
        declarations: Record<string, unknown>;
        declaration_hash: string;
      };
      const tampered = join(dir, "grimoire.lock");
      writeFileSync(
        tampered,
        JSON.stringify({
          declarations: { ...pristine.declarations, injected: true },
          declaration_hash: pristine.declaration_hash,
        }),
      );
      expect(() =>
        verifyGrimoireLock({ workspaceRoot: WORKSPACE_ROOT, grimoirePath: tampered }),
      ).toThrow(GrimoireHashMismatchError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

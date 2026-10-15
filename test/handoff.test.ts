import { describe, expect, test } from "bun:test";
import {
  QaVerdictSchema,
  TaskBriefSchema,
  WorkerReceiptSchema,
  type QaVerdict,
  type TaskBrief,
  type WorkerReceipt,
} from "../src/handoff/envelopes.ts";
import { generateA2AAgentCard } from "../src/handoff/a2a-cards.ts";
import {
  ALL_ROLES,
  type RoleId,
} from "../src/prefix-builder/assemble-prompt.ts";
import {
  ROLE_PERMISSION_MATRIX,
  evaluatePermission,
  matchRulePattern,
} from "../src/prefix-builder/role-permissions.ts";

const VALID_HASH = "a".repeat(40);
const OTHER_HASH = "0123456789abcdef0123456789abcdef01234567";

function validBrief(overrides: Partial<TaskBrief> = {}): TaskBrief {
  return {
    taskId: "wave-1-brief",
    title: "Assemble prefix",
    objective: "Build the 4-layer prefix assembler with exact logic.",
    ownedPaths: ["src/prefix-builder"],
    acceptCriteria: ["bun test exits 0", "bun run check exits 0"],
    ...overrides,
  };
}

function validReceipt(overrides: Partial<WorkerReceipt> = {}): WorkerReceipt {
  return {
    taskId: "wave-1-brief",
    role: "staff-backend",
    commitHash: VALID_HASH,
    modifiedFiles: ["src/prefix-builder/assemble-prompt.ts"],
    unitTestSummary: { passed: 12, failed: 0, total: 12 },
    compilerCheckPassed: true,
    ...overrides,
  };
}

function validVerdict(overrides: Partial<QaVerdict> = {}): QaVerdict {
  return {
    taskId: "wave-1-brief",
    verdict: "pass",
    redProofEvidence: {
      sabotageDescription: "Prepended role name at byte 0 of assembled prompt.",
      exitCodeDuringSabotage: 1,
      revertedCleanly: true,
      logExcerpt: "error: frozen prefix mismatch at byte 0",
    },
    checkedReceiptCommit: OTHER_HASH,
    ...overrides,
  };
}

describe("TaskBriefSchema", () => {
  test("accepts a complete brief and echoes typed fields", () => {
    const parsed = TaskBriefSchema.parse(validBrief());
    expect(parsed.taskId).toBe("wave-1-brief");
    expect(parsed.ownedPaths).toEqual(["src/prefix-builder"]);
    expect(parsed.acceptCriteria.length).toBe(2);
  });

  test("accepts optional role and profile bindings", () => {
    const parsed = TaskBriefSchema.parse(
      validBrief({ role: "staff-backend", activeProfile: "appsec" }),
    );
    expect(parsed.role).toBe("staff-backend");
    expect(parsed.activeProfile).toBe("appsec");
  });

  test("rejects missing objective, empty scope, and escaping paths", () => {
    expect(() =>
      TaskBriefSchema.parse({ ...validBrief(), objective: "" }),
    ).toThrow();
    expect(() => TaskBriefSchema.parse(validBrief({ ownedPaths: [] }))).toThrow();
    expect(() =>
      TaskBriefSchema.parse(validBrief({ ownedPaths: ["../outside"] })),
    ).toThrow();
    expect(() =>
      TaskBriefSchema.parse(validBrief({ ownedPaths: ["/absolute/root"] })),
    ).toThrow();
    expect(() =>
      TaskBriefSchema.parse({ ...validBrief(), taskId: undefined }),
    ).toThrow();
  });

  test("rejects unknown roles and profiles, and strips nothing silently", () => {
    expect(() =>
      TaskBriefSchema.parse(validBrief({ role: "intruder" as RoleId })),
    ).toThrow();
    expect(() =>
      TaskBriefSchema.parse(validBrief({ activeProfile: "nope" as "core" })),
    ).toThrow();
    expect(() =>
      TaskBriefSchema.parse({ ...validBrief(), smuggled: "x" }),
    ).toThrow();
  });
});

describe("WorkerReceiptSchema", () => {
  test("accepts a receipt with a 40-char hash and consistent test summary", () => {
    const parsed = WorkerReceiptSchema.parse(validReceipt());
    expect(parsed.commitHash).toHaveLength(40);
    expect(parsed.compilerCheckPassed).toBe(true);
    expect(parsed.unitTestSummary.total).toBe(
      parsed.unitTestSummary.passed + parsed.unitTestSummary.failed,
    );
  });

  test("rejects short hashes, uppercase hashes, and empty file lists", () => {
    expect(() =>
      WorkerReceiptSchema.parse(validReceipt({ commitHash: "abc123" })),
    ).toThrow(/commitHash/);
    expect(() =>
      WorkerReceiptSchema.parse(validReceipt({ commitHash: "A".repeat(40) })),
    ).toThrow(/commitHash/);
    expect(() =>
      WorkerReceiptSchema.parse(validReceipt({ modifiedFiles: [] })),
    ).toThrow();
  });

  test("rejects failed compiler checks and inconsistent summaries", () => {
    expect(() =>
      WorkerReceiptSchema.parse(
        validReceipt({ compilerCheckPassed: false as unknown as true }),
      ),
    ).toThrow();
    expect(() =>
      WorkerReceiptSchema.parse(
        validReceipt({ unitTestSummary: { passed: 5, failed: 0, total: 9 } }),
      ),
    ).toThrow(/total/);
  });
});

describe("QaVerdictSchema", () => {
  test("accepts a passing verdict with sabotage evidence", () => {
    const parsed = QaVerdictSchema.parse(validVerdict());
    expect(parsed.verdict).toBe("pass");
    expect(parsed.redProofEvidence.exitCodeDuringSabotage).toBeGreaterThanOrEqual(1);
    expect(parsed.redProofEvidence.revertedCleanly).toBe(true);
  });

  test("rejects zero exit codes and un-reverted sabotage", () => {
    expect(() =>
      QaVerdictSchema.parse(
        validVerdict({
          redProofEvidence: {
            ...validVerdict().redProofEvidence,
            exitCodeDuringSabotage: 0,
          },
        }),
      ),
    ).toThrow(/exitCodeDuringSabotage/);
    expect(() =>
      QaVerdictSchema.parse(
        validVerdict({
          redProofEvidence: {
            ...validVerdict().redProofEvidence,
            revertedCleanly: false as unknown as true,
          },
        }),
      ),
    ).toThrow(/revertedCleanly/);
  });

  test("rejects empty sabotage descriptions and malformed receipt commits", () => {
    expect(() =>
      QaVerdictSchema.parse(
        validVerdict({
          redProofEvidence: { ...validVerdict().redProofEvidence, logExcerpt: "" },
        }),
      ),
    ).toThrow();
    expect(() =>
      QaVerdictSchema.parse(validVerdict({ checkedReceiptCommit: "short" })),
    ).toThrow();
  });
});

describe("generateA2AAgentCard", () => {
  test("produces a valid A2A v1.0.1 card for every role", () => {
    for (const role of ALL_ROLES) {
      const card = generateA2AAgentCard(role as RoleId, "https://router.heretek.ai");
      expect(card.name).toBe(`heretek-${role}`);
      expect(card.url).toBe(`https://router.heretek.ai/a2a/${role}`);
      expect(card.version).toBe("1.0.1");
      expect(card.protocolVersion).toBe("1.0.1");
      expect(card.capabilities.streaming).toBe(true);
      expect(card.defaultInputModes).toContain("text");
      expect(card.defaultOutputModes).toContain("text");
      expect(card.provider.organization).toBe("Heretek-AI");
      expect(card.skills.length).toBeGreaterThanOrEqual(2);
      for (const skill of card.skills) {
        expect(skill.id.length).toBeGreaterThan(0);
        expect(skill.name.length).toBeGreaterThan(0);
        expect(skill.description.length).toBeGreaterThan(0);
        expect(skill.tags.length).toBeGreaterThan(0);
        expect(skill.examples.length).toBeGreaterThan(0);
      }
    }
  });

  test("strips trailing slashes and rejects non-HTTP base URLs fail-closed", () => {
    const card = generateA2AAgentCard("qa-adversary", "https://router.heretek.ai///");
    expect(card.url).toBe("https://router.heretek.ai/a2a/qa-adversary");
    expect(() => generateA2AAgentCard("director", "not-a-url")).toThrow(/baseUrl/);
    expect(() => generateA2AAgentCard("director", "ftp://files.example/x")).toThrow(
      /http/,
    );
    expect(() =>
      generateA2AAgentCard("intruder" as RoleId, "https://router.heretek.ai"),
    ).toThrow(/Unknown role/);
  });
});

describe("ROLE_PERMISSION_MATRIX (OpenCode v2 last-match-wins)", () => {
  test("covers all six roles with non-empty ordered rulesets", () => {
    expect(Object.keys(ROLE_PERMISSION_MATRIX).sort()).toEqual([...ALL_ROLES].sort());
    for (const role of ALL_ROLES) {
      const rules = ROLE_PERMISSION_MATRIX[role as RoleId]!;
      expect(rules.length).toBeGreaterThan(3);
      for (const rule of rules) {
        expect(rule.match.length).toBeGreaterThan(0);
        expect(["allow", "deny", "ask"]).toContain(rule.effect);
        expect(rule.description.length).toBeGreaterThan(0);
      }
    }
  });

  test("director and manager are denied all direct edits", () => {
    for (const role of ["director", "manager"] as const) {
      expect(evaluatePermission(role, "edit:src/index.ts")).toBe("deny");
      expect(evaluatePermission(role, "write:src/index.ts")).toBe("deny");
      expect(evaluatePermission(role, "read:src/index.ts")).toBe("allow");
    }
    expect(evaluatePermission("director", "mcp_call_tool:mutate:deploy")).toBe("deny");
  });

  test("architect is scoped to contracts and tokens trees", () => {
    expect(evaluatePermission("architect", "edit:contracts/api.json")).toBe("allow");
    expect(evaluatePermission("architect", "write:tokens/ids.json")).toBe("allow");
    expect(evaluatePermission("architect", "edit:src/index.ts")).toBe("deny");
    expect(evaluatePermission("architect", "read:src/index.ts")).toBe("allow");
  });

  test("staff roles own their trees and are denied each other's", () => {
    expect(evaluatePermission("staff-backend", "edit:src/router.ts")).toBe("allow");
    expect(evaluatePermission("staff-backend", "edit:ui/web/app.tsx")).toBe("deny");
    expect(evaluatePermission("staff-ui", "edit:ui/web/app.tsx")).toBe("allow");
    expect(evaluatePermission("staff-ui", "edit:src/router.ts")).toBe("deny");
  });

  test("qa-adversary cannot mutate product sources but can run gates", () => {
    expect(evaluatePermission("qa-adversary", "edit:src/index.ts")).toBe("deny");
    expect(evaluatePermission("qa-adversary", "write:src/index.ts")).toBe("deny");
    expect(evaluatePermission("qa-adversary", "bash:bun test")).toBe("allow");
    expect(evaluatePermission("qa-adversary", "mcp_call_tool:mutate:deploy")).toBe("deny");
  });

  test("last match wins and unmatched addresses deny fail-closed", () => {
    expect(matchRulePattern("edit:src/**", "edit:src/a/b.ts")).toBe(true);
    expect(matchRulePattern("edit:src/**", "edit:ui/web/a.tsx")).toBe(false);
    expect(matchRulePattern("bash:bun *", "bash:bun test")).toBe(true);
    expect(evaluatePermission("manager", "quantum:teleport")).toBe("deny");
    expect(() => evaluatePermission("ghost" as RoleId, "read:x")).toThrow(
      /Unknown role/,
    );
  });
});

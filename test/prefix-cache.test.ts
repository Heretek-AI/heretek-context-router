import { describe, expect, test } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_ROLES,
  assemblePrefixCachedPrompt,
  canonicalizeToolSchemas,
  type RoleId,
} from "../src/prefix-builder/assemble-prompt.ts";

const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assemble(role: RoleId) {
  return assemblePrefixCachedPrompt({ role, workspaceRoot: WORKSPACE_ROOT });
}

describe("canonicalizeToolSchemas (RFC 8785 JCS)", () => {
  test("sorts tools alphabetically by name", () => {
    const out = canonicalizeToolSchemas([
      { name: "zulu", description: "z" },
      { name: "alpha", description: "a" },
      { name: "mid", description: "m" },
    ]);
    const parsed = JSON.parse(out) as Array<{ name: string }>;
    expect(parsed.map((t) => t.name)).toEqual(["alpha", "mid", "zulu"]);
  });

  test("sorts object keys recursively and deterministically", () => {
    const tools = [
      {
        name: "search",
        input: { zebra: 1, apple: { y: 2, b: 1 }, mango: [3, 2] },
        extra: "x",
      },
    ];
    const first = canonicalizeToolSchemas(tools);
    const shuffled = canonicalizeToolSchemas([
      { extra: "x", input: { mango: [3, 2], apple: { b: 1, y: 2 }, zebra: 1 }, name: "search" },
    ]);
    expect(first).toBe(shuffled);
    expect(first.indexOf('"apple"')).toBeLessThan(first.indexOf('"mango"'));
    expect(first.indexOf('"mango"')).toBeLessThan(first.indexOf('"zebra"'));
    expect(first.indexOf('"b"')).toBeLessThan(first.indexOf('"y"'));
  });

  test("is stable across repeated calls and handles tools without names", () => {
    const tools = [{ b: 1, a: 2 }, { name: "b-tool" }, { name: "a-tool" }];
    const a = canonicalizeToolSchemas(tools);
    const b = canonicalizeToolSchemas([...tools].reverse());
    expect(a).toBe(b);
    const parsed = JSON.parse(a) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(3);
    expect(parsed[0]).toEqual({ a: 2, b: 1 });
    expect(parsed[1]).toEqual({ name: "a-tool" });
    expect(parsed[2]).toEqual({ name: "b-tool" });
  });

  test("serializes nested arrays of objects deterministically", () => {
    const out = canonicalizeToolSchemas([
      { name: "t", variants: [{ z: 1, a: 2 }, { q: 3, m: 4 }] },
    ]);
    expect(out).toBe(
      '[{"name":"t","variants":[{"a":2,"z":1},{"m":4,"q":3}]}]',
    );
    expect(JSON.parse(out)).toEqual([
      {
        name: "t",
        variants: [
          { a: 2, z: 1 },
          { m: 4, q: 3 },
        ],
      },
    ]);
  });
});

describe("frozen prefix equality (byte 0 to B2 across all 6 roles)", () => {
  test("all six roles assemble successfully with positive breakpoints", () => {
    for (const role of ALL_ROLES) {
      const prompt = assemble(role);
      expect(prompt.frozenPrefixBytes).toBeGreaterThan(0);
      expect(prompt.cacheBreakpoints[0]).toBeGreaterThan(0);
      expect(prompt.cacheBreakpoints[1]).toBeGreaterThan(prompt.cacheBreakpoints[0]);
      expect(prompt.systemPrompt.length).toBeGreaterThan(prompt.frozenPrefixBytes);
      expect(prompt.frozenPrefixBytes).toBe(prompt.cacheBreakpoints[1]);
    }
  });

  test("every role pair shares a byte-for-byte identical frozen prefix", () => {
    const built = new Map<RoleId, ReturnType<typeof assemble>>();
    for (const role of ALL_ROLES) {
      built.set(role, assemble(role));
    }
    let comparisons = 0;
    for (let i = 0; i < ALL_ROLES.length; i++) {
      for (let j = i + 1; j < ALL_ROLES.length; j++) {
        const roleA = ALL_ROLES[i] as RoleId;
        const roleB = ALL_ROLES[j] as RoleId;
        const promptA = built.get(roleA)!;
        const promptB = built.get(roleB)!;
        expect(promptA.frozenPrefixBytes).toBe(promptB.frozenPrefixBytes);
        expect(promptA.cacheBreakpoints).toEqual(promptB.cacheBreakpoints);
        const frozenA = promptA.systemPrompt.slice(0, promptA.frozenPrefixBytes);
        const frozenB = promptB.systemPrompt.slice(0, promptB.frozenPrefixBytes);
        expect(frozenA).toBe(frozenB);
        comparisons++;
      }
    }
    expect(comparisons).toBe(15);
  });

  test("breakpoint B1 slices the static Layer 1 identically for all roles", () => {
    const layers = ALL_ROLES.map((r) => {
      const p = assemble(r as RoleId);
      return {
        role: r,
        l1: p.systemPrompt.slice(0, p.cacheBreakpoints[0]),
        b1Bytes: Buffer.byteLength(p.systemPrompt.slice(0, p.cacheBreakpoints[0]), "utf8"),
      };
    });
    for (const entry of layers) {
      expect(entry.l1).toBe(layers[0]!.l1);
      expect(entry.b1Bytes).toBe(layers[0]!.b1Bytes);
    }
  });

  test("bytes B1..B2 equal the shared-context file verbatim for every role", async () => {
    const shared = await Bun.file(join(WORKSPACE_ROOT, "roles", "00-shared-context.md")).text();
    for (const role of ALL_ROLES) {
      const p = assemble(role as RoleId);
      const [b1, b2] = p.cacheBreakpoints;
      const asBytes = Buffer.from(p.systemPrompt, "utf8");
      expect(asBytes.subarray(b1, b2).toString("utf8")).toBe(shared);
      expect(p.systemPrompt.slice(b1, b2)).toBe(shared);
      expect(Buffer.byteLength(shared, "utf8")).toBe(b2 - b1);
    }
  });

  test("frozen prefix is pure ASCII so byte offsets equal character offsets", () => {
    for (const role of ALL_ROLES) {
      const p = assemble(role as RoleId);
      const frozen = p.systemPrompt.slice(0, p.frozenPrefixBytes);
      expect(Buffer.byteLength(frozen, "utf8")).toBe(frozen.length);
      expect(frozen).not.toMatch(/[^\x00-\x7F]/);
    }
  });

  test("frozen prefix contains no timestamps, UUIDs, or role names", () => {
    for (const role of ALL_ROLES) {
      const p = assemble(role as RoleId);
      const frozen = p.systemPrompt.slice(0, p.frozenPrefixBytes);
      expect(frozen).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(frozen).not.toMatch(/\d{2}:\d{2}:\d{2}/);
      expect(frozen).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      for (const name of ALL_ROLES) {
        if (name === "director") continue;
        expect(frozen.toLowerCase()).not.toContain(`you are ${name}`);
      }
    }
  });

  test("Layer 3 suffix is role-specific and carries scope plus profile", () => {
    const seen = new Set<string>();
    for (const role of ALL_ROLES) {
      const p = assemble(role as RoleId);
      const suffix = p.systemPrompt.slice(p.frozenPrefixBytes);
      expect(suffix.length).toBeGreaterThan(0);
      expect(suffix).toContain("Authorized Mutation Scope:");
      expect(suffix).toContain("Active Toolbox Profile: core");
      seen.add(suffix);
    }
    expect(seen.size).toBe(ALL_ROLES.length);
  });

  test("task brief scope and profile render in Layer 3 without touching the frozen prefix", () => {
    const base = assemblePrefixCachedPrompt({
      role: "staff-backend",
      workspaceRoot: WORKSPACE_ROOT,
    });
    const scoped = assemblePrefixCachedPrompt({
      role: "staff-backend",
      workspaceRoot: WORKSPACE_ROOT,
      taskBrief: {
        taskId: "wave-1-impl",
        title: "Implement assembler",
        objective: "Build the prefix assembler with exact logic.",
        ownedPaths: ["src/prefix-builder", "test/prefix-cache.test.ts"],
        acceptCriteria: ["bun test exits 0"],
      },
      activeProfile: "appsec",
    });
    expect(scoped.systemPrompt.slice(0, scoped.frozenPrefixBytes)).toBe(
      base.systemPrompt.slice(0, base.frozenPrefixBytes),
    );
    const suffix = scoped.systemPrompt.slice(scoped.frozenPrefixBytes);
    expect(suffix).toContain("Authorized Mutation Scope: src/prefix-builder, test/prefix-cache.test.ts");
    expect(suffix).toContain("Active Toolbox Profile: appsec");
    const unscoped = assemble("director");
    expect(unscoped.systemPrompt.slice(unscoped.frozenPrefixBytes)).toContain(
      "Authorized Mutation Scope: NONE",
    );
  });

  test("unknown role and unknown profile fail closed", () => {
    expect(() =>
      assemblePrefixCachedPrompt({
        role: "intruder" as RoleId,
        workspaceRoot: WORKSPACE_ROOT,
      }),
    ).toThrow(/Unknown role/);
    expect(() =>
      assemblePrefixCachedPrompt({
        role: "director",
        workspaceRoot: WORKSPACE_ROOT,
        activeProfile: "nope" as "core",
      }),
    ).toThrow(/Unknown toolbox profile/);
    expect(() =>
      assemblePrefixCachedPrompt({ role: "director", workspaceRoot: "" }),
    ).toThrow(/workspaceRoot/);
  });
});

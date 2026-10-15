import { z } from "zod";

export const RoleIdSchema = z.enum([
  "director",
  "architect",
  "manager",
  "staff-backend",
  "staff-ui",
  "qa-adversary",
]);

export const ToolboxProfileSchema = z.enum([
  "core",
  "appsec",
  "android",
  "game",
  "research",
]);

const WorkspaceRelativePathSchema = z
  .string()
  .min(1, "owned path must be non-empty")
  .refine(
    (p) => !p.startsWith("/") && !p.split("/").includes(".."),
    "owned path must be workspace-relative and must not escape the workspace",
  );

export const TaskBriefSchema = z
  .object({
    taskId: z.string().min(1, "taskId must be non-empty"),
    title: z.string().min(1, "title must be non-empty"),
    objective: z.string().min(1, "objective must be non-empty"),
    ownedPaths: z
      .array(WorkspaceRelativePathSchema)
      .min(1, "ownedPaths must grant at least one path"),
    acceptCriteria: z
      .array(z.string().min(1))
      .min(1, "acceptCriteria must list at least one criterion"),
    role: RoleIdSchema.optional(),
    activeProfile: ToolboxProfileSchema.optional(),
  })
  .strict();

export const UnitTestSummarySchema = z
  .object({
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    total: z.number().int().min(0),
  })
  .strict()
  .refine(
    (s) => s.total === s.passed + s.failed,
    "unitTestSummary.total must equal passed + failed",
  );

export const WorkerReceiptSchema = z
  .object({
    taskId: z.string().min(1, "taskId must be non-empty"),
    role: RoleIdSchema,
    commitHash: z
      .string()
      .regex(
        /^[0-9a-f]{40}$/,
        "commitHash must be a 40-character lowercase hexadecimal git SHA",
      ),
    modifiedFiles: z
      .array(z.string().min(1))
      .min(1, "modifiedFiles must list at least one file"),
    unitTestSummary: UnitTestSummarySchema,
    compilerCheckPassed: z.literal(true, {
      errorMap: () => ({
        message: "compilerCheckPassed must be true; failing builds cannot issue receipts",
      }),
    }),
    notes: z.string().optional(),
  })
  .strict();

export const RedProofEvidenceSchema = z
  .object({
    sabotageDescription: z
      .string()
      .min(1, "sabotageDescription must be non-empty"),
    exitCodeDuringSabotage: z
      .number()
      .int()
      .min(1, "exitCodeDuringSabotage must be >= 1 to prove the suite guards the invariant"),
    revertedCleanly: z.literal(true, {
      errorMap: () => ({
        message: "revertedCleanly must be true; sabotage must be reverted before verdict",
      }),
    }),
    logExcerpt: z.string().min(1, "logExcerpt must be non-empty"),
  })
  .strict();

export const QaVerdictSchema = z
  .object({
    taskId: z.string().min(1, "taskId must be non-empty"),
    verdict: z.enum(["pass", "fail"]),
    redProofEvidence: RedProofEvidenceSchema,
    checkedReceiptCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/, "checkedReceiptCommit must be a 40-character git SHA")
      .optional(),
    notes: z.string().optional(),
  })
  .strict();

export type RoleId = z.infer<typeof RoleIdSchema>;
export type ToolboxProfile = z.infer<typeof ToolboxProfileSchema>;
export type TaskBrief = z.infer<typeof TaskBriefSchema>;
export type UnitTestSummary = z.infer<typeof UnitTestSummarySchema>;
export type WorkerReceipt = z.infer<typeof WorkerReceiptSchema>;
export type RedProofEvidence = z.infer<typeof RedProofEvidenceSchema>;
export type QaVerdict = z.infer<typeof QaVerdictSchema>;

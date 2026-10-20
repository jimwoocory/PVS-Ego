import { z } from "zod";
import {
  aiExecutionRefSchema,
  entityIdSchema,
  isoDateTimeSchema,
  sha256Schema,
  versionRefSchema
} from "./schemas.js";

export const visualCheckSchema = z.enum(["PASS", "BLOCKED", "UNCERTAIN"]);
export const productVisualCheckSchema = visualCheckSchema.or(z.literal("NOT_APPLICABLE"));

export const visualClipAssessmentSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  clipId: entityIdSchema,
  clipHash: sha256Schema,
  attemptId: entityIdSchema,
  outputArtifactId: entityIdSchema,
  outputArtifactHash: sha256Schema,
  productTruthRef: versionRefSchema,
  /** New reviews explicitly bind product visibility. Missing in v1 legacy data. */
  productVisibility: z.enum(["NONE", "PARTIAL", "CLEAR", "HERO"]).optional(),
  productPresence: z.enum(["ABSENT", "PRESENT", "UNCERTAIN"]).optional(),
  audioTrackPresent: z.boolean().optional(),
  canonicalImageAssetId: entityIdSchema,
  canonicalImageArtifactId: entityIdSchema,
  canonicalImageHash: sha256Schema,
  evaluatorVersion: z.string().min(1),
  sourceDurationMs: z.number().int().positive(),
  requiredDurationMs: z.number().int().positive(),
  sampledFrameTimestampsMs: z.array(z.number().int().nonnegative()).min(1).max(12),
  candidateWindows: z.array(z.object({
    index: z.number().int().nonnegative(),
    inMs: z.number().int().nonnegative(),
    outMs: z.number().int().positive()
  }).strict()).min(1).max(7),
  checks: z.object({
    productIdentity: productVisualCheckSchema,
    productStability: productVisualCheckSchema,
    usageCompliance: visualCheckSchema,
    visualQuality: visualCheckSchema,
    cutQuality: visualCheckSchema,
    /** Missing in immutable v1 audits; mandatory for new v2 results. */
    storyActionAlignment: visualCheckSchema.optional()
  }).strict(),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  recommendedWindowIndex: z.number().int().nonnegative(),
  status: z.enum(["PASS", "BLOCKED", "UNCERTAIN"]),
  autoAcceptEligible: z.boolean(),
  reasons: z.array(z.string().trim().min(1).max(1200)).min(1).max(20),
  aiExecution: aiExecutionRefSchema.optional(),
  contentHash: sha256Schema,
  createdAt: isoDateTimeSchema
}).superRefine((value, ctx) => {
  const window = value.candidateWindows.find(item => item.index === value.recommendedWindowIndex);
  if (!window) {
    ctx.addIssue({ code: "custom", path: ["recommendedWindowIndex"], message: "推荐剪辑区间必须来自候选窗口" });
  } else if (window.outMs - window.inMs !== value.requiredDurationMs) {
    ctx.addIssue({ code: "custom", path: ["candidateWindows"], message: "候选剪辑窗口必须保持导演镜头时长" });
  }
  if (value.productVisibility === "NONE" &&
      value.productPresence === "ABSENT" &&
      (value.checks.productIdentity !== "NOT_APPLICABLE" ||
       value.checks.productStability !== "NOT_APPLICABLE")) {
    ctx.addIssue({ code: "custom", path: ["checks"], message: "不出镜剧情镜头的产品身份/稳定性必须标为不适用" });
  }
  if (value.productVisibility && value.productVisibility !== "NONE" &&
      (value.checks.productIdentity === "NOT_APPLICABLE" ||
       value.checks.productStability === "NOT_APPLICABLE")) {
    ctx.addIssue({ code: "custom", path: ["checks"], message: "要求产品出镜的镜头必须核对产品身份和稳定性" });
  }
  if (value.autoAcceptEligible && (value.status !== "PASS" || value.confidence !== "HIGH")) {
    ctx.addIssue({ code: "custom", path: ["autoAcceptEligible"], message: "只有高置信通过结果才能自动采用" });
  }
});

export type VisualClipAssessment = z.infer<typeof visualClipAssessmentSchema>;
export type VisualCheck = z.infer<typeof visualCheckSchema>;

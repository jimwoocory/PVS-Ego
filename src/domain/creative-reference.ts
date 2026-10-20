import { z } from "zod";
import { aiExecutionRefSchema, entityIdSchema, isoDateTimeSchema, sha256Schema, versionRefSchema } from "./schemas.js";

export const researchReferenceRoleSchema = z.enum(["PRODUCT_ANGLE", "WEARING_REFERENCE", "USAGE_ACTION_REFERENCE", "SCENE_REFERENCE", "LOGO_REFERENCE"]);
export const referenceCategorySchema = z.enum(["APPEARANCE", "ANGLE", "WEARING", "USAGE", "DETAIL", "SCENE", "PACKAGING_LOGO", "VIDEO_FRAME"]);
const publicUrl = z.string().url().refine(value => { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; }, "来源只允许无凭据的 HTTP(S) 网址");
export const referenceAssessmentSchema = z.object({
  identity: z.enum(["MATCH", "UNCERTAIN", "OTHER_PRODUCT", "NO_PRODUCT"]),
  identityReason: z.string().min(1).max(1600),
  clarity: z.enum(["CLEAR", "BLURRY", "UNCERTAIN"]),
  watermark: z.enum(["ABSENT", "PRESENT", "UNCERTAIN"]),
  usage: z.enum(["PASS", "CONFLICT", "UNCERTAIN"]),
  conflictingRuleIds: z.array(entityIdSchema).max(30),
  categories: z.array(referenceCategorySchema).min(1).max(8),
  recommendedRoles: z.array(researchReferenceRoleSchema).max(5),
  description: z.string().min(1).max(2000),
  risks: z.array(z.string().min(1).max(800)).max(20)
}).strict();
export const researchMediaCandidateSchema = z.object({
  id: entityIdSchema, projectId: entityIdSchema, runId: entityIdSchema, captureKey: sha256Schema,
  sourceUrl: publicUrl, mediaUrl: publicUrl, sourceType: z.string().min(1),
  sourceTrust: z.enum(["DECLARED_OFFICIAL", "USER_SUPPLIED", "PUBLIC_UNVERIFIED"]),
  title: z.string().max(500), fetchedAt: isoDateTimeSchema,
  mediaKind: z.enum(["IMAGE", "VIDEO_FRAME"]), sourceArtifactId: entityIdSchema, sourceArtifactHash: sha256Schema,
  artifactId: entityIdSchema, artifactHash: sha256Schema,
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]), sizeBytes: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(),
  timestampMs: z.number().int().nonnegative().optional(), frameIndex: z.number().int().nonnegative().optional(),
  timestampMethod: z.literal("EXPLICIT_SEEK_TARGET").optional(),
  pixelSignature: z.string().regex(/^[a-f0-9]{1536}$/).optional(),
  truthRef: versionRefSchema.optional(), canonicalImageHash: sha256Schema.optional(),
  assessment: referenceAssessmentSchema.optional(), aiExecution: aiExecutionRefSchema.optional(),
  analyzerVersion: z.string().min(1), status: z.enum(["REVIEWABLE", "BLOCKED", "DUPLICATE", "ANALYSIS_FAILED", "WAITING_FOR_TRUTH"]),
  blockers: z.array(z.string().min(1)), duplicateOf: entityIdSchema.optional(),
  contentHash: sha256Schema, createdAt: isoDateTimeSchema
}).superRefine((c, ctx) => {
  if (c.mediaKind === "VIDEO_FRAME" && (c.timestampMs === undefined || c.frameIndex === undefined || !c.timestampMethod)) ctx.addIssue({code:"custom",message:"视频帧必须保留来源与时间定位方法"});
  if (c.status === "REVIEWABLE" && (!c.assessment || !c.truthRef || !c.canonicalImageHash || c.blockers.length)) ctx.addIssue({code:"custom",message:"候选尚未通过来源与产品身份检查"});
  if (c.status === "DUPLICATE" && !c.duplicateOf) ctx.addIssue({code:"custom",message:"重复候选必须引用原候选"});
});
export const creativeReferenceEntrySchema = z.object({
  candidateId: entityIdSchema, candidateHash: sha256Schema,
  assetId: entityIdSchema, artifactId: entityIdSchema, artifactHash: sha256Schema,
  role: researchReferenceRoleSchema, description: z.string().min(1),
  sourceUrl: publicUrl, mediaUrl: publicUrl, timestampMs: z.number().int().nonnegative().optional(),
  sourceArtifactId: entityIdSchema, sourceArtifactHash: sha256Schema,
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]), sizeBytes: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive()
});
export const creativeReferenceSetSchema = z.object({
  id: entityIdSchema, projectId: entityIdSchema, version: z.number().int().positive(),
  status: z.literal("CONFIRMED"), truthRef: versionRefSchema, canonicalImageHash: sha256Schema,
  entries: z.array(creativeReferenceEntrySchema).max(32),
  confirmedBy: z.literal("EXPLICIT_USER_REVIEW"), rightsAcknowledged: z.boolean(),
  previousHash: sha256Schema.nullable(), contentHash: sha256Schema, createdAt: isoDateTimeSchema
}).superRefine((set, ctx) => {
  if (new Set(set.entries.map(e => e.candidateId)).size !== set.entries.length) ctx.addIssue({code:"custom",message:"参考集合不允许重复候选"});
  if (set.entries.length && !set.rightsAcknowledged) ctx.addIssue({code:"custom",message:"使用外部参考素材必须确认使用权"});
});
export const referenceReviewInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(), expectedTruthHash: sha256Schema,
  acknowledgeRights: z.boolean(),
  changes: z.array(z.object({candidateId: entityIdSchema, candidateHash: sha256Schema,
    decision: z.enum(["INCLUDE", "REMOVE", "IGNORE", "UNTRUSTED"]), role: researchReferenceRoleSchema.optional()
  }).strict()).min(1).max(100)
}).strict();
export type ResearchMediaCandidate = z.infer<typeof researchMediaCandidateSchema>;
export type ReferenceAssessment = z.infer<typeof referenceAssessmentSchema>;
export type CreativeReferenceSet = z.infer<typeof creativeReferenceSetSchema>;
export type ReferenceReviewInput = z.infer<typeof referenceReviewInputSchema>;
export type ResearchReferenceRole = z.infer<typeof researchReferenceRoleSchema>;

/** Rechecked at review and consumption. An AI recommendation is never user approval. */
export function candidateBlockers(candidate: Pick<ResearchMediaCandidate, "assessment" | "width" | "height" | "truthRef" | "canonicalImageHash" | "duplicateOf">, role?: ResearchReferenceRole): string[] {
  const a = candidate.assessment, reasons: string[] = [];
  if (!candidate.truthRef || !candidate.canonicalImageHash) reasons.push("需要以已确认产品事实及真实主图分析");
  if (candidate.width < 320 || candidate.height < 320) reasons.push("图片短边不足320像素");
  if (candidate.duplicateOf) reasons.push("与已有候选高度重复");
  if (!a) return [...reasons, "视觉分析尚未通过"];
  if (a.identity !== "MATCH" && !(a.identity === "NO_PRODUCT" && role === "SCENE_REFERENCE")) reasons.push("产品身份不确定或不是当前产品");
  if (a.clarity !== "CLEAR") reasons.push("画面模糊或清晰度无法确认");
  if (a.watermark !== "ABSENT") reasons.push("存在水印或无法排除水印");
  if (a.usage !== "PASS" || a.conflictingRuleIds.length) reasons.push("使用规则冲突或尚未确认");
  if (!a.recommendedRoles.length || (role && !a.recommendedRoles.includes(role))) reasons.push("所选参考角色未通过分析");
  return reasons;
}

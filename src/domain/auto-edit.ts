import { z } from "zod";
import { entityIdSchema, sha256Schema, isoDateTimeSchema, versionRefSchema, timelineSchema, renderConfigSchema } from "./schemas.js";

export const postProductionSettingsSchema = z.object({
  narrationMode: z.enum(["SOURCE_ONLY", "SOURCE_OR_LOCAL_TTS", "LOCAL_TTS", "PROVIDED"]).default("SOURCE_ONLY"),
  voiceName: z.string().trim().min(1).max(200).optional(),
  speechRate: z.number().int().min(-2).max(3).default(0),
  captions: z.boolean().default(true),
  cta: z.boolean().default(true),
  bgmArtifactId: entityIdSchema.optional(),
  bgmVolume: z.number().min(0).max(1).default(0.22),
  sourceVolume: z.number().min(0).max(2).default(1),
  allowSilentOutput: z.boolean().default(false),
  omitMissingEffects: z.boolean().default(false),
  repairMasks: z.array(z.object({
    sourceArtifactId: entityIdSchema,
    sourceArtifactHash: sha256Schema,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    xRatio: z.number().min(0).max(1),
    yRatio: z.number().min(0).max(1),
    widthRatio: z.number().positive().max(1),
    heightRatio: z.number().positive().max(1),
    color: z.enum(["WHITE", "BLACK"]).default("WHITE"),
    opacity: z.number().min(0.1).max(1).default(1),
    reason: z.string().trim().min(1).max(1000)
  }).strict().superRefine((value, ctx) => {
    if (value.endMs <= value.startMs) ctx.addIssue({ code: "custom", path: ["endMs"], message: "修复遮罩结束时间必须晚于开始时间" });
    if (value.xRatio + value.widthRatio > 1.000001) ctx.addIssue({ code: "custom", path: ["widthRatio"], message: "修复遮罩超出横向画布" });
    if (value.yRatio + value.heightRatio > 1.000001) ctx.addIssue({ code: "custom", path: ["heightRatio"], message: "修复遮罩超出纵向画布" });
  })).max(40).default([]),
  textPositionOverrides: z.array(z.object({
    segmentId: entityIdSchema,
    text: z.string().trim().min(1).max(500),
    position: z.enum(["TOP", "CENTER", "BOTTOM"]),
    reason: z.string().trim().min(1).max(1000)
  }).strict()).max(40).default([]),
  audioBindings: z.array(z.object({
    segmentId: entityIdSchema,
    kind: z.enum(["NARRATION", "AMBIENT"]),
    artifactId: entityIdSchema,
    inMs: z.number().int().nonnegative().default(0),
    outMs: z.number().int().positive().optional(),
    volume: z.number().min(0).max(2).default(1)
  }).strict()).max(120).default([])
}).strict();

export const autoEditPlanSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  inputHash: sha256Schema,
  source: z.literal("RULE_BASED_AUTO_EDIT_V1"),
  plannerVersion: z.string().min(1).optional(),
  truthRef: versionRefSchema,
  scriptRef: versionRefSchema,
  productionPlanRef: versionRefSchema,
  referenceVideoProfileHash: sha256Schema.optional(),
  settings: postProductionSettingsSchema,
  targetDurationMs: z.number().int().positive(),
  actualDurationMs: z.number().int().positive(),
  inputs: z.array(z.object({
    clipId: entityIdSchema, clipHash: sha256Schema, attemptId: entityIdSchema,
    artifactId: entityIdSchema, artifactHash: sha256Schema,
    sourceDurationMs: z.number().int().positive(), sourceHasAudio: z.boolean(),
    visualAssessment: z.object({
      artifactId: entityIdSchema,
      artifactHash: sha256Schema,
      evaluatorVersion: z.string().min(1),
      status: z.enum(["PASS", "BLOCKED", "UNCERTAIN"]),
      confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
      inMs: z.number().int().nonnegative(),
      outMs: z.number().int().positive()
    }).strict().optional()
  }).strict()).min(1),
  audioProvenance: z.array(z.object({
    segmentId: entityIdSchema.optional(), kind: z.enum(["NARRATION", "AMBIENT", "BGM"]),
    artifactId: entityIdSchema, artifactHash: sha256Schema, measuredDurationMs: z.number().int().positive(),
    synthesized: z.boolean(), voiceName: z.string().optional()
  })).optional(),
  timeline: timelineSchema,
  renderConfig: renderConfigSchema,
  rationale: z.array(z.string().min(1)).min(1),
  warnings: z.array(z.string()),
  captionTiming: z.literal("DIRECTOR_SEGMENTS_OR_SYNTHESIZED_AUDIO_NOT_ASR"),
  contentHash: sha256Schema,
  createdAt: isoDateTimeSchema
});
export type PostProductionSettings = z.infer<typeof postProductionSettingsSchema>;
export type AutoEditPlan = z.infer<typeof autoEditPlanSchema>;

export class AutoEditBlocked extends Error {
  constructor(readonly code: string, message: string, readonly audioRequired = false) {
    super(message); this.name = "AutoEditBlocked";
  }
}

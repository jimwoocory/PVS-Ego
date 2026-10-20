import { z } from "zod";
import { hashValue } from "./hashing.js";
import { directorGenerationTargetSchema, sha256Schema } from "./schemas.js";

const text = z.string().min(1).max(12000);
const hashChecked = <T extends { contentHash: string }>(value: T) => {
  const { contentHash, ...base } = value;
  return contentHash === hashValue(base);
};
export const v8VoiceBindingsSchema = z.record(z.string().min(1).max(80), z.object({
  actorAssetKey: text, voiceType: z.string().trim().min(1).max(500)
}).strict());
export const v8DecisionSchema = z.object({
  version: z.literal("v8-director-decision-1"),
  sourceScriptHash: sha256Schema, screenplayHash: sha256Schema,
  modelDurationCapability: z.object({ minSeconds: z.number().min(4), maxSeconds: z.number().max(15) }).strict(),
  targetDurationMs: z.number().int().positive(),
  clips: z.array(z.object({
    clipId: text, order: z.number().int().positive(), location: text,
    durationMs: z.number().int().min(4000).max(15000), sourceBeatIds: z.array(text).min(1),
    openingState: text, closingState: text, sourceAfterReveal: z.array(text),
    shots: z.array(z.object({
      shotId: text, sourceBeatId: text, startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(),
      shotFunction: z.enum(["ESTABLISH", "SPEECH", "REACTION", "ACTION"]), visibleAction: text,
      actorObjective: z.object({ speaker: text, wants: text, obstacle: text }).strict().optional(),
      spoken: z.object({
        speaker: text, mode: z.enum(["ONSCREEN", "OFFSCREEN", "OS"]), exactText: text,
        tone: text, delivery: text, voiceAssetStatus: z.literal("NEEDS_BINDING"),
        speechEstimatedMs: z.number().nonnegative(), sourceLineText: text.optional(),
        sourcePartIndex: z.number().int().positive().optional(), sourcePartCount: z.number().int().positive().optional()
      }).strict().optional(),
      audienceKnowledgeChange: text.optional(),
      ambience: z.array(text).optional(), sfx: z.array(text).optional(), postProductionText: z.array(text).optional(),
      visualGuidance: z.string().trim().min(1).max(1200).optional(),
      cameraDecisionsPending: z.literal(true), blockingDecisionsPending: z.literal(true)
    }).strict()).min(1)
  }).strict()).min(1),
  traceability: z.object({ totalLines: z.number().int(), coveredLines: z.number().int(), sourceBeats: z.number().int(), coveredBeats: z.number().int() }).strict(),
  status: z.literal("DRAFT_NEEDS_VISUAL_DIRECTING"), contentHash: sha256Schema
}).strict().refine(hashChecked, "V8 导演决策哈希已失效，请重新编排并审核");
export const v8DirectorRecordSchema = z.object({
  revision: z.number().int().positive(), status: z.enum(["DRAFT", "CONFIRMED"]),
  decision: v8DecisionSchema, generationTarget: directorGenerationTargetSchema,
  approvedAt: z.string().datetime().optional(), contentHash: sha256Schema
}).strict().refine(hashChecked, "V8 导演采用版本哈希不一致")
  .refine(v => (v.status === "CONFIRMED") === Boolean(v.approvedAt), "V8 导演需要明确人工采用");
export const v8PromptSchema = z.object({
  version: z.literal("v8-authoritative-prompt-1"), clipId: text, durationMs: z.number().int(),
  scriptHash: sha256Schema, directorHash: sha256Schema, productionPlanHash: sha256Schema,
  sourceShotIds: z.array(text).min(1), promptText: text,
  incomingContinuity: z.object({
    sourceClipId: text,
    relationship: z.enum(["HARD_CONTINUITY","SAME_SCENE_CUT","SCENE_OR_TIME_JUMP","REVIEW_REQUIRED"]),
    plannedSourceEndStateHash: sha256Schema,
    plannedTargetStartStateHash: sha256Schema,
    contractHash: sha256Schema,
    requiresHardFirstFrame: z.boolean()
  }).strict().optional(),
  audioManifest: z.array(z.object({
    sourceShotId: text, speaker: text, mode: z.enum(["ONSCREEN", "OFFSCREEN", "OS"]), exactText: text,
    sourceLineText: text.optional(), sourcePartIndex: z.number().int().positive().optional(),
    sourcePartCount: z.number().int().positive().optional(), voiceType: text, delivery: text
  }).strict()),
  postProductionText: z.array(z.object({ sourceShotId: text, startMs: z.number().int(), endMs: z.number().int(),
    kind: z.enum(["CAPTION", "LABEL", "LEGAL", "CTA"]), exactText: text }).strict()),
  contentHash: sha256Schema
}).strict().refine(hashChecked, "V8 提示词内容哈希不一致");
export const v8PromptRecordSchema = z.object({
  revision: z.number().int().positive(), status: z.enum(["DRAFT", "CONFIRMED"]),
  screenplayHash: sha256Schema, directorRecordHash: sha256Schema,
  assetSetHash: sha256Schema, voiceBindings: v8VoiceBindingsSchema,
  imageBindingMode: z.literal("V1").optional(),
  packages: z.array(v8PromptSchema).min(1),
  approvedAt: z.string().datetime().optional(), contentHash: sha256Schema
}).strict().refine(hashChecked, "V8 PromptPackage 采用版本哈希不一致")
  .refine(v => (v.status === "CONFIRMED") === Boolean(v.approvedAt), "V8 PromptPackage 需要明确人工采用");
export type V8DirectorRecord = z.infer<typeof v8DirectorRecordSchema>;
export type V8PromptRecord = z.infer<typeof v8PromptRecordSchema>;
/** Revisions and approval are hashed too: old consent cannot follow a re-adoption. */
export function sealV8<T extends object>(base: T): T & { contentHash: string } {
  return { ...base, contentHash: hashValue(base) };
}

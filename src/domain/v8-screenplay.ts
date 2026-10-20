import { z } from "zod";
import { sha256Schema } from "./schemas.js";
import { hashValue } from "./hashing.js";

/** V8 authoring contract: independent from the existing V2/V3 ScriptDraft. */
const sentence = z.string().trim().min(1).max(2500);
const actorName = z.string().trim().min(1).max(80);
const scriptLine = z.object({
  speaker: actorName,
  mode: z.enum(["ONSCREEN", "OFFSCREEN", "OS"]),
  text: sentence,
  tone: sentence,
  delivery: sentence
}).strict();
const v8Beat = z.object({
  purpose: z.enum(["HOOK", "PAIN", "PRODUCT", "FEATURE", "PROOF", "RESULT", "CTA", "OTHER"]),
  action: sentence,
  actorAction: sentence,
  stateIn: sentence,
  stateOut: sentence,
  productRole: sentence,
  estimatedDurationMs: z.number().int().min(1000).max(120000),
  requiredFactIds: z.array(z.string().min(1)).max(12),
  audienceKnowledgeChange: z.string().trim().max(600).default(""),
  dialogue: z.array(scriptLine).max(10).default([]),
  postProductionText: z.array(sentence).max(8).default([]),
  ambience: z.array(sentence).max(5).default([]),
  sfx: z.array(sentence).max(5).default([])
}).strict();
const v8Scene = z.object({
  location: sentence,
  interiorExterior: z.enum(["INT", "EXT"]),
  timeOfDay: z.enum(["DAY", "NIGHT", "UNSPECIFIED"]),
  situation: sentence,
  dramaticPurpose: sentence,
  actorObjectives: z.array(z.object({
    speaker: actorName,
    wants: sentence,
    obstacle: sentence
  }).strict()).max(6),
  beats: z.array(v8Beat).min(1).max(20)
}).strict();
export const v8DetailedProposalSchema = z.object({
  title: sentence,
  premise: sentence,
  storyConflict: sentence,
  finalOutcome: sentence,
  scenes: z.array(v8Scene).min(1).max(12)
}).strict();
export type V8DetailedProposal = z.infer<typeof v8DetailedProposalSchema>;

/**
 * Versioned authoring artifact. A manual confirmation must bind to exactly
 * the same ScriptDraft and screenplay; no preview is implicitly adopted.
 */
export const v8ScreenplayRecordSchema = z.object({
  format: z.literal("PVS_V8_SCREENPLAY_V1"),
  status: z.enum(["DRAFT", "CONFIRMED"]),
  screenplay: v8DetailedProposalSchema,
  screenplayHash: sha256Schema,
  sourceScriptHash: sha256Schema,
  brief: z.string().min(1).max(6000),
  approvedAt: z.string().datetime().optional()
}).strict().superRefine((record, ctx) => {
  if (record.screenplayHash !== hashValue(record.screenplay)) {
    ctx.addIssue({ code: "custom", path: ["screenplayHash"],
      message: "V8 详细剧本内容与已记录的版本哈希不匹配" });
  }
  if (record.status === "CONFIRMED" && !record.approvedAt) {
    ctx.addIssue({ code: "custom", path: ["approvedAt"],
      message: "V8 详细剧本必须由用户明确审核确认" });
  }
  if (record.status === "DRAFT" && record.approvedAt) {
    ctx.addIssue({ code: "custom", path: ["approvedAt"],
      message: "未经确认的 V8 剧本不能带有确认时间" });
  }
});
export type V8ScreenplayRecord = z.infer<typeof v8ScreenplayRecordSchema>;

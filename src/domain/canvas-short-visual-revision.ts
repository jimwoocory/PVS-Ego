import {z} from "zod";
import {scriptDraftSchema,productionPlanSchema} from "./schemas.js";

const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const canvasShortVisualRevisionSchema=z.object({
  id:z.string().uuid(),contentHash:hash,createdAt:z.string().datetime(),status:z.enum(["DRAFT","DESIGN_CONFIRMED"]),
  designReview:z.object({contentHash:hash,confirmedAt:z.string().datetime(),scope:z.literal("TEXT_DESIGN_ONLY")}).strict().optional(),
  payload:z.object({
    sourcePlanId:z.string().uuid(),sourcePlanHash:hash,style:z.literal("REALISTIC_AI_SHORT_DRAMA"),
    replacesRevisionId:z.string().uuid().optional(),storyPremise:z.string().min(1).optional(),
    title:z.string().min(1),outputDurationMs:z.literal(15000),generatedDurationMs:z.literal(12000),localTailMs:z.literal(3000),creditCeiling:z.literal(72),budgetScope:z.literal("NEW_SETTING_IMAGES_AND_VIDEO"),
    styleReference:z.object({description:z.string().min(1),sourceUrl:z.string().url(),historyDate:z.string(),verification:z.literal("EXISTING_VIDEO_PLAYBACK_VERIFIED"),
      use:z.literal("VISUAL_STYLE_ONLY")}).strict(),
    visualDirection:z.string().min(1),audience:z.string().min(1),productMessage:z.string().min(1),
    script:scriptDraftSchema,productionPlan:productionPlanSchema,
    designs:z.array(z.object({key:z.enum(["DAUGHTER","FATHER","LIVING_ROOM","CHARACTER_A","CHARACTER_B","INTERIOR"]),label:z.string(),description:z.string(),
      consistency:z.array(z.string()).min(1),draftPrompt:z.string(),state:z.literal("TEXT_DESIGN_PENDING_REVIEW"),
      imageArtifactId:z.never().optional()}).strict()).length(3),
    productReference:z.object({artifactId:z.string(),sha256:hash}).strict(),excludedReferenceArtifactIds:z.array(z.string()).min(3),
    draftVideoPrompt:z.string().min(1),tailCardText:z.array(z.string()).min(1).max(4),reviewChecklist:z.array(z.string()).min(1),
    execution:z.object({state:z.literal("PLANNING_ONLY"),referenceBinding:z.literal("PENDING_NEW_REALISTIC_ASSETS"),price:z.literal("REQUOTE_REQUIRED"),
      imageGenerationAuthorized:z.literal(false),videoGenerationAuthorized:z.literal(false),publishAuthorized:z.literal(false)}).strict()
  }).strict()
}).strict();
export type CanvasShortVisualRevision=z.infer<typeof canvasShortVisualRevisionSchema>;

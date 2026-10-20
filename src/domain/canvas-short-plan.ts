import {z} from "zod";
import {scriptDraftSchema,productionPlanSchema,versionRefSchema} from "./schemas.js";
import {canvasProductionBindingSchema} from "./canvas-production.js";
import {productionQuoteSchema} from "./generation-quote.js";
import {canvasShortVisualRevisionSchema} from "./canvas-short-visual-revision.js";
import {shortReferenceQuoteSchema} from "./canvas-short-reference-quote.js";
import {shortReferenceImageSchema} from "./canvas-short-reference-image.js";
import {productionAssetSetSchema} from "./production-strategy.js";
import {shortBoundVideoQuoteSchema} from "./canvas-short-bound-video-quote.js";
const hash=z.string().regex(/^[a-f0-9]{64}$/),time=z.string().datetime();
export const shortPaidScopeSchema=z.object({hash,planRef:versionRefSchema,requests:z.array(z.object({requestId:z.string(),requestHash:hash,clipId:z.string().optional(),
  preflightId:z.string(),preflightHash:hash,costStatus:z.enum(["KNOWN","UNKNOWN"]),estimatedCredits:z.number().nonnegative().optional(),costText:z.string().optional()})).length(1),preparedAt:time});
const shortPayloadSchema=z.object({previewId:z.string(),candidateKey:z.literal("seedance_2.0_fast_vip-12000"),sourceScriptHash:hash,sourcePlanHash:hash,
    title:z.string(),model:z.literal("seedance_2.0_fast_vip"),creditCeiling:z.literal(72),
    generatedDurationMs:z.literal(12000),localTailMs:z.literal(3000),outputDurationMs:z.literal(15000),
    nodeId:z.string(),submitId:z.string().uuid(),generationHash:hash,prompt:z.string(),script:scriptDraftSchema,productionPlan:productionPlanSchema,
    tailCardText:z.array(z.string()).min(1).max(4),references:z.array(z.object({key:z.string(),artifactId:z.string(),sha256:hash})).length(4)
  }).strict();
export const realisticShortExecutionSchema=z.object({
  sourceRevisionId:z.string(),sourceRevisionHash:hash,sourcePlanHash:hash,contentHash:hash,payload:shortPayloadSchema.extend({references:z.array(shortPayloadSchema.shape.references.element).length(2)}),
  assets:productionAssetSetSchema,binding:canvasProductionBindingSchema,feeQuote:productionQuoteSchema.optional(),paidScope:shortPaidScopeSchema.optional(),
  paidScopeHistory:z.array(shortPaidScopeSchema).max(20).optional(),
  preflight:z.object({status:z.enum(["PASS","BLOCKED"]),checkedAt:time,blockers:z.array(z.string()),delivery:z.object({ready:z.boolean(),code:z.string().optional(),message:z.string().optional(),verifiedAt:z.string().optional()}).passthrough(),
    noVideoGenerationSubmitted:z.literal(true)}).strict().optional()
}).strict();
export const canvasShortPlanSchema=z.object({
  id:z.string().uuid(),parentRunId:z.string(),projectId:z.string(),contentHash:hash,
  payload:shortPayloadSchema,
  status:z.enum(["DRAFT","PLAN_CONFIRMED","REQUEST_READY","AUTHORIZED","GENERATING","CLIP_REVIEW","CLIP_ACCEPTED","FINAL_REVIEW","DELIVERED","BLOCKED"]),
  planReview:z.object({contentHash:hash,confirmedAt:time}).strict().optional(),binding:canvasProductionBindingSchema.optional(),feeQuote:productionQuoteSchema.optional(),
  paidScope:shortPaidScopeSchema.optional(),consent:z.object({scopeHash:hash,approvedAt:time,acceptedUnknownCostRisk:z.literal(false),source:z.literal("EXPLICIT_SMART_RUN_PAID_CONFIRMATION")}).strict().optional(),
  attemptIds:z.array(z.string()),clipReview:z.object({attemptId:z.string(),artifactId:z.string(),sha256:hash,decisionId:z.string(),reviewedAt:time}).strict().optional(),
  tailPreview:z.object({artifactId:z.string(),sha256:hash,durationMs:z.literal(3000)}).strict().optional(),
  visualRevisions:z.array(canvasShortVisualRevisionSchema).max(20).optional(),
  referenceQuote:shortReferenceQuoteSchema.optional(),
  referenceImage:shortReferenceImageSchema.optional(),
  boundVideoQuotes:z.array(shortBoundVideoQuoteSchema).max(20).optional(),
  realisticExecution:realisticShortExecutionSchema.optional(),
  final:z.object({artifactId:z.string(),sha256:hash,manifestArtifactId:z.string(),qcArtifactId:z.string(),durationMs:z.number(),width:z.number(),height:z.number(),hasAudio:z.boolean(),
    acceptedAt:time.optional()}).strict().optional(),blocker:z.string().optional(),createdAt:time,updatedAt:time
}).strict();
export type CanvasShortPlan=z.infer<typeof canvasShortPlanSchema>;

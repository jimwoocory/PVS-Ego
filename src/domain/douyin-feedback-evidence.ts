import {z} from "zod";
import {commentObservationSchema} from "./douyin-comment-observation.js";
import {metricAvailabilitySchema,commentPageCoverageSchema} from "./douyin-observation.js";

const id=z.string().min(1),hash=z.string().regex(/^[a-f0-9]{64}$/),date=z.string().datetime();
export const observationEvidenceSchema=z.object({
 version:z.literal("u5-observation-v1"),projectId:id,bindingId:id,awemeId:id,opsAccountUid:id.optional(),
 productTruthHash:hash,source:id.optional(),description:z.string().optional(),
 window:z.object({start:date,end:date,basis:z.literal("SAVED_OBSERVATION_TIMES"),continuous:z.literal(false)}),
 coverage:z.object({status:z.literal("PARTIAL"),platformCoverage:z.literal("UNKNOWN").optional(),metrics:z.object({selection:z.literal("LATEST_SAVED"),limit:z.literal(100),count:z.number().int().nonnegative(),capped:z.boolean()}),comments:z.object({selection:z.literal("LATEST_SAVED"),limit:z.literal(500),count:z.number().int().nonnegative(),capped:z.boolean()}),
  collectionScopes:z.array(z.object({runId:id,parentCid:id.optional(),cursor:z.string(),hasMore:z.boolean(),status:id,partial:z.boolean(),truncated:z.boolean(),coverage:commentPageCoverageSchema.optional(),observedAt:date.optional()})).max(100),scopesCapped:z.boolean(),collectionEvidenceAvailable:z.boolean()}),
 metrics:z.array(z.object({evidenceRef:id,contentHash:hash,capturedAt:date,values:z.record(z.string(),z.number().nonnegative()),availability:metricAvailabilitySchema.optional()})).min(1).max(100),
 comments:z.array(z.object({evidenceRef:id,contentHash:hash,cid:id,parentCid:id.optional(),text:z.string(),syncedAt:date,platformCreatedAt:date.optional(),sourceCoverage:commentPageCoverageSchema.optional(),observation:commentObservationSchema.optional(),diggCount:z.number().nonnegative().optional(),replyCount:z.number().nonnegative().optional()})).max(500),
 unavailableMetrics:z.object({completionRate:z.literal("NOT_AVAILABLE"),conversionRate:z.literal("NOT_AVAILABLE"),sales:z.literal("NOT_AVAILABLE")}),
 interpretation:z.literal("CORRELATION_ONLY_NOT_CAUSAL"),applicability:z.literal("METHOD_HYPOTHESIS_ONLY_NOT_PRODUCT_FACT_OR_BUSINESS_EFFECT")
});
export type ObservationEvidence=z.infer<typeof observationEvidenceSchema>;
export const feedbackContextSchema=z.object({feedbackId:id,insightId:id,text:z.string().min(1),evidenceRefs:z.array(id).min(1),actionHash:hash,confirmedAt:date,evidenceHash:hash,observation:observationEvidenceSchema});
export type FeedbackContext=z.infer<typeof feedbackContextSchema>;
export const feedbackInputReceiptSchema=z.object({version:z.literal("u5-feedback-input-v1"),productTruthHash:hash,inputHash:hash,items:z.array(feedbackContextSchema).max(20)});


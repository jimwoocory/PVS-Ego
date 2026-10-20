import {observationEvidenceSchema} from "./douyin-feedback-evidence.js";
import {commentObservationSchema} from "./douyin-comment-observation.js";
import { z } from "zod";
import {metricAvailabilitySchema,metricKeys,commentPageCoverageSchema} from "./douyin-observation.js";
import {
  entityIdSchema,
  isoDateTimeSchema,
  nonEmptyStringSchema,
  sha256Schema
} from "./schemas.js";

export const douyinWorkBindingStatusSchema = z.enum([
  "BOUND",
  "PENDING_DISCOVERY",
  "BLOCKED_ACCOUNT_MISMATCH",
  "NEEDS_USER_SELECTION"
]);

export const douyinWorkBindingSourceSchema = z.enum([
  "PUBLISH_RECEIPT",
  "AUTO_DISCOVERY",
  "USER_CONFIRMED",
  "HISTORICAL_WORK"
]);

export const douyinWorkBindingConfidenceSchema = z.enum([
  "TRUSTED",
  "HIGH",
  "USER_CONFIRMED",
  "NONE"
]);

export const douyinAwemeIdSchema = z
  .string()
  .trim()
  .regex(/^\d{8,30}$/, "invalid Douyin aweme id");

export const douyinWorkBindingSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  packageId: entityIdSchema.optional(),
  opsAccountUid: nonEmptyStringSchema.optional(),
  workDescription: z.string().optional(),
  publishReceiptId: entityIdSchema.optional(),
  awemeId: douyinAwemeIdSchema.optional(),
  source: douyinWorkBindingSourceSchema.optional(),
  confidence: douyinWorkBindingConfidenceSchema,
  status: douyinWorkBindingStatusSchema,
  publishedAt: isoDateTimeSchema.optional(),
  boundAt: isoDateTimeSchema.optional(),
  externalUrl: nonEmptyStringSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).superRefine((value, ctx) => {
  if (value.source === "HISTORICAL_WORK" && (value.packageId || value.publishReceiptId || !value.opsAccountUid)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "历史作品仅用于运营观察，必须核对账号，不能关联本项目发布包或发布回执" });
  }
  if (value.source !== "HISTORICAL_WORK" && !value.packageId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["packageId"], message: "本项目发布绑定必须有真实发布包" });
  }
  if (value.status === "BOUND" && !value.awemeId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["awemeId"],
      message: "BOUND binding requires awemeId"
    });
  }
  if (value.status === "BOUND" && !value.source) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source"],
      message: "BOUND binding requires source"
    });
  }
  if (value.status === "BOUND" && !value.boundAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["boundAt"],
      message: "BOUND binding requires boundAt"
    });
  }
});

export const douyinMetricSnapshotSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  bindingId: entityIdSchema,
  awemeId: douyinAwemeIdSchema,
  captureKey: nonEmptyStringSchema,
  capturedAt: isoDateTimeSchema,
  plays: z.number().int().nonnegative().optional(),
  likes: z.number().int().nonnegative().optional(),
  comments: z.number().int().nonnegative().optional(),
  shares: z.number().int().nonnegative().optional(),
  collects: z.number().int().nonnegative().optional(),
  metricAvailability:metricAvailabilitySchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  rawJson: z.string(),
  contentHash: sha256Schema,
  createdAt: isoDateTimeSchema
}).superRefine((snapshot,ctx)=>{for(const key of metricKeys){const state=snapshot.metricAvailability?.[key];if(state&&(state==="OBSERVED"?snapshot[key]===undefined:snapshot[key]!==undefined))ctx.addIssue({code:"custom",path:[key],message:"指标可见性与数值不一致，不能用零或历史数值替代缺失"});}});

export const douyinCommentSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  bindingId: entityIdSchema,
  awemeId: douyinAwemeIdSchema,
  cid: z.string().trim().regex(/^\d{1,40}$/, "invalid Douyin comment id"),
  uid: z.string().optional(),
  secUid: z.string().optional(),
  nickname: z.string(),
  text: z.string(),
  diggCount: z.number().int().nonnegative().optional(),
  replyCount: z.number().int().nonnegative().optional(),
  observation:commentObservationSchema.optional(),
  sourceCoverage:commentPageCoverageSchema.optional(),
  platformCreatedAt: isoDateTimeSchema.optional(),
  parentCid: z.string().trim().regex(/^\d{1,40}$/).optional(),
  avatarUrl: z.string().optional(),
  sentiment: nonEmptyStringSchema.optional(),
  category: nonEmptyStringSchema.optional(),
  priority: nonEmptyStringSchema.optional(),
  syncedAt: isoDateTimeSchema,
  rawJson: z.string(),
  contentHash: sha256Schema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export type DouyinWorkBindingStatus = z.infer<
  typeof douyinWorkBindingStatusSchema
>;
export type DouyinWorkBindingSource = z.infer<
  typeof douyinWorkBindingSourceSchema
>;
export type DouyinWorkBindingConfidence = z.infer<
  typeof douyinWorkBindingConfidenceSchema
>;
export type DouyinWorkBinding = z.infer<
  typeof douyinWorkBindingSchema
>;
export type DouyinMetricSnapshot = z.infer<
  typeof douyinMetricSnapshotSchema
>;
export type DouyinComment = z.infer<
  typeof douyinCommentSchema
>;

export const douyinCommentSentimentSchema = z.enum([
  "POSITIVE",
  "NEUTRAL",
  "NEGATIVE",
  "MIXED"
]);

export const douyinCommentCategorySchema = z.enum([
  "PRODUCT_QUESTION",
  "PURCHASE_INTENT",
  "USAGE_FEEDBACK",
  "PRAISE",
  "COMPLAINT",
  "GENERAL_INTERACTION",
  "SPAM_OR_IRRELEVANT"
]);

export const douyinCommentPrioritySchema = z.enum([
  "HIGH",
  "MEDIUM",
  "LOW"
]);

export const douyinCommentClassificationSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  commentId: entityIdSchema,
  awemeId: douyinAwemeIdSchema,
  cid: z.string().trim().regex(/^\d{1,40}$/),
  sourceContentHash: sha256Schema,
  sentiment: douyinCommentSentimentSchema,
  category: douyinCommentCategorySchema,
  priority: douyinCommentPrioritySchema,
  rationale: z.string().trim().max(240).optional(),
  runtimeId: nonEmptyStringSchema,
  runtimeVersion: nonEmptyStringSchema,
  providerId: nonEmptyStringSchema.optional(),
  modelId: nonEmptyStringSchema.optional(),
  executionId: entityIdSchema.optional(),
  configVersion: z.number().int().positive().optional(),
  classifiedAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema
});

export type DouyinCommentSentiment = z.infer<
  typeof douyinCommentSentimentSchema
>;
export type DouyinCommentCategory = z.infer<
  typeof douyinCommentCategorySchema
>;
export type DouyinCommentPriority = z.infer<
  typeof douyinCommentPrioritySchema
>;
export type DouyinCommentClassification = z.infer<
  typeof douyinCommentClassificationSchema
>;

export const douyinReplyStrategySchema = z.enum([
  "ANSWER_QUESTION",
  "ACKNOWLEDGE_FEEDBACK",
  "THANK_AND_ENGAGE",
  "DEESCALATE",
  "CLARIFY_WITHOUT_CLAIMING"
]);

export const douyinReplyDraftStatusSchema = z.enum([
  "DRAFT",
  "REJECTED",
  "APPROVED",
  "POSTED"
]);

export const douyinReplyDraftSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  commentId: entityIdSchema,
  awemeId: douyinAwemeIdSchema,
  cid: z.string().trim().regex(/^\d{1,40}$/),
  sourceContentHash: sha256Schema,
  classificationId: entityIdSchema.optional(),
  productTruthHash: sha256Schema,
  usedFactIds: z.array(entityIdSchema),
  generatedText: z.string().trim().min(1).max(280),
  currentText: z.string().trim().min(1).max(280),
  strategy: douyinReplyStrategySchema,
  status: douyinReplyDraftStatusSchema,
  revision: z.number().int().positive(),
  runtimeId: nonEmptyStringSchema,
  runtimeVersion: nonEmptyStringSchema,
  providerId: nonEmptyStringSchema.optional(),
  modelId: nonEmptyStringSchema.optional(),
  executionId: entityIdSchema.optional(),
  configVersion: z.number().int().positive().optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export type DouyinReplyStrategy = z.infer<
  typeof douyinReplyStrategySchema
>;
export type DouyinReplyDraftStatus = z.infer<
  typeof douyinReplyDraftStatusSchema
>;
export type DouyinReplyDraft = z.infer<
  typeof douyinReplyDraftSchema
>;

export const douyinReplyDraftRevisionActionSchema = z.enum([
  "EDIT",
  "REJECT",
  "POST"
]);

export const douyinReplyDraftRevisionSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  draftId: entityIdSchema,
  commentId: entityIdSchema,
  action: douyinReplyDraftRevisionActionSchema,
  beforeText: z.string().trim().min(1).max(280),
  afterText: z.string().trim().min(1).max(280),
  beforeStatus: douyinReplyDraftStatusSchema,
  afterStatus: douyinReplyDraftStatusSchema,
  expectedRevision: z.number().int().positive(),
  resultingRevision: z.number().int().positive(),
  createdAt: isoDateTimeSchema
});

export type DouyinReplyDraftRevisionAction = z.infer<
  typeof douyinReplyDraftRevisionActionSchema
>;
export type DouyinReplyDraftRevision = z.infer<
  typeof douyinReplyDraftRevisionSchema
>;

export const douyinInsightEvidenceItemSchema = z.object({
  text: z.string().trim().min(1).max(500),
  evidenceRefs: z.array(nonEmptyStringSchema).min(1).max(12),
  claimType:z.enum(["OBSERVATION","METHOD_HYPOTHESIS","PRODUCT_FACT","BUSINESS_EFFECT"]).optional()
});

export const douyinInsightSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  bindingId: entityIdSchema,
  awemeId: douyinAwemeIdSchema,
  productTruthHash: sha256Schema,
  metricSnapshotIds: z.array(entityIdSchema).min(1).max(100),
  commentIds: z.array(entityIdSchema).max(500),
  evidenceHash: sha256Schema,
  observationEvidence:observationEvidenceSchema.optional(),
  summary: z.string().trim().min(1).max(1200),
  strengths: z.array(douyinInsightEvidenceItemSchema).max(8),
  weaknesses: z.array(douyinInsightEvidenceItemSchema).max(8),
  audienceQuestions: z.array(douyinInsightEvidenceItemSchema).max(12),
  nextCreativeActions: z.array(douyinInsightEvidenceItemSchema).max(8),
  runtimeId: nonEmptyStringSchema,
  runtimeVersion: nonEmptyStringSchema,
  providerId: nonEmptyStringSchema.optional(),
  modelId: nonEmptyStringSchema.optional(),
  executionId: entityIdSchema.optional(),
  configVersion: z.number().int().positive().optional(),
  createdAt: isoDateTimeSchema
});

export type DouyinInsightEvidenceItem = z.infer<
  typeof douyinInsightEvidenceItemSchema
>;
export type DouyinInsight = z.infer<
  typeof douyinInsightSchema
>;

export const douyinCreativeFeedbackSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  insightId: entityIdSchema,
  actionIndex: z.number().int().nonnegative(),
  actionHash: sha256Schema,
  actionText: z.string().trim().min(1).max(500),
  evidenceRefs: z.array(nonEmptyStringSchema).min(1).max(12),
  active: z.boolean(),
  confirmedAt: isoDateTimeSchema,
  deactivatedAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export type DouyinCreativeFeedback = z.infer<
  typeof douyinCreativeFeedbackSchema
>;

export const douyinReplyWriteIntentStatusSchema = z.enum([
  "PENDING",
  "REPLY_POSTED_CONFIRMED",
  "SUBMISSION_UNKNOWN",
  "REJECTED",
  "FAILED"
]);

export const douyinReplyWriteIntentSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  draftId: entityIdSchema,
  commentId: entityIdSchema,
  awemeId: douyinAwemeIdSchema,
  cid: z.string().trim().regex(/^\d{1,40}$/),
  textHash: sha256Schema,
  operationFingerprint: sha256Schema,
  draftRevision: z.number().int().positive(),
  status: douyinReplyWriteIntentStatusSchema,
  externalReplyCid: z.string().trim().regex(/^\d{1,40}$/).optional(),
  accountPublishId: nonEmptyStringSchema,
  accountOpsId: nonEmptyStringSchema,
  confirmedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
  message: z.string().trim().max(1000).optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export type DouyinReplyWriteIntentStatus = z.infer<
  typeof douyinReplyWriteIntentStatusSchema
>;
export type DouyinReplyWriteIntent = z.infer<
  typeof douyinReplyWriteIntentSchema
>;

import { z } from "zod";
import {canvasShortPreviewSchema} from "./canvas-short-preview.js";
import {canvasShortPlanSchema} from "./canvas-short-plan.js";
import { productionQuoteSchema } from "./generation-quote.js";
import { canvasProductionBindingSchema } from "./canvas-production.js";
import { v8DirectorRecordSchema, v8PromptRecordSchema } from "./v8-production.js";
import { hashValue } from "./hashing.js";
import { v8ScreenplayRecordSchema } from "./v8-screenplay.js";
import { creativeReferenceSetSchema } from "./creative-reference.js";
import { postProductionSettingsSchema } from "./auto-edit.js";
import {
  creativeBatchSchema, scriptDraftSchema, productionPlanSchema, referenceVideoProfileSchema,
  entityIdSchema, sha256Schema, isoDateTimeSchema, versionRefSchema, directorGenerationTargetSchema
} from "./schemas.js";
import {
  assetPaidScopeSchema,
  productionAssetSetSchema,
  productionStrategySchema
} from "./production-strategy.js";
import {
  directorV3PlanSchema,
  scriptFeasibilityReportSchema,
  seedancePromptV3DraftSchema
} from "./director-v3.js";
const directorGenerationSettingsSchema = directorGenerationTargetSchema.pick({
  requestedModelVersion: true, aspectRatio: true, videoResolution: true, nativeAudioOutputRequested: true
}).strict();

export const smartRunStatusSchema = z.enum([
  "PLANNING", "WAITING_FOR_TRUTH_REVIEW", "WAITING_FOR_REFERENCE_REVIEW",
  "WAITING_FOR_CREATIVE_REVIEW", "WAITING_FOR_SCRIPT_REVIEW", "WAITING_FOR_PLAN_REVIEW",
  "WAITING_FOR_DIRECTOR_REVIEW", "WAITING_FOR_PROMPT_REVIEW",
  "READY_FOR_ASSET_PAID_CONFIRM", "ASSET_PREPARING", "WAITING_FOR_ASSET_REVIEW",
  "READY_FOR_PAID_CONFIRM", "APPROVING", "GENERATING", "WAITING_FOR_CLIP_REVIEW",
  "AUTO_EDITING", "WAITING_FOR_AUDIO", "RENDERING", "REVIEW_READY", "COMPLETED", "BLOCKED", "FAILED", "CANCELLED"
]);
export const smartStageSchema = z.enum([
  "SOURCES",
  "CREATIVE",
  "PRODUCTION_PLANNING",
  "ASSET_PREP",
  "SCRIPT",
  "DIRECTOR",
  "PREFLIGHT",
  "APPROVAL",
  "GENERATION",
  "CLIP_REVIEW",
  "AUTO_EDIT",
  "RENDER",
  "FINAL_REVIEW"
]);
export const smartRunOptionsSchema = z.object({
  requestText: z.string().trim().min(1).max(6000),
  generationSettings: directorGenerationSettingsSchema,
  directorVersion: z.union([z.literal(2), z.literal(3)]).optional(),
  /** Explicit opt-in on new runs only, and disabled without server feature flag. */
  directorPipeline: z.literal("V8").optional(),
  reviewMode: z.enum(["MANUAL", "AUTO"]).default("MANUAL"),
  autoSelectLowRiskClips: z.boolean().default(false),
  useExistingResearch: z.boolean().default(false),
  useResearchReferences: z.boolean().default(false),
  bgmArtifactId: entityIdSchema.optional(),
  allowSilentOutput: z.boolean().default(false),
  postProduction: postProductionSettingsSchema.optional()
}).strict();

export const workspaceBindingSchema = z.object({
  productTruthRef: versionRefSchema.optional(),
  creativeBatchRef: versionRefSchema.optional(),
  selectedCreativeId: entityIdSchema.optional(),
  scriptRef: versionRefSchema.optional(),
  productionPlanRef: versionRefSchema.optional()
});
export const creativeProductionContextSchema = z.object({
  requestText: z.string().trim().min(1).max(6000),
  references: creativeReferenceSetSchema.optional(),
  materialInventory: z.object({
    productImages: z.array(z.object({ artifactId: entityIdSchema, fileVerified: z.boolean() })).max(100),
    generatedSettings: z.array(z.object({ key: z.string(), label: z.string(), status: z.string(), artifactIds: z.array(entityIdSchema) })).max(100),
    rule: z.literal("AVAILABLE_DOES_NOT_MEAN_HUMAN_APPROVED")
  }).optional(),
  research: z.object({
    briefId: entityIdSchema, contentHash: sha256Schema,
    contentOpportunities: z.array(z.string()), uncertainties: z.array(z.string()),
    rule: z.literal("STRUCTURE_ONLY_NOT_PRODUCT_FACTS")
  }).optional()
});
export const paidScopeSchema = z.object({
  hash: sha256Schema,
  planRef: versionRefSchema,
  requests: z.array(z.object({
    requestId: entityIdSchema, requestHash: sha256Schema,
    clipId: entityIdSchema.optional(),
    preflightId: entityIdSchema, preflightHash: sha256Schema,
    costStatus: z.enum(["KNOWN", "UNKNOWN"]),
    estimatedCredits: z.number().nonnegative().optional(), costText: z.string().optional()
  })).min(1),
  preparedAt: isoDateTimeSchema,
  continuityBatch: z.object({ wave: z.number().int().positive(), clipIds: z.array(entityIdSchema).min(1) }).strict().optional(),
  v8Binding: z.object({ runId: entityIdSchema, screenplayHash: sha256Schema, directorRecordHash: sha256Schema, promptRecordHash: sha256Schema }).strict().optional()
});
/** Durable permission for the run named in this record; old runs have no grant. */
export const autoAdvanceGrantSchema = z.object({
  projectId: entityIdSchema, runId: entityIdSchema,
  authorizedAt: isoDateTimeSchema, source: z.enum(["USER_CREATED", "USER_RESUMED"])
}).strict();

export const smartRunSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  workflowVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  requestKey: z.string().min(1).max(120),
  inputHash: sha256Schema,
  revision: z.number().int().positive(),
  status: smartRunStatusSchema,
  stage: smartStageSchema,
  targetDurationMs: z.number().int().min(10000).max(120000),
  options: smartRunOptionsSchema,
  workspaceContinuation: z.object({
    sourceArtifactId: entityIdSchema, sourceArtifactHash: sha256Schema,
    scriptRef: versionRefSchema, planRef: versionRefSchema,
    assetsBound: z.boolean().default(false),
    localPostProductionPending: z.boolean().default(false)
  }).strict().optional(),
  postProduction: postProductionSettingsSchema.optional(),
  expectedWorkspace: workspaceBindingSchema,
  autoAdvanceGrant: autoAdvanceGrantSchema.optional(),
  truthRef: versionRefSchema.optional(),
  assetsHash: sha256Schema.optional(),
  referenceVideoProfile: referenceVideoProfileSchema.optional(),
  creativeContext: creativeProductionContextSchema.optional(),
  creativeBatch: creativeBatchSchema.optional(),
  selectedCreativeId: entityIdSchema.optional(),
  productionStrategy: productionStrategySchema.optional(),
  productionAssetSet: productionAssetSetSchema.optional(),
  assetPaidScope: assetPaidScopeSchema.optional(),
  feeQuote: productionQuoteSchema.optional(),
  canvasBinding: canvasProductionBindingSchema.optional(),
  canvasShortPreviews: z.array(canvasShortPreviewSchema).max(20).optional(),
  canvasShortPlans:z.array(canvasShortPlanSchema).max(20).optional(),
  assetConsent: z.object({
    scopeHash: sha256Schema,
    approvedAt: isoDateTimeSchema,
    acceptedUnknownCostRisk: z.boolean(),
    source: z.literal("EXPLICIT_SMART_RUN_ASSET_PAID_CONFIRMATION")
  }).optional(),
  script: scriptDraftSchema.optional(),
  v8Screenplay: v8ScreenplayRecordSchema.optional(),
  v8Director: v8DirectorRecordSchema.optional(),
  v8Prompts: v8PromptRecordSchema.optional(),
  scriptFeasibility: scriptFeasibilityReportSchema.optional(),
  directorV3Plan: directorV3PlanSchema.optional(),
  seedancePromptDrafts: z.array(seedancePromptV3DraftSchema).optional(),
  productionPlan: productionPlanSchema.optional(),
  pendingInstall: z.enum(["CREATIVE", "SELECT_CREATIVE", "SCRIPT", "CONFIRM_SCRIPT", "DIRECTOR", "CONFIRM_PLAN"]).optional(),
  paidScope: paidScopeSchema.optional(),
  consent: z.object({
    scopeHash: sha256Schema, approvedAt: isoDateTimeSchema,
    acceptedUnknownCostRisk: z.boolean(),
    source: z.literal("EXPLICIT_SMART_RUN_PAID_CONFIRMATION")
  }).optional(),
  attemptIds: z.array(entityIdSchema).default([]),
  activeBatchAttemptIds: z.array(entityIdSchema).optional(),
  completedContinuityWaves: z.array(z.object({
    scopeHash: sha256Schema, clipIds: z.array(entityIdSchema).min(1),
    attemptIds: z.array(entityIdSchema).min(1)
  }).strict()).optional(),
  timelineRef: z.object({ id: entityIdSchema, hash: sha256Schema }).optional(),
  autoEditArtifactId: entityIdSchema.optional(),
  finalOutput: z.object({ artifactId: entityIdSchema, sha256: sha256Schema, renderJobId: entityIdSchema }).optional(),
  blocker: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
  notes: z.array(z.object({ at: isoDateTimeSchema, stage: smartStageSchema, message: z.string() })).max(200),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).superRefine((run, ctx) => {
  if (run.autoAdvanceGrant &&
      (run.autoAdvanceGrant.projectId !== run.projectId || run.autoAdvanceGrant.runId !== run.id)) {
    ctx.addIssue({ code: "custom", path: ["autoAdvanceGrant"],
      message: "执行授权必须与当前任务及项目精确绑定" });
  }
  if (run.options.directorPipeline === "V8") {
    if (run.workflowVersion !== 2 || run.options.reviewMode !== "MANUAL" ||
        run.options.directorVersion !== 3) {
      ctx.addIssue({ code: "custom", path: ["options", "directorPipeline"],
        message: "V8 新流程必须使用新版工作流、V3兼容导演接口及逐阶段人工审核" });
    }
    if (run.script && (!run.v8Screenplay ||
        run.v8Screenplay.sourceScriptHash !== run.script.contentHash)) {
      ctx.addIssue({ code: "custom", path: ["v8Screenplay"],
        message: "V8 详细剧本与兼容 ScriptDraft 必须保持严格版本绑定" });
    }
    if (run.v8Screenplay) {
      const beats = run.v8Screenplay.screenplay.scenes.flatMap(scene => scene.beats);
      const totalMs = beats.reduce((sum, beat) => sum + beat.estimatedDurationMs, 0);
      if (totalMs !== run.targetDurationMs || beats.length !== run.script?.beats.length ||
          run.v8Screenplay.brief !== run.options.requestText) {
        ctx.addIssue({ code: "custom", path: ["v8Screenplay"],
          message: "V8 详细剧本时长、Beat 数量或本轮需求与当前 ScriptDraft 不一致" });
      }
    }
    if (run.v8Screenplay?.status === "CONFIRMED" && run.script?.status !== "CONFIRMED") {
      ctx.addIssue({ code: "custom", path: ["script"],
        message: "V8 已确认剧本需要已确认的同源 ScriptDraft" });
    }
    const director = run.v8Director;
    const prompts = run.v8Prompts;
    const plan = run.productionPlan;
    const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["v8Director"], message });
    if (director && (run.v8Screenplay?.status !== "CONFIRMED" ||
        director.decision.sourceScriptHash !== run.script?.contentHash ||
        director.decision.screenplayHash !== run.v8Screenplay?.screenplayHash)) {
      issue("V8 导演决策与已确认剧本版本不一致");
    }
    if (plan && (!director || director.status !== "CONFIRMED" ||
        plan.scriptRef.hash !== run.script?.contentHash ||
        hashValue(plan.generationTarget) !== hashValue(director.generationTarget))) {
      issue("V8 正式分镜必须绑定人工采用的导演和模型能力");
    }
    if (prompts && (!director || director.status !== "CONFIRMED" || plan?.status !== "CONFIRMED" ||
        prompts.screenplayHash !== run.v8Screenplay?.screenplayHash ||
        prompts.directorRecordHash !== director.contentHash ||
        prompts.assetSetHash !== run.productionAssetSet?.contentHash ||
        prompts.packages.length !== plan.scenes.flatMap(scene => scene.clips).length ||
        prompts.packages.some((p, i) => p.scriptHash !== run.script?.contentHash ||
          p.directorHash !== director.decision.contentHash || p.productionPlanHash !== plan.contentHash ||
          p.clipId !== plan.scenes.flatMap(scene => scene.clips)[i]?.id))) {
      issue("V8 提示词采用版本与正式分镜、声线或资产失配");
    }
    if (run.paidScope || run.consent || run.attemptIds.length > 0 ||
        ["APPROVING", "GENERATING", "READY_FOR_PAID_CONFIRM"].includes(run.status)) {
      const binding = run.paidScope?.v8Binding;
      if (prompts?.status !== "CONFIRMED" || !binding || binding.runId !== run.id ||
          binding.screenplayHash !== run.v8Screenplay?.screenplayHash ||
          binding.directorRecordHash !== director?.contentHash || binding.promptRecordHash !== prompts.contentHash ||
          run.paidScope?.planRef.hash !== plan?.contentHash) {
        issue("V8 导演和逐镜 Prompt 尚未正式采用或授权绑定失效，禁止生成与复用付费授权");
      }
    }
  }
  if (
    run.status === "ASSET_PREPARING" &&
    (!run.assetPaidScope ||
      !run.assetConsent ||
      run.assetConsent.scopeHash !== run.assetPaidScope.hash)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["assetConsent"],
      message:
        "Paid production asset generation requires an explicit confirmation bound to the exact asset scope"
    });
  }
  if (["APPROVING", "GENERATING"].includes(run.status) && (!run.paidScope || !run.consent || run.consent.scopeHash !== run.paidScope.hash)) {
    ctx.addIssue({ code: "custom", path: ["consent"], message: "Paid execution requires an explicit confirmation bound to this exact request set" });
  }
  if (["REVIEW_READY", "COMPLETED"].includes(run.status) && !run.finalOutput) {
    ctx.addIssue({ code: "custom", path: ["finalOutput"], message: "A ready final preview requires a real audited output Artifact" });
  }
});
export type SmartGenerationRun = z.infer<typeof smartRunSchema>;
export type SmartRunOptions = z.infer<typeof smartRunOptionsSchema>;
export type SmartRunStatus = z.infer<typeof smartRunStatusSchema>;
export type SmartStage = z.infer<typeof smartStageSchema>;
export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>;
export type CreativeProductionContext = z.infer<typeof creativeProductionContextSchema>;
export const runnableSmartStatuses: SmartRunStatus[] = ["PLANNING", "ASSET_PREPARING", "APPROVING", "GENERATING", "AUTO_EDITING", "RENDERING"];
export const closedSmartStatuses: SmartRunStatus[] = ["COMPLETED", "CANCELLED"];

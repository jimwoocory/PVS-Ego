import {feedbackInputReceiptSchema} from "./douyin-feedback-evidence.js";
import { z } from "zod";

export const isoDateTimeSchema = z.string().datetime({ offset: true });
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "expected sha256 hex");
export const entityIdSchema = z.string().trim().min(1);
export const nonEmptyStringSchema = z.string().trim().min(1);
export const versionStatusSchema = z.enum(["DRAFT", "CONFIRMED", "STALE"]);
export const gateStatusSchema = z.enum(["PASS", "BLOCKED", "STALE"]);
export const riskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export const videoAspectRatioSchema = z
  .string()
  .trim()
  .regex(/^(?:AUTO|\d+:\d+)$/, "expected AUTO or width:height ratio");
export const videoResolutionSchema = z.string().trim().min(1);

export const versionRefSchema = z.object({
  entityType: nonEmptyStringSchema,
  entityId: entityIdSchema,
  version: z.number().int().positive(),
  hash: sha256Schema
});

export const aiExecutionRefSchema = z.object({
  executionId: entityIdSchema,
  providerId: nonEmptyStringSchema,
  modelId: nonEmptyStringSchema,
  configVersion: z.number().int().positive()
});

export const projectStatusSchema = z.enum([
  "DRAFT",
  "PRODUCT_TRUTH_REVIEW",
  "CREATIVE_REVIEW",
  "SCRIPT_REVIEW",
  "DIRECTOR_REVIEW",
  "READY_TO_GENERATE",
  "GENERATING",
  "GENERATION_REVIEW",
  "READY_TO_ASSEMBLE",
  "FINAL_REVIEW",
  "READY_TO_PUBLISH",
  "PUBLISHING",
  "PUBLISHED",
  "COMPLETED",
  "FAILED"
]);

export const projectSchema = z.object({
  id: entityIdSchema,
  name: nonEmptyStringSchema,
  status: projectStatusSchema,
  targetPlatform: z.literal("douyin"),
  targetDurationMs: z.number().int().min(10000).max(120000),
  aspectRatio: videoAspectRatioSchema,
  currentProductTruthRef: versionRefSchema.optional(),
  currentCreativeBatchRef: versionRefSchema.optional(),
  selectedCreativeId: entityIdSchema.optional(),
  currentScriptRef: versionRefSchema.optional(),
  currentProductionPlanRef: versionRefSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const artifactIntegrityStatusSchema = z.enum(["PENDING", "READY", "MISSING", "CORRUPT"]);
export const artifactKindSchema = z.enum([
  "USER_INPUT",
  "STRUCTURED_SNAPSHOT",
  "PROMPT",
  "REQUEST",
  "PROVIDER_PROBE",
  "STDOUT",
  "STDERR",
  "PROVIDER_RESULT",
  "GENERATED_VIDEO",
  "FINAL_VIDEO",
  "OTHER"
]);

export const artifactRecordSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  kind: artifactKindSchema,
  relativePath: nonEmptyStringSchema,
  sha256: sha256Schema.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  mimeType: nonEmptyStringSchema.optional(),
  integrityStatus: artifactIntegrityStatusSchema,
  immutable: z.literal(true),
  createdAt: isoDateTimeSchema
}).superRefine((artifact, ctx) => {
  if (artifact.integrityStatus === "READY") {
    if (!artifact.sha256) ctx.addIssue({ code: "custom", path: ["sha256"], message: "READY artifact requires sha256" });
    if (artifact.sizeBytes === undefined) ctx.addIssue({ code: "custom", path: ["sizeBytes"], message: "READY artifact requires sizeBytes" });
  }
});

export const assetRefSchema = z.object({
  id: entityIdSchema,
  artifactId: entityIdSchema,
  type: z.enum(["image", "video", "audio", "logo", "document"]),
  source: z.enum(["user_upload", "generated", "external"]),
  originalFilename: nonEmptyStringSchema.optional(),
  sha256: sha256Schema,
  mimeType: nonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  provenance: nonEmptyStringSchema.optional(),
  createdAt: isoDateTimeSchema
});

export const referenceVideoProfileSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  version: z.number().int().positive(),
  status: z.enum(["ACTIVE", "STALE"]),
  sourceType: z.enum(["UPLOAD", "URL"]),
  sourceUrl: z.string().url().optional(),
  videoArtifactId: entityIdSchema,
  videoArtifactHash: sha256Schema,
  originalFilename: nonEmptyStringSchema.optional(),
  media: z.object({
    durationMs: z.number().int().positive(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    frameRate: z.number().positive().optional(),
    hasAudio: z.boolean(),
    sampledFrameCount: z.number().int().nonnegative(),
    sceneCutTimestampsMs: z.array(z.number().int().nonnegative())
  }),
  analysisConfidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  hook: z.object({
    firstThreeSecondsPattern: nonEmptyStringSchema,
    structuralPurpose: nonEmptyStringSchema
  }),
  pacing: z.object({
    overall: nonEmptyStringSchema,
    estimatedShotCount: z.number().int().positive(),
    averageShotDurationMs: z.number().int().positive()
  }),
  shotLanguage: z.object({
    shotSizes: z.array(nonEmptyStringSchema),
    cameraPositions: z.array(nonEmptyStringSchema),
    cameraMovements: z.array(nonEmptyStringSchema),
    compositionPatterns: z.array(nonEmptyStringSchema)
  }),
  productAppearance: z.object({
    firstAppearanceMs: z.number().int().nonnegative().nullable(),
    visibilityPattern: nonEmptyStringSchema,
    showcasePattern: nonEmptyStringSchema
  }),
  sellingPointPattern: z.array(nonEmptyStringSchema),
  dialogueNarrationStructure: nonEmptyStringSchema,
  audioBgMusicStructure: nonEmptyStringSchema,
  ctaPattern: nonEmptyStringSchema,
  reusableStylePrinciples: z.array(nonEmptyStringSchema),
  copyGuard: z.literal("STRUCTURE_AND_METHOD_ONLY"),
  observation:z.object({version:z.enum(["reference-observation-v2","reference-observation-v3"]),sourceSha256:sha256Schema,
    samplingManifest:z.object({artifactId:entityIdSchema,sha256:sha256Schema}).optional(),
    timing:z.object({status:z.literal("DECODED_FRAME_PTS"),origin:z.literal("FIRST_VIDEO_FRAME"),precisionMs:z.literal(1)}).optional(),
    frames:z.array(z.object({artifactId:entityIdSchema,sha256:sha256Schema,timestampMs:z.number().int().nonnegative()})),
    audio:z.object({status:z.enum(["NO_TRACK","NOT_OBSERVED"]),reason:nonEmptyStringSchema}),
    ocr:z.object({status:z.enum(["NOT_OBSERVED","SAMPLED_FRAMES_ONLY"]),reason:nonEmptyStringSchema}),
    frameObservations:z.array(z.object({timestampMs:z.number().int().nonnegative(),observation:nonEmptyStringSchema,
      visibleText:z.string().max(100).optional(),confidence:z.enum(["LOW","MEDIUM","HIGH"]),
      frameArtifactId:entityIdSchema.optional(),frameSha256:sha256Schema.optional(),textStatus:z.enum(["READABLE","UNCERTAIN","NOT_VISIBLE"]).optional()})),
    limitations:z.array(nonEmptyStringSchema)
  }).optional(),
  aiExecution: aiExecutionRefSchema.optional(),
  contentHash: sha256Schema,
  createdAt: isoDateTimeSchema
}).superRefine((profile,ctx)=>{
  const observation=profile.observation;
  if(observation?.version!=="reference-observation-v3")return;
  const fail=(message:string)=>ctx.addIssue({code:"custom",path:["observation"],message});
  if(!observation.timing||observation.sourceSha256!==profile.videoArtifactHash||observation.frames.length!==profile.media.sampledFrameCount)fail("参考视频时间证据或源文件绑定不一致");
  const frames=new Map(observation.frames.map(frame=>[frame.timestampMs,frame]));
  if(frames.size!==observation.frames.length||observation.frames.some((frame,index)=>frame.timestampMs>=profile.media.durationMs||(index>0&&frame.timestampMs<=observation.frames[index-1]!.timestampMs)))fail("参考视频采样时间必须位于源文件范围且严格递增");
  if(new Set(observation.frameObservations.map(item=>item.timestampMs)).size!==observation.frameObservations.length)fail("同一采样帧不能重复识别");
  for(const item of observation.frameObservations){
    const frame=frames.get(item.timestampMs);
    if(!frame||item.frameArtifactId!==frame.artifactId||item.frameSha256!==frame.sha256||!item.textStatus)fail("文字与画面识别必须绑定实际采样帧及哈希");
    if(item.visibleText?(item.textStatus==="NOT_VISIBLE"||(item.confidence==="LOW"&&item.textStatus!=="UNCERTAIN")):item.textStatus!=="NOT_VISIBLE")fail("参考帧文字识别状态不一致");
  }
});

export const productFactSchema = z.object({
  id: entityIdSchema,
  statement: nonEmptyStringSchema,
  sourceType: z.enum(["user", "official", "external"]),
  evidenceRef: nonEmptyStringSchema.optional(),
  createdAt: isoDateTimeSchema
});

export const forbiddenChangeSchema = z.object({
  id: entityIdSchema,
  field: z.enum(["logo", "color", "shape", "packaging", "text", "model", "proportion", "other"]),
  description: nonEmptyStringSchema,
  severity: z.enum(["HARD", "SOFT"])
});

export const uncertainClaimSchema = z.object({
  id: entityIdSchema,
  statement: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
  sourceType: z.enum(["user", "research"]).optional(),
  evidenceRefs: z.array(nonEmptyStringSchema).optional(),
  status: z.enum(["UNVERIFIED", "REJECTED", "PROMOTED"]),
  dispositionConfirmedByUser: z.boolean(),
  promotedFactId: entityIdSchema.optional()
}).superRefine((claim, ctx) => {
  if (claim.status === "PROMOTED" && !claim.promotedFactId) {
    ctx.addIssue({ code: "custom", path: ["promotedFactId"], message: "PROMOTED claim requires promotedFactId" });
  }
  if (claim.status !== "PROMOTED" && claim.promotedFactId) {
    ctx.addIssue({ code: "custom", path: ["promotedFactId"], message: "Only PROMOTED claim may have promotedFactId" });
  }
});

export const productUsageRuleSchema = z.object({
  id: entityIdSchema,
  category: z.enum([
    "USAGE_METHOD",
    "WEARING_POSITION",
    "PRECAUTION",
    "FUNCTION_EFFECT",
    "USAGE_SCENARIO",
    "PRODUCT_STATE",
    "LIMITATION"
  ]),
  polarity: z.enum(["MUST", "MUST_NOT", "CONTEXT"]),
  statement: nonEmptyStringSchema,
  sourceType: z.enum(["user", "research"]),
  evidenceRefs: z.array(nonEmptyStringSchema).optional(),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  status: z.enum(["UNVERIFIED", "REJECTED", "CONFIRMED"]),
  dispositionConfirmedByUser: z.boolean()
});

export const productTruthSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  version: z.number().int().positive(),
  status: versionStatusSchema,
  productName: nonEmptyStringSchema,
  brand: nonEmptyStringSchema.optional(),
  category: nonEmptyStringSchema.optional(),
  referenceImageIds: z.array(entityIdSchema).min(1),
  canonicalImageId: entityIdSchema,
  logoAssetId: entityIdSchema.optional(),
  standardColors: z.array(nonEmptyStringSchema),
  confirmedFeatures: z.array(productFactSchema),
  sellingPoints: z.array(productFactSchema),
  forbiddenChanges: z.array(forbiddenChangeSchema),
  usageRules: z.array(productUsageRuleSchema).optional(),
  uncertainClaims: z.array(uncertainClaimSchema),
  evidenceRefs: z.array(nonEmptyStringSchema),
  inputRefs: z.array(versionRefSchema),
  aiExecution: aiExecutionRefSchema.optional(),
  contentHash: sha256Schema,
  confirmedAt: isoDateTimeSchema.optional()
}).superRefine((truth, ctx) => {
  const factIds = new Set([...truth.confirmedFeatures, ...truth.sellingPoints].map((f) => f.id));
  const claimIds = new Set(truth.uncertainClaims.map((c) => c.id));
  for (const id of claimIds) {
    if (factIds.has(id)) ctx.addIssue({ code: "custom", path: ["uncertainClaims"], message: `Claim id ${id} collides with ProductFact id` });
  }
  if (truth.status === "CONFIRMED" && !truth.confirmedAt) {
    ctx.addIssue({ code: "custom", path: ["confirmedAt"], message: "CONFIRMED ProductTruth requires confirmedAt" });
  }
  if (truth.status === "CONFIRMED") {
    truth.uncertainClaims.forEach((claim, index) => {
      if (!claim.dispositionConfirmedByUser) {
        ctx.addIssue({ code: "custom", path: ["uncertainClaims", index, "dispositionConfirmedByUser"], message: "Confirmed ProductTruth requires user-confirmed claim disposition" });
      }
    });
    (truth.usageRules ?? []).forEach((rule, index) => {
      if (!rule.dispositionConfirmedByUser) {
        ctx.addIssue({ code: "custom", path: ["usageRules", index, "dispositionConfirmedByUser"], message: "Confirmed ProductTruth requires user-confirmed usage-rule disposition" });
      }
    });
  }
});

export const creativeConceptSchema = z.object({
  id: entityIdSchema,
  title: nonEmptyStringSchema,
  targetAudience: nonEmptyStringSchema,
  painPoint: nonEmptyStringSchema,
  hook: nonEmptyStringSchema,
  coreSellingPoint: nonEmptyStringSchema,
  narrativePattern: nonEmptyStringSchema,
  expectedDurationMs: z.number().int().min(10000).max(120000),
  productShowcaseStrategy: nonEmptyStringSchema,
  generationRisk: riskLevelSchema,
  requiredFactIds: z.array(entityIdSchema)
});

export const creativeBatchSchema = z.object({
  douyinFeedbackReceipt:feedbackInputReceiptSchema.optional(),
  id: entityIdSchema,
  projectId: entityIdSchema,
  version: z.number().int().positive(),
  status: z.enum(["ACTIVE", "STALE"]),
  productTruthRef: versionRefSchema,
  referenceVideoProfileRef: versionRefSchema.optional(),
  creativeReferenceSetRef: versionRefSchema.optional(),
  generatorVersion: nonEmptyStringSchema,
  aiExecution: aiExecutionRefSchema.optional(),
  concepts: z.array(creativeConceptSchema).min(4).max(6),
  selectedCreativeId: entityIdSchema.optional(),
  contentHash: sha256Schema,
  createdAt: isoDateTimeSchema
}).superRefine((batch, ctx) => {
  const ids = batch.concepts.map((c) => c.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["concepts"], message: "CreativeConcept ids must be unique within batch" });
  if (batch.selectedCreativeId && !ids.includes(batch.selectedCreativeId)) {
    ctx.addIssue({ code: "custom", path: ["selectedCreativeId"], message: "selectedCreativeId must belong to batch" });
  }
});

export const scriptBeatSchema = z.object({
  id: entityIdSchema,
  order: z.number().int().nonnegative(),
  purpose: z.enum(["HOOK", "PAIN", "PRODUCT", "FEATURE", "PROOF", "RESULT", "CTA", "OTHER"]),
  text: nonEmptyStringSchema,
  estimatedDurationMs: z.number().int().positive(),
  requiredFactIds: z.array(entityIdSchema),
  videoIntent: z.object({
    location: nonEmptyStringSchema,
    storyAction: nonEmptyStringSchema,
    productRole: nonEmptyStringSchema,
    stateIn: nonEmptyStringSchema,
    stateOut: nonEmptyStringSchema,
    productStateIn: z.string().trim().min(1).optional(),
    productStateOut: z.string().trim().min(1).optional(),
    dialogue: z.string().trim().min(1).optional(),
    os: z.string().trim().min(1).optional(),
    audioIntent: z.object({
      ambience: z.array(nonEmptyStringSchema).default([]),
      sfx: z.array(nonEmptyStringSchema).default([]),
      bgm: z.literal(false)
    }).strict(),
    postProductionText: z.array(nonEmptyStringSchema).default([])
  }).strict().optional()
});

export const scriptDraftSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  version: z.number().int().positive(),
  status: versionStatusSchema,
  productTruthRef: versionRefSchema,
  creativeBatchRef: versionRefSchema,
  referenceVideoProfileRef: versionRefSchema.optional(),
  creativeReferenceSetRef: versionRefSchema.optional(),
  productionAssetSetRef: versionRefSchema.optional(),
  selectedCreativeId: entityIdSchema,
  targetDurationMs: z.number().int().min(10000).max(120000),
  aiExecution: aiExecutionRefSchema.optional(),
  beats: z.array(scriptBeatSchema).min(1),
  contentHash: sha256Schema,
  confirmedAt: isoDateTimeSchema.optional()
}).superRefine((script, ctx) => {
  if (script.status === "CONFIRMED" && !script.confirmedAt) {
    ctx.addIssue({ code: "custom", path: ["confirmedAt"], message: "CONFIRMED ScriptDraft requires confirmedAt" });
  }
});

export const continuityStateSchema = z.object({
  description: nonEmptyStringSchema,
  productState: nonEmptyStringSchema,
  characterState: nonEmptyStringSchema.optional(),
  environmentState: nonEmptyStringSchema,
  stateHash: sha256Schema
});

export const dialogueOrNarrationSchema = z.union([
  z.object({ kind: z.literal("NONE") }).strict(),
  z.object({
    kind: z.literal("DIALOGUE"),
    text: nonEmptyStringSchema,
    estimatedDurationMs: z.number().int().positive(),
    estimatorVersion: nonEmptyStringSchema
  }).strict(),
  z.object({
    kind: z.literal("NARRATION"),
    text: nonEmptyStringSchema,
    estimatedDurationMs: z.number().int().positive(),
    estimatorVersion: nonEmptyStringSchema
  }).strict()
]);

export const ambientSoundSchema = z.union([
  z.object({ kind: z.literal("NONE") }).strict(),
  z.object({ kind: z.literal("AMBIENT"), description: nonEmptyStringSchema }).strict()
]);

export const postProductionTextCueSchema = z.object({
  kind: z.enum(["CAPTION", "CTA", "LEGAL", "LABEL"]),
  text: nonEmptyStringSchema,
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  position: z.enum(["TOP", "CENTER", "BOTTOM"]),
  fontScale: z.number().min(0.5).max(3).default(1),
  sourceBeatIds: z.array(entityIdSchema).default([]),
  requiredFactIds: z.array(entityIdSchema).default([])
}).strict().superRefine((cue, ctx) => {
  if (cue.endMs <= cue.startMs) {
    ctx.addIssue({
      code: "custom",
      path: ["endMs"],
      message: "Post-production text cue endMs must be greater than startMs"
    });
  }
});

export const referenceAssetUseSchema = z.object({
  assetId: entityIdSchema,
  role: z.enum(["PRIMARY_PRODUCT", "LOGO", "STYLE", "ENVIRONMENT", "CHARACTER", "OTHER", "PRODUCT_ANGLE", "WEARING_REFERENCE", "USAGE_ACTION_REFERENCE", "SCENE_REFERENCE", "LOGO_REFERENCE"]),
  priority: z.number().int().nonnegative(),
  required: z.boolean()
});

export const clipRiskAssessmentSchema = z.object({
  level: riskLevelSchema,
  reasonCodes: z.array(nonEmptyStringSchema),
  mitigations: z.array(nonEmptyStringSchema),
  source: z.enum(["PRODUCT_DIRECTOR", "USER_OVERRIDE"])
});

export const segmentSchema = z.object({
  id: entityIdSchema,
  order: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  shotSize: nonEmptyStringSchema,
  cameraPosition: nonEmptyStringSchema,
  cameraAngle: nonEmptyStringSchema,
  cameraMovement: nonEmptyStringSchema,
  composition: nonEmptyStringSchema,
  subjectAction: nonEmptyStringSchema,
  productState: nonEmptyStringSchema,
  dialogueOrNarration: dialogueOrNarrationSchema,
  ambientSound: ambientSoundSchema,
  postProductionText: z.array(postProductionTextCueSchema).max(12).default([]),
  // Opt-in metadata for V8 scenes; older production plans remain unchanged.
  v8: z.object({
    sourceShotId: nonEmptyStringSchema,
    sourceBeatId: entityIdSchema,
    sourceActionHash: sha256Schema,
    shotFunction: z.enum(["ESTABLISH", "SPEECH", "REACTION", "ACTION"]),
    spoken: z.object({
      speaker: nonEmptyStringSchema,
      mode: z.enum(["ONSCREEN", "OFFSCREEN", "OS"]),
      // Retain spaces inside a literal spoken fragment (important for
      // punctuation-boundary splits); older V8 plans have no part metadata.
      exactText: z.string().refine(s => s.trim().length > 0),
      tone: nonEmptyStringSchema,
      delivery: nonEmptyStringSchema,
      sourceLineText: z.string().refine(s => s.trim().length > 0).optional(),
      sourcePartIndex: z.number().int().positive().optional(),
      sourcePartCount: z.number().int().positive().optional()
    }).strict().optional(),
    audienceKnowledgeChange: nonEmptyStringSchema.optional()
  }).strict().optional(),
  lighting: nonEmptyStringSchema,
  continuityIn: continuityStateSchema,
  continuityOut: continuityStateSchema,
  sourceBeatIds: z.array(entityIdSchema),
  requiredFactIds: z.array(entityIdSchema)
});

export const clipAggregateStatusSchema = z.enum(["PLANNED", "READY", "GENERATING", "NEEDS_REVIEW", "ACTION_REQUIRED", "ACCEPTED", "STALE"]);

export const clipSchema = z.object({
  id: entityIdSchema,
  sceneId: entityIdSchema,
  order: z.number().int().nonnegative(),
  durationMs: z.number().int().min(4000).max(15000),
  purpose: nonEmptyStringSchema,
  openingState: continuityStateSchema,
  closingState: continuityStateSchema,
  referenceAssets: z.array(referenceAssetUseSchema),
  productVisibility: z.enum(["NONE", "PARTIAL", "CLEAR", "HERO"]),
  strictProductIdentity: z.boolean(),
  strictProductIdentityScope: z.array(nonEmptyStringSchema),
  riskAssessment: clipRiskAssessmentSchema,
  sourceBeatIds: z.array(entityIdSchema),
  requiredFactIds: z.array(entityIdSchema),
  segments: z.array(segmentSchema).min(1),
  aggregateStatus: clipAggregateStatusSchema,
  contentHash: sha256Schema
}).superRefine((clip, ctx) => {
  const segments = clip.segments;
  if (segments[0]?.startMs !== 0) {
    ctx.addIssue({ code: "custom", path: ["segments", 0, "startMs"], message: "First segment must start at 0" });
  }
  if (segments.at(-1)?.endMs !== clip.durationMs) {
    ctx.addIssue({ code: "custom", path: ["segments", segments.length - 1, "endMs"], message: "Last segment must end at clip.durationMs" });
  }
  if (segments[0] && segments[0].continuityIn.stateHash !== clip.openingState.stateHash) {
    ctx.addIssue({ code: "custom", path: ["segments", 0, "continuityIn", "stateHash"], message: "First segment continuityIn must match clip openingState" });
  }
  if (segments.at(-1) && segments.at(-1)!.continuityOut.stateHash !== clip.closingState.stateHash) {
    ctx.addIssue({ code: "custom", path: ["segments", segments.length - 1, "continuityOut", "stateHash"], message: "Last segment continuityOut must match clip closingState" });
  }
  const orders = new Set<number>();
  for (let i = 0; i < segments.length; i += 1) {
    const current = segments[i]!;
    if (current.endMs <= current.startMs) ctx.addIssue({ code: "custom", path: ["segments", i], message: "Segment endMs must be greater than startMs" });
    if (orders.has(current.order)) ctx.addIssue({ code: "custom", path: ["segments", i, "order"], message: "Segment order must be unique" });
    orders.add(current.order);
    if (current.dialogueOrNarration.kind !== "NONE" && current.dialogueOrNarration.estimatedDurationMs > current.endMs - current.startMs) {
      ctx.addIssue({ code: "custom", path: ["segments", i, "dialogueOrNarration", "estimatedDurationMs"], message: "Speech duration exceeds segment duration" });
    }
    for (let cueIndex = 0; cueIndex < current.postProductionText.length; cueIndex += 1) {
      const cue = current.postProductionText[cueIndex]!;
      if (cue.startMs < current.startMs || cue.endMs > current.endMs) {
        ctx.addIssue({
          code: "custom",
          path: ["segments", i, "postProductionText", cueIndex],
          message: "Post-production text cue must stay inside its Segment"
        });
      }
    }
    if (i > 0) {
      const previous = segments[i - 1]!;
      if (previous.endMs !== current.startMs) {
        ctx.addIssue({ code: "custom", path: ["segments", i, "startMs"], message: "Segments must have no gap or overlap" });
      }
      if (previous.continuityOut.stateHash !== current.continuityIn.stateHash) {
        ctx.addIssue({ code: "custom", path: ["segments", i, "continuityIn", "stateHash"], message: "Adjacent segment continuity hashes must match" });
      }
      if (previous.order >= current.order) {
        ctx.addIssue({ code: "custom", path: ["segments", i, "order"], message: "Segment order must increase with time" });
      }
    }
  }
});

export const sceneSchema = z.object({
  id: entityIdSchema,
  order: z.number().int().nonnegative(),
  purpose: nonEmptyStringSchema,
  location: nonEmptyStringSchema,
  timeOfDay: nonEmptyStringSchema.optional(),
  visualState: nonEmptyStringSchema,
  sourceBeatIds: z.array(entityIdSchema),
  requiredFactIds: z.array(entityIdSchema),
  clips: z.array(clipSchema).min(1)
});

export const continuityLockSchema = z.object({
  product: z.object({
    stableAttributes: z.array(nonEmptyStringSchema),
    forbiddenChanges: z.array(forbiddenChangeSchema)
  }),
  characters: z.array(z.object({
    name: nonEmptyStringSchema,
    stableAppearance: nonEmptyStringSchema,
    wardrobe: nonEmptyStringSchema
  })),
  environments: z.array(z.object({
    sceneId: entityIdSchema,
    stableElements: z.array(nonEmptyStringSchema)
  }))
});

export const directorGenerationTargetSchema = z.object({
  source: z.literal("DREAMINA_CAPABILITY_REGISTRY"),
  requestedModelVersion: nonEmptyStringSchema,
  aspectRatio: videoAspectRatioSchema,
  videoResolution: videoResolutionSchema,
  nativeAudioOutputRequested: z.boolean(),
  registryFingerprint: sha256Schema,
  capabilityCheckedAt: isoDateTimeSchema,
  operationConstraints: z.array(
    z.object({
      operation: z.enum([
        "text2video",
        "image2video",
        "frames2video",
        "multiframe2video",
        "multimodal2video"
      ]),
      operationLabel: nonEmptyStringSchema,
      modelMode: z.enum(["EXPLICIT", "COMMAND_DEFAULT", "FIXED"]),
      modelVersion: nonEmptyStringSchema.optional(),
      fixedModelLabel: nonEmptyStringSchema.optional(),
      durationMinSeconds: z.number().positive().optional(),
      durationMaxSeconds: z.number().positive().optional(),
      maxImages: z.number().int().positive().optional(),
      maxVideos: z.number().int().positive().optional(),
      maxAudio: z.number().int().positive().optional(),
      maxTotalInputs: z.number().int().positive().optional(),
      supportsReferenceAudio: z.boolean(),
      supportsNativeAudioOutput: z.boolean(),
      explicitRatioAllowed: z.boolean(),
      supportedResolutions: z.array(videoResolutionSchema)
    })
  ).min(1)
});

export const productionPlanSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  version: z.number().int().positive(),
  status: versionStatusSchema,
  productTruthRef: versionRefSchema,
  scriptRef: versionRefSchema,
  referenceVideoProfileRef: versionRefSchema.optional(),
  creativeReferenceSetRef: versionRefSchema.optional(),
  productionAssetSetRef: versionRefSchema.optional(),
  generationTarget: directorGenerationTargetSchema.optional(),
  v8Source: z.object({ screenplayHash: sha256Schema, directorDecisionHash: sha256Schema,
    directorRecordHash: sha256Schema }).strict().optional(),
  selectedCreativeId: entityIdSchema,
  visualDirection: nonEmptyStringSchema,
  soundDirection: nonEmptyStringSchema,
  productShowcaseRules: z.array(nonEmptyStringSchema),
  continuityLock: continuityLockSchema,
  aiExecution: aiExecutionRefSchema.optional(),
  scenes: z.array(sceneSchema).min(1),
  contentHash: sha256Schema,
  confirmedAt: isoDateTimeSchema.optional()
}).superRefine((plan, ctx) => {
  if (plan.status === "CONFIRMED" && !plan.confirmedAt) {
    ctx.addIssue({ code: "custom", path: ["confirmedAt"], message: "CONFIRMED ProductionPlan requires confirmedAt" });
  }
});

export const promptFactMappingSchema = z.object({
  factId: entityIdSchema,
  sourceBeatIds: z.array(entityIdSchema),
  sceneIds: z.array(entityIdSchema),
  clipId: entityIdSchema,
  segmentIds: z.array(entityIdSchema),
  promptSection: nonEmptyStringSchema
});

export const inputAssetManifestEntrySchema = z.object({
  assetId: entityIdSchema,
  artifactHash: sha256Schema,
  role: referenceAssetUseSchema.shape.role,
  priority: z.number().int().nonnegative(),
  required: z.boolean(),
  inputType: z.enum(["image", "video", "audio"]).optional(),
  researchReference: z.object({setId:entityIdSchema,setHash:sha256Schema,candidateId:entityIdSchema,sourceUrl:z.string().url().refine(s=>/^https?:\/\//i.test(s)),timestampMs:z.number().int().nonnegative().optional()}).optional(),
  agentReferenceAdaptation: z.object({
    sourceArtifactId: entityIdSchema,
    sourceArtifactHash: sha256Schema,
    strategy: z.literal("KEYFRAME"),
    adapterVersion: nonEmptyStringSchema,
    sourceDurationMs: z.number().int().positive(),
    timestampMs: z.number().int().nonnegative(),
    frameIndex: z.number().int().nonnegative()
  }).optional()
});

/** Explicit, versioned image ordinal -> asset file mapping. Legacy requests omit it. */
export const imageAssetBindingSchema = z.object({
  imageIndex: z.number().int().positive(),
  assetName: nonEmptyStringSchema,
  assetId: entityIdSchema,
  artifactHash: sha256Schema,
  providerSlot: z.enum(["REFERENCE_IMAGE", "FIRST_FRAME", "LAST_FRAME"]),
  referencedByPrompt: z.boolean()
}).strict();

/** Derived from an immutable user-accepted MP4 tail, not an unverified @ mention. */
export const continuitySourceBindingSchema = z.object({
  version: z.literal("continuity-source-binding-1"),
  sourceClipId: entityIdSchema,
  sourceAttemptId: entityIdSchema,
  sourceVideoArtifactId: entityIdSchema,
  sourceVideoSha256: sha256Schema,
  tailFrameArtifactId: entityIdSchema,
  tailFrameSha256: sha256Schema,
  reviewDecisionId: entityIdSchema,
  reviewDecisionHash: sha256Schema,
  reviewedEvidenceArtifactId: entityIdSchema,
  reviewedEvidenceHash: sha256Schema,
  contractHash: sha256Schema,
  relationship: z.enum(["HARD_CONTINUITY", "SAME_SCENE_CUT"])
}).strict();

export const dreaminaVideoOperationSchema = z.enum([
  "text2video",
  "image2video",
  "frames2video",
  "multiframe2video",
  "multimodal2video"
]);

// The live Dreamina CLI help is the authority for model availability.
// Keep this schema open so future CLI model values remain readable; each new
// GenerationProfile is validated against the dynamic capability registry.
export const videoModelSchema = nonEmptyStringSchema;

export const generationProfileSchema = z
  .object({
    source: z.literal("DREAMINA_CAPABILITY_REGISTRY"),
    operation: dreaminaVideoOperationSchema,
    modelMode: z.enum(["EXPLICIT", "COMMAND_DEFAULT", "FIXED"]),
    requestedModelVersion: nonEmptyStringSchema.optional(),
    modelVersion: nonEmptyStringSchema.optional(),
    fixedModelLabel: nonEmptyStringSchema.optional(),
    aspectRatioMode: z.enum([
      "EXPLICIT",
      "INFER_FROM_FIRST_FRAME",
      "COMMAND_DEFAULT"
    ]),
    aspectRatio: videoAspectRatioSchema.optional(),
    videoResolution: videoResolutionSchema,
    durationMs: z.number().int().min(1000).max(120000),
    referenceAudioInputCount: z.number().int().nonnegative(),
    nativeAudioOutputRequested: z.boolean(),
    nativeAudioOutputSupported: z.boolean(),
    commandHelpSha256: sha256Schema,
    registryFingerprint: sha256Schema,
    capabilityCheckedAt: isoDateTimeSchema
  })
  .superRefine((profile, ctx) => {
    if (profile.modelMode === "EXPLICIT") {
      if (!profile.requestedModelVersion || !profile.modelVersion) {
        ctx.addIssue({
          code: "custom",
          path: ["modelVersion"],
          message: "EXPLICIT profile requires requested/effective modelVersion"
        });
      } else if (
        profile.requestedModelVersion.toLowerCase() !==
        profile.modelVersion.toLowerCase()
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["modelVersion"],
          message: "requested model must equal effective CLI model_version"
        });
      }
    }
    if (profile.modelMode === "FIXED" && !profile.fixedModelLabel) {
      ctx.addIssue({
        code: "custom",
        path: ["fixedModelLabel"],
        message: "FIXED profile requires fixedModelLabel"
      });
    }
    if (
      profile.aspectRatioMode === "EXPLICIT" &&
      (!profile.aspectRatio || profile.aspectRatio === "AUTO")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["aspectRatio"],
        message: "EXPLICIT aspect ratio requires a concrete ratio"
      });
    }
    if (
      profile.nativeAudioOutputRequested &&
      !profile.nativeAudioOutputSupported
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["nativeAudioOutputRequested"],
        message: "native audio output was requested but is not supported"
      });
    }
  });

export const v8RequestBindingSchema = z.object({
  runId: entityIdSchema, screenplayHash: sha256Schema, directorRecordHash: sha256Schema,
  promptRecordHash: sha256Schema, promptPackageHash: sha256Schema
}).strict();

export const compiledPromptSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  clipId: entityIdSchema,
  version: z.number().int().positive(),
  status: z.enum(["CURRENT", "STALE"]),
  provider: z.enum(["domestic-jimeng-cli","dreamina-canvas"]),
  model: videoModelSchema,
  productTruthRef: versionRefSchema,
  creativeBatchRef: versionRefSchema,
  selectedCreativeId: entityIdSchema,
  scriptRef: versionRefSchema,
  productionPlanRef: versionRefSchema,
  clipHash: sha256Schema,
  segmentHashes: z.record(z.string(), sha256Schema),
  compilerTemplateVersion: nonEmptyStringSchema,
  creativeReferenceSetRef: versionRefSchema.optional(),
  productionAssetSetRef: versionRefSchema.optional(),
  auditContractHash: sha256Schema.optional(),
  generationProfile: generationProfileSchema.optional(),
  v8Binding: v8RequestBindingSchema.optional(),
  audioPolicy: z.enum([
    "V2_STRICT",
    "V3_NATIVE_NO_BGM"
  ]).optional(),
  promptText: nonEmptyStringSchema,
  imageBindings: z.array(imageAssetBindingSchema).optional(),
  continuitySource: continuitySourceBindingSchema.optional(),
  inputAssetManifest: z.array(inputAssetManifestEntrySchema),
  factMapping: z.array(promptFactMappingSchema),
  segmentMapping: z.array(z.object({ segmentId: entityIdSchema, promptSection: nonEmptyStringSchema })),
  constraintMapping: z.array(z.object({ forbiddenChangeId: entityIdSchema, promptSection: nonEmptyStringSchema })),
  generationParams: z.object({
    durationMs: z.number().int().min(1000).max(120000),
    aspectRatio: videoAspectRatioSchema,
    generateAudio: z.boolean(),
    videoResolution: videoResolutionSchema.optional()
  }),
  compiledPromptHash: sha256Schema,
  createdAt: isoDateTimeSchema
});

export const providerIdentityStatusSchema = z.enum(["VERIFIED", "UNVERIFIED", "REJECTED"]);
export const providerIdentitySchema = z.object({
  id: entityIdSchema,
  provider: z.enum(["domestic-jimeng-cli","dreamina-canvas"]),
  officialSourceUrl: z.string().url().optional(),
  publisher: nonEmptyStringSchema.optional(),
  packageName: nonEmptyStringSchema.optional(),
  executablePath: nonEmptyStringSchema,
  executableSha256: sha256Schema,
  signatureInfo: nonEmptyStringSchema.optional(),
  cliVersion: nonEmptyStringSchema,
  rawVersionArtifactId: entityIdSchema,
  rawHelpArtifactId: entityIdSchema,
  officialLoginOrigins: z.array(z.string().url()),
  capabilityFingerprint: sha256Schema,
  verificationStatus: providerIdentityStatusSchema,
  verifiedAt: isoDateTimeSchema.optional()
}).superRefine((identity, ctx) => {
  if (identity.verificationStatus === "VERIFIED") {
    if (!identity.officialSourceUrl) ctx.addIssue({ code: "custom", path: ["officialSourceUrl"], message: "VERIFIED identity requires officialSourceUrl" });
    if (!identity.publisher && !identity.packageName) ctx.addIssue({ code: "custom", path: ["publisher"], message: "VERIFIED identity requires publisher or packageName" });
    if (!identity.verifiedAt) ctx.addIssue({ code: "custom", path: ["verifiedAt"], message: "VERIFIED identity requires verifiedAt" });
  }
});

export const providerCapabilitySchema = z.object({
  provider: z.enum(["domestic-jimeng-cli","dreamina-canvas"]),
  providerIdentityId: entityIdSchema.optional(),
  cliFound: z.boolean(),
  authenticated: z.union([z.boolean(), z.literal("UNKNOWN")]),
  supportedOperations: z.array(nonEmptyStringSchema),
  supportedModels: z.array(nonEmptyStringSchema),
  supportedDurationsMs: z.array(z.number().int().positive()).optional(),
  rawProbeArtifactId: entityIdSchema,
  capabilityFingerprint: sha256Schema,
  probedAt: isoDateTimeSchema
});

export const generationRequestSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  clipId: entityIdSchema,
  compiledPromptId: entityIdSchema,
  compiledPromptHash: sha256Schema,
  provider: z.enum(["domestic-jimeng-cli","dreamina-canvas"]),
  providerIdentityHash: sha256Schema,
  capabilityFingerprint: sha256Schema,
  canvasBinding: z.object({
    runId: entityIdSchema, projectId: z.string().uuid(), nodeId: nonEmptyStringSchema,
    submitId: z.string().uuid(), accountFingerprint: sha256Schema,
    generationHash: sha256Schema, sourceRequestHash: sha256Schema,
    quoteScopeHash: sha256Schema, canonicalModel: nonEmptyStringSchema
  }).strict().optional(),
  model: videoModelSchema,
  promptText: nonEmptyStringSchema,
  imageBindings: z.array(imageAssetBindingSchema).optional(),
  continuitySource: continuitySourceBindingSchema.optional(),
  assetManifest: z.array(inputAssetManifestEntrySchema),
  durationMs: z.number().int().min(1000).max(120000),
  aspectRatio: videoAspectRatioSchema,
  videoResolution: videoResolutionSchema.optional(),
  generateAudio: z.boolean(),
  v8Binding: v8RequestBindingSchema.optional(),
  audioPolicy: z.enum([
    "V2_STRICT",
    "V3_NATIVE_NO_BGM"
  ]).optional(),
  generationProfile: generationProfileSchema.optional(),
  dreaminaOperation: dreaminaVideoOperationSchema.optional(),
  agentTaskId: entityIdSchema.optional(),
  agentCapabilityHelpHash: sha256Schema.optional(),
  inputVersionRefs: z.array(versionRefSchema),
  createdAt: isoDateTimeSchema,
  requestHash: sha256Schema
});

export const costEstimateSchema = z.object({
  status: z.enum(["KNOWN", "UNKNOWN"]),
  estimatedCredits: z.number().nonnegative().optional(),
  estimatedCostText: nonEmptyStringSchema.optional(),
  observedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema.optional()
});

export const preflightReportSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  generationRequestId: entityIdSchema,
  requestHash: sha256Schema,
  status: gateStatusSchema,
  providerIdentityHash: sha256Schema,
  capabilityFingerprint: sha256Schema,
  clipCount: z.number().int().positive(),
  totalGeneratedMs: z.number().int().positive(),
  highRiskClipIds: z.array(entityIdSchema),
  costEstimate: costEstimateSchema,
  blockers: z.array(nonEmptyStringSchema),
  warnings: z.array(nonEmptyStringSchema),
  reportHash: sha256Schema,
  createdAt: isoDateTimeSchema,
  staleAt: isoDateTimeSchema.optional()
}).superRefine((report, ctx) => {
  if (report.status === "PASS" && report.blockers.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["blockers"],
      message: "PASS preflight cannot contain blockers"
    });
  }
  if (report.status === "BLOCKED" && report.blockers.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["blockers"],
      message: "BLOCKED preflight requires at least one blocker"
    });
  }
  if (report.status === "STALE" && !report.staleAt) {
    ctx.addIssue({
      code: "custom",
      path: ["staleAt"],
      message: "STALE preflight requires staleAt"
    });
  }
});

export const userApprovalSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  generationRequestId: entityIdSchema,
  requestHash: sha256Schema,
  preflightReportId: entityIdSchema,
  preflightHash: sha256Schema,
  providerIdentityHash: sha256Schema,
  capabilityFingerprint: sha256Schema,
  costSnapshot: costEstimateSchema,
  acceptedUnknownCostRisk: z.boolean(),
  acceptedDuplicateSubmissionRisk: z.boolean(),
  status: z.enum(["ACTIVE", "STALE", "REVOKED"]),
  approvedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema.optional(),
  approvalHash: sha256Schema
});

export const providerHandleSchema = z.object({
  externalTaskId: nonEmptyStringSchema.optional(),
  submitId: nonEmptyStringSchema.optional(),
  opaqueHandle: nonEmptyStringSchema.optional()
});

export const commandAttemptRecordSchema = z.object({
  id: entityIdSchema,
  operation: z.enum(["PROBE", "ACCOUNT", "ESTIMATE", "SUBMIT", "STATUS", "DOWNLOAD", "RECONCILE"]),
  attemptNumber: z.number().int().positive(),
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
  exitCode: z.number().int().optional(),
  signal: nonEmptyStringSchema.optional(),
  timedOut: z.boolean(),
  stdoutArtifactId: entityIdSchema.optional(),
  stderrArtifactId: entityIdSchema.optional(),
  redactionRulesVersion: nonEmptyStringSchema,
  parserVersion: nonEmptyStringSchema,
  errorCode: nonEmptyStringSchema.optional()
});

export const generationAttemptStatusSchema = z.enum([
  "CREATED",
  "SUBMITTING",
  "SUBMITTED",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "SUBMISSION_OUTCOME_UNKNOWN",
  "RECONCILING",
  "RECONCILED_SUCCEEDED",
  "RECONCILED_FAILED"
]);

export const generationAttemptSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  clipId: entityIdSchema,
  attemptNumber: z.number().int().positive(),
  generationRequestId: entityIdSchema,
  requestHash: sha256Schema,
  preflightReportId: entityIdSchema,
  userApprovalId: entityIdSchema,
  approvalHash: sha256Schema,
  submissionFingerprint: sha256Schema,
  status: generationAttemptStatusSchema,
  providerHandle: providerHandleSchema.optional(),
  commandAttempts: z.array(commandAttemptRecordSchema),
  outputArtifactId: entityIdSchema.optional(),
  createdAt: isoDateTimeSchema,
  submittedAt: isoDateTimeSchema.optional(),
  completedAt: isoDateTimeSchema.optional(),
  errorCode: nonEmptyStringSchema.optional(),
  errorMessage: nonEmptyStringSchema.optional()
});

export const workflowBlockerScopeSchema = z.enum(["PROJECT", "PREFLIGHT", "GENERATION_ATTEMPT", "PROVIDER"]);
export const workflowBlockerReasonSchema = z.enum([
  "DREAMINA_NOT_FOUND",
  "PROVIDER_IDENTITY_UNVERIFIED",
  "AUTHENTICATION_REQUIRED",
  "INTERACTIVE_LOGIN_REQUIRED",
  "ENTITLEMENT_INSUFFICIENT",
  "CAPABILITY_UNSUPPORTED",
  "COST_CONFIRMATION_REQUIRED",
  "SUBMISSION_RECONCILIATION_REQUIRED",
  "PROVIDER_CHANGED",
  "ARTIFACT_INTEGRITY_FAILURE",
  "ORPHAN_ARTIFACT_QUARANTINED",
  "OTHER"
]);

export const workflowBlockerSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  scope: workflowBlockerScopeSchema,
  relatedEntityId: entityIdSchema.optional(),
  reasonCode: workflowBlockerReasonSchema,
  message: nonEmptyStringSchema,
  requiredUserAction: nonEmptyStringSchema,
  resumeCheckpoint: nonEmptyStringSchema,
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.optional()
});

export const reviewDecisionSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  clipId: entityIdSchema,
  clipHash: sha256Schema,
  generationAttemptId: entityIdSchema.optional(),
  outputArtifactId: entityIdSchema.optional(),
  outputArtifactHash: sha256Schema.optional(),
  decision: z.enum(["ACCEPT", "REDO", "SKIP", "USE", "STALE"]),
  source: z.enum(["USER", "AI_VISUAL_GATE", "CONTINUITY_DEPENDENCY"]).optional(),
  visualAssessment: z.object({
    artifactId: entityIdSchema,
    artifactHash: sha256Schema,
    assessmentContentHash: sha256Schema,
    evaluatorVersion: nonEmptyStringSchema
  }).strict().optional(),
  note: nonEmptyStringSchema.optional(),
  decidedAt: isoDateTimeSchema
}).superRefine((value, ctx) => {
  const outputBound = value.decision === "ACCEPT" || value.decision === "REDO" || value.decision === "STALE";
  if (
    outputBound &&
    (!value.generationAttemptId || !value.outputArtifactId || !value.outputArtifactHash)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.decision} ReviewDecision requires generationAttemptId, outputArtifactId and outputArtifactHash`
    });
  }
  if ((value.decision === "STALE") !== (value.source === "CONTINUITY_DEPENDENCY")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only the continuity dependency engine may record STALE review decisions"
    });
  }
  if (value.source === "AI_VISUAL_GATE") {
    if (value.decision !== "ACCEPT" || !value.visualAssessment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "AI_VISUAL_GATE may only create an ACCEPT decision bound to a visual assessment"
      });
    }
  } else if (value.visualAssessment) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "User review cannot claim AI visual-assessment provenance"
    });
  }
});

export const timelineTrackSchema = z.object({
  id: entityIdSchema,
  kind: z.enum(["VIDEO", "AUDIO", "TEXT"]),
  order: z.number().int().nonnegative(),
  label: nonEmptyStringSchema,
  locked: z.boolean().default(false),
  muted: z.boolean().default(false)
});

export const timelineTransitionSchema = z
  .object({
    type: z.enum(["CUT", "CROSSFADE", "FADE"]),
    durationMs: z.number().int().nonnegative().max(2000)
  })
  .superRefine((value, ctx) => {
    if (value.type === "CUT" && value.durationMs !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationMs"],
        message: "CUT transition duration must be 0"
      });
    }
    if (value.type !== "CUT" && value.durationMs < 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationMs"],
        message: "Non-cut transition duration must be at least 100ms"
      });
    }
  });

export const timelineAudioKeyframeSchema = z.object({
  atMs: z.number().int().nonnegative(),
  volume: z.number().min(0).max(2)
});

export const timelineAudioSettingsSchema = z.object({
  muted: z.boolean().default(false),
  volume: z.number().min(0).max(2).default(1),
  keyframes: z.array(timelineAudioKeyframeSchema).default([])
});

export const timelineCaptionSchema = z
  .object({
    id: entityIdSchema,
    text: nonEmptyStringSchema,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    position: z.enum(["TOP", "CENTER", "BOTTOM"]).default("BOTTOM")
  })
  .superRefine((value, ctx) => {
    if (value.endMs <= value.startMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endMs"],
        message: "Caption endMs must be greater than startMs"
      });
    }
  });

export const timelineClipEditSchema = z
  .object({
    id: entityIdSchema,
    sourceClipId: entityIdSchema,
    sourceArtifactId: entityIdSchema,
    sourceArtifactHash: sha256Schema,
    sourceDurationMs: z.number().int().positive(),
    inMs: z.number().int().nonnegative(),
    outMs: z.number().int().positive(),
    trackId: entityIdSchema,
    order: z.number().int().nonnegative(),
    deleted: z.boolean().default(false),
    transition: timelineTransitionSchema.default({ type: "CUT", durationMs: 0 }),
    audio: timelineAudioSettingsSchema.default({
      muted: false,
      volume: 1,
      keyframes: []
    }),
    captions: z.array(timelineCaptionSchema).default([])
  })
  .superRefine((value, ctx) => {
    if (value.outMs <= value.inMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outMs"],
        message: "Timeline clip outMs must be greater than inMs"
      });
    }
    if (value.outMs > value.sourceDurationMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outMs"],
        message: "Timeline clip outMs exceeds source duration"
      });
    }
    const editedDurationMs = value.outMs - value.inMs;
    if (
      value.transition.type !== "CUT" &&
      value.transition.durationMs >= editedDurationMs
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transition", "durationMs"],
        message: "Transition must be shorter than edited clip duration"
      });
    }
    for (let index = 0; index < value.audio.keyframes.length; index += 1) {
      const keyframe = value.audio.keyframes[index]!;
      if (keyframe.atMs > editedDurationMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["audio", "keyframes", index, "atMs"],
          message: "Audio keyframe exceeds edited clip duration"
        });
      }
      if (
        index > 0 &&
        value.audio.keyframes[index - 1]!.atMs >= keyframe.atMs
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["audio", "keyframes", index, "atMs"],
          message: "Audio keyframes must be strictly increasing"
        });
      }
    }
  });

export const timelineAudioItemSchema = z
  .object({
    id: entityIdSchema,
    role: z.enum(["BGM", "NARRATION", "SFX"]).optional(),
    sourceArtifactId: entityIdSchema,
    sourceArtifactHash: sha256Schema,
    sourceDurationMs: z.number().int().positive(),
    inMs: z.number().int().nonnegative(),
    outMs: z.number().int().positive(),
    startMs: z.number().int().nonnegative(),
    trackId: entityIdSchema,
    order: z.number().int().nonnegative(),
    deleted: z.boolean().default(false),
    audio: timelineAudioSettingsSchema.default({
      muted: false,
      volume: 0.35,
      keyframes: []
    })
  })
  .superRefine((value, ctx) => {
    if (value.outMs <= value.inMs || value.outMs > value.sourceDurationMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outMs"],
        message: "Timeline audio trim must be within source duration"
      });
    }
  });

export const timelineTextItemSchema = z
  .object({
    id: entityIdSchema,
    kind: z.enum(["CAPTION", "CTA"]),
    text: nonEmptyStringSchema,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    trackId: entityIdSchema,
    order: z.number().int().nonnegative(),
    position: z.enum(["TOP", "CENTER", "BOTTOM"]).default("BOTTOM"),
    fontScale: z.number().min(0.5).max(3).default(1),
    deleted: z.boolean().default(false)
  })
  .superRefine((value, ctx) => {
    if (value.endMs <= value.startMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endMs"],
        message: "Timeline text endMs must be greater than startMs"
      });
    }
  });

export const timelineRepairMaskSchema = z
  .object({
    id: entityIdSchema,
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
    reason: nonEmptyStringSchema,
    deleted: z.boolean().default(false)
  })
  .superRefine((value, ctx) => {
    if (value.endMs <= value.startMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endMs"],
        message: "Timeline repair mask endMs must be greater than startMs"
      });
    }
    if (value.xRatio + value.widthRatio > 1.000001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["widthRatio"],
        message: "Timeline repair mask exceeds horizontal canvas bounds"
      });
    }
    if (value.yRatio + value.heightRatio > 1.000001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["heightRatio"],
        message: "Timeline repair mask exceeds vertical canvas bounds"
      });
    }
  });

export const timelineSchema = z
  .object({
    id: entityIdSchema,
    projectId: entityIdSchema,
    version: z.number().int().positive(),
    status: z.enum(["DRAFT", "CONFIRMED", "STALE"]),
    productionPlanHash: sha256Schema,
    tracks: z.array(timelineTrackSchema).min(1),
    clips: z.array(timelineClipEditSchema),
    audioItems: z.array(timelineAudioItemSchema).default([]),
    textItems: z.array(timelineTextItemSchema).default([]),
    repairMasks: z.array(timelineRepairMaskSchema).max(40).default([]),
    renderConfig: z.lazy(() => renderConfigSchema).optional(),
    autoEditOrigin: z.object({
      operationKey: sha256Schema,
      planArtifactId: entityIdSchema,
      planHash: sha256Schema,
      initialContentHash: sha256Schema
    }).optional(),
    contentHash: sha256Schema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    confirmedAt: isoDateTimeSchema.optional()
  })
  .superRefine((value, ctx) => {
    const trackIds = new Set(value.tracks.map((track) => track.id));
    const ordersByTrack = new Map<string, Set<number>>();
    for (let index = 0; index < value.clips.length; index += 1) {
      const clip = value.clips[index]!;
      if (!trackIds.has(clip.trackId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clips", index, "trackId"],
          message: "Timeline clip references unknown track"
        });
      }
      if (clip.deleted) continue;
      const orders = ordersByTrack.get(clip.trackId) ?? new Set<number>();
      if (orders.has(clip.order)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clips", index, "order"],
          message: "Timeline clip order must be unique within a track"
        });
      }
      orders.add(clip.order);
      ordersByTrack.set(clip.trackId, orders);
    }
    if (value.status === "CONFIRMED" && !value.confirmedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmedAt"],
        message: "CONFIRMED Timeline requires confirmedAt"
      });
    }
  });

export const renderConfigSchema = z.object({
  width: z.number().int().positive().default(720),
  height: z.number().int().positive().default(1280),
  fps: z.number().int().min(1).max(120).default(30),
  videoCodec: z.literal("libx264").default("libx264"),
  audioCodec: z.literal("aac").default("aac"),
  format: z.literal("mp4").default("mp4")
});

export const renderJobSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  timelineId: entityIdSchema,
  timelineHash: sha256Schema,
  status: z.enum(["QUEUED", "RENDERING", "SUCCEEDED", "FAILED"]),
  inputArtifactIds: z.array(entityIdSchema),
  inputArtifactHashes: z.array(sha256Schema),
  renderConfig: renderConfigSchema,
  outputArtifactId: entityIdSchema.optional(),
  outputArtifactHash: sha256Schema.optional(),
  errorCode: nonEmptyStringSchema.optional(),
  errorMessage: nonEmptyStringSchema.optional(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.optional(),
  completedAt: isoDateTimeSchema.optional()
});

export type Project = z.infer<typeof projectSchema>;
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;
export type AssetRef = z.infer<typeof assetRefSchema>;
export type ProductFact = z.infer<typeof productFactSchema>;
export type ForbiddenChange = z.infer<typeof forbiddenChangeSchema>;
export type ProductUsageRule = z.infer<typeof productUsageRuleSchema>;
export type ProductTruth = z.infer<typeof productTruthSchema>;
export type CreativeBatch = z.infer<typeof creativeBatchSchema>;
export type ScriptDraft = z.infer<typeof scriptDraftSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type ProductionPlan = z.infer<typeof productionPlanSchema>;
export type DirectorGenerationTarget = z.infer<typeof directorGenerationTargetSchema>;
export type VideoModel = z.infer<typeof videoModelSchema>;
export type GenerationProfile = z.infer<typeof generationProfileSchema>;
export type ReferenceVideoProfile = z.infer<
  typeof referenceVideoProfileSchema
>;
export type DreaminaVideoOperation = z.infer<
  typeof dreaminaVideoOperationSchema
>;
export type CompiledPrompt = z.infer<typeof compiledPromptSchema>;
export type ProviderIdentity = z.infer<typeof providerIdentitySchema>;
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type PreflightReport = z.infer<typeof preflightReportSchema>;
export type UserApproval = z.infer<typeof userApprovalSchema>;
export type CommandAttemptRecord = z.infer<typeof commandAttemptRecordSchema>;
export type GenerationAttempt = z.infer<typeof generationAttemptSchema>;
export type WorkflowBlocker = z.infer<typeof workflowBlockerSchema>;
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
export type TimelineTrack = z.infer<typeof timelineTrackSchema>;
export type TimelineTransition = z.infer<typeof timelineTransitionSchema>;
export type TimelineAudioSettings = z.infer<typeof timelineAudioSettingsSchema>;
export type TimelineCaption = z.infer<typeof timelineCaptionSchema>;
export type TimelineClipEdit = z.infer<typeof timelineClipEditSchema>;
export type TimelineAudioItem = z.infer<typeof timelineAudioItemSchema>;
export type TimelineTextItem = z.infer<typeof timelineTextItemSchema>;
export type TimelineRepairMask = z.infer<typeof timelineRepairMaskSchema>;
export type Timeline = z.infer<typeof timelineSchema>;
export type RenderConfig = z.infer<typeof renderConfigSchema>;
export type RenderJob = z.infer<typeof renderJobSchema>;

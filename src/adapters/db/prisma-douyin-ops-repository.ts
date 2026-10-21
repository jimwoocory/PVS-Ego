import {assertEvidenceScope} from "../../domain/douyin-feedback-validation.js";
import {commentObservationSchema,legacyCommentObservation,commentPageEvidenceSchema,type CommentPageEvidence} from "../../domain/douyin-comment-observation.js";
import {auditDouyinReadPage,observationsForDouyinPage,assertSavedMetricSnapshot} from "../../application/services/douyin-read-evidence-audit.js";
import type {DouyinOpsCommentPage} from "../../application/ports/douyin-ops-runtime.js";
import {randomUUID} from "node:crypto";
import {observationEvidenceSchema} from "../../domain/douyin-feedback-evidence.js";
import type { PrismaClient } from "@prisma/client";
import {assertOperationsWriteFence} from "./operations-write-fence.js";
import { DomainValidationError } from "../../domain/validation.js";
import {hashValue,sha256Text} from "../../domain/hashing.js";
import {metricKeys,type MetricAvailability} from "../../domain/douyin-observation.js";
import type { DouyinOpsRepository } from "../../application/ports/douyin-ops-repository.js";
import {
  douyinCommentClassificationSchema,
  douyinCommentSchema,
  douyinCreativeFeedbackSchema,
  douyinInsightSchema,
  douyinMetricSnapshotSchema,
  douyinReplyDraftRevisionSchema,
  douyinReplyDraftSchema,
  douyinReplyWriteIntentSchema,
  douyinWorkBindingSchema,
  type DouyinComment,
  type DouyinCommentClassification,
  type DouyinCreativeFeedback,
  type DouyinInsight,
  type DouyinMetricSnapshot,
  type DouyinReplyDraft,
  type DouyinReplyDraftRevision,
  type DouyinReplyWriteIntent,
  type DouyinWorkBinding
} from "../../domain/douyin-ops.js";

type BindingRow = {
  id: string;
  projectId: string;
  packageId: string | null;
  opsAccountUid: string | null;
  workDescription: string | null;
  publishReceiptId: string | null;
  awemeId: string | null;
  source: string | null;
  confidence: string;
  status: string;
  publishedAt: Date | null;
  boundAt: Date | null;
  externalUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SnapshotRow = {
  id: string;
  projectId: string;
  bindingId: string;
  awemeId: string;
  captureKey: string;
  capturedAt: Date;
  plays: number;
  likes: number;
  comments: number;
  shares: number;
  collects: number | null;
  durationMs: number | null;
  rawJson: string;
  contentHash: string;
  createdAt: Date;
};

type CommentRow = {
  id: string;
  projectId: string;
  bindingId: string;
  awemeId: string;
  cid: string;
  uid: string | null;
  secUid: string | null;
  nickname: string;
  text: string;
  diggCount: number;
  replyCount: number;
  platformCreatedAt: Date | null;
  parentCid: string | null;
  avatarUrl: string | null;
  sentiment: string | null;
  category: string | null;
  priority: string | null;
  syncedAt: Date;
  rawJson: string;
  contentHash: string;
  createdAt: Date;
  updatedAt: Date;
};

type ClassificationRow = {
  id: string;
  projectId: string;
  commentId: string;
  awemeId: string;
  cid: string;
  sourceContentHash: string;
  sentiment: string;
  category: string;
  priority: string;
  rationale: string | null;
  runtimeId: string;
  runtimeVersion: string;
  providerId: string | null;
  modelId: string | null;
  executionId: string | null;
  configVersion: number | null;
  classifiedAt: Date;
  createdAt: Date;
};

type ReplyDraftRow = {
  id: string;
  projectId: string;
  commentId: string;
  awemeId: string;
  cid: string;
  sourceContentHash: string;
  classificationId: string | null;
  productTruthHash: string;
  usedFactIdsJson: string;
  generatedText: string;
  currentText: string;
  strategy: string;
  status: string;
  revision: number;
  runtimeId: string;
  runtimeVersion: string;
  providerId: string | null;
  modelId: string | null;
  executionId: string | null;
  configVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
};

type ReplyDraftRevisionRow = {
  id: string;
  projectId: string;
  draftId: string;
  commentId: string;
  action: string;
  beforeText: string;
  afterText: string;
  beforeStatus: string;
  afterStatus: string;
  expectedRevision: number;
  resultingRevision: number;
  createdAt: Date;
};

type InsightRow = {
  id: string;
  projectId: string;
  bindingId: string;
  awemeId: string;
  productTruthHash: string;
  metricSnapshotIdsJson: string;
  commentIdsJson: string;
  evidenceHash: string;
  summary: string;
  strengthsJson: string;
  weaknessesJson: string;
  audienceQuestionsJson: string;
  nextCreativeActionsJson: string;
  runtimeId: string;
  runtimeVersion: string;
  providerId: string | null;
  modelId: string | null;
  executionId: string | null;
  configVersion: number | null;
  createdAt: Date;
};

type CreativeFeedbackRow = {
  id: string;
  projectId: string;
  insightId: string;
  actionIndex: number;
  actionHash: string;
  actionText: string;
  evidenceRefsJson: string;
  active: boolean;
  confirmedAt: Date;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ReplyWriteIntentRow = {
  id: string;
  projectId: string;
  draftId: string;
  commentId: string;
  awemeId: string;
  cid: string;
  textHash: string;
  operationFingerprint: string;
  draftRevision: number;
  status: string;
  externalReplyCid: string | null;
  accountPublishId: string;
  accountOpsId: string;
  confirmedAt: Date;
  completedAt: Date | null;
  message: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function bindingToDomain(
  row: BindingRow
): DouyinWorkBinding {
  return douyinWorkBindingSchema.parse({
    id: row.id,
    projectId: row.projectId,
    ...(row.packageId ? { packageId: row.packageId } : {}),
    ...(row.opsAccountUid ? { opsAccountUid: row.opsAccountUid } : {}),
    ...(row.workDescription !== null ? { workDescription: row.workDescription } : {}),
    ...(row.publishReceiptId
      ? { publishReceiptId: row.publishReceiptId }
      : {}),
    ...(row.awemeId ? { awemeId: row.awemeId } : {}),
    ...(row.source ? { source: row.source } : {}),
    confidence: row.confidence,
    status: row.status,
    ...(row.publishedAt
      ? { publishedAt: row.publishedAt.toISOString() }
      : {}),
    ...(row.boundAt
      ? { boundAt: row.boundAt.toISOString() }
      : {}),
    ...(row.externalUrl
      ? { externalUrl: row.externalUrl }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  });
}

function snapshotToDomain(
  row: SnapshotRow
): DouyinMetricSnapshot {
  let reported:MetricAvailability={};
  try{reported=JSON.parse(row.rawJson).metricAvailability??{};}catch{/* Preserve legacy raw bytes; missing provenance remains unverified. */}
  const metricAvailability:MetricAvailability={},metrics:Partial<Record<typeof metricKeys[number],number>>={};
  for(const key of metricKeys){const value=row[key]??undefined,state=reported[key]??(value===undefined?"NOT_PROVIDED":value===0?"LEGACY_UNVERIFIED":"OBSERVED");metricAvailability[key]=state;if(state==="OBSERVED"&&value!==undefined)metrics[key]=value;}
  const value = douyinMetricSnapshotSchema.parse({
    id: row.id,
    projectId: row.projectId,
    bindingId: row.bindingId,
    awemeId: row.awemeId,
    captureKey: row.captureKey,
    capturedAt: row.capturedAt.toISOString(),
    ...metrics,metricAvailability,
    ...(row.durationMs !== null
      ? { durationMs: row.durationMs }
      : {}),
    rawJson: row.rawJson,
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString()
  });
  assertSavedMetricSnapshot(value,{projectId:row.projectId,bindingId:row.bindingId,awemeId:row.awemeId});
  return value;
}

/** All partial reads must honor the original version row, including list reads. */
function partialSnapshotToDomain(row:{id:string;projectId:string;entityType:string;entityKey:string;version:number;status:string;contentHash:string;dataJson:string}):DouyinMetricSnapshot{
  const value=douyinMetricSnapshotSchema.parse(JSON.parse(row.dataJson));
  if(row.entityType!=="DouyinMetricPartialSnapshot"||row.version!==1||row.status!=="PARTIAL"||value.id!==row.id||value.projectId!==row.projectId||value.captureKey!==row.entityKey||value.contentHash!==row.contentHash)throw new DomainValidationError("部分指标观察记录与原版本行不一致，停止复用");
  assertSavedMetricSnapshot(value,{projectId:row.projectId,bindingId:value.bindingId,awemeId:value.awemeId});
  return value;
}

function commentToDomain(
  row: CommentRow
): DouyinComment {
  let observation=legacyCommentObservation({awemeId:row.awemeId,cid:row.cid,...(row.parentCid?{parentCid:row.parentCid}:{})});
  try{const raw=JSON.parse(row.rawJson);if(raw.observation)observation=commentObservationSchema.parse(raw.observation);}catch{/* Preserve the original row and expose unknown instead of numeric placeholders. */}
  if(observation.awemeId!==row.awemeId||observation.cid!==row.cid||observation.parentCid!==(row.parentCid??undefined))throw new DomainValidationError("评论审计证据与保存的归属不一致");
  for(const key of ["diggCount","replyCount"] as const)if(observation.counts[key].status==="OBSERVED"&&observation.counts[key].value!==row[key])throw new DomainValidationError("评论计数与来源审计不一致");
  return douyinCommentSchema.parse({
    id: row.id,
    projectId: row.projectId,
    bindingId: row.bindingId,
    awemeId: row.awemeId,
    cid: row.cid,
    ...(row.uid ? { uid: row.uid } : {}),
    ...(row.secUid ? { secUid: row.secUid } : {}),
    nickname: row.nickname,
    text: row.text,
    diggCount: observation.counts.diggCount.value,
    replyCount: observation.counts.replyCount.value,
    observation,
    ...(() => {try{const coverage=JSON.parse(row.rawJson).sourceCoverage;return coverage?{sourceCoverage:coverage}:{};}catch{return {};}})(),
    ...(row.platformCreatedAt
      ? { platformCreatedAt: row.platformCreatedAt.toISOString() }
      : {}),
    ...(row.parentCid ? { parentCid: row.parentCid } : {}),
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
    ...(row.sentiment ? { sentiment: row.sentiment } : {}),
    ...(row.category ? { category: row.category } : {}),
    ...(row.priority ? { priority: row.priority } : {}),
    syncedAt: row.syncedAt.toISOString(),
    rawJson: row.rawJson,
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  });
}

function classificationToDomain(
  row: ClassificationRow
): DouyinCommentClassification {
  return douyinCommentClassificationSchema.parse({
    id: row.id,
    projectId: row.projectId,
    commentId: row.commentId,
    awemeId: row.awemeId,
    cid: row.cid,
    sourceContentHash: row.sourceContentHash,
    sentiment: row.sentiment,
    category: row.category,
    priority: row.priority,
    ...(row.rationale ? { rationale: row.rationale } : {}),
    runtimeId: row.runtimeId,
    runtimeVersion: row.runtimeVersion,
    ...(row.providerId ? { providerId: row.providerId } : {}),
    ...(row.modelId ? { modelId: row.modelId } : {}),
    ...(row.executionId ? { executionId: row.executionId } : {}),
    ...(row.configVersion !== null
      ? { configVersion: row.configVersion }
      : {}),
    classifiedAt: row.classifiedAt.toISOString(),
    createdAt: row.createdAt.toISOString()
  });
}

function replyDraftToDomain(
  row: ReplyDraftRow
): DouyinReplyDraft {
  return douyinReplyDraftSchema.parse({
    id: row.id,
    projectId: row.projectId,
    commentId: row.commentId,
    awemeId: row.awemeId,
    cid: row.cid,
    sourceContentHash: row.sourceContentHash,
    ...(row.classificationId
      ? { classificationId: row.classificationId }
      : {}),
    productTruthHash: row.productTruthHash,
    usedFactIds: JSON.parse(row.usedFactIdsJson) as string[],
    generatedText: row.generatedText,
    currentText: row.currentText,
    strategy: row.strategy,
    status: row.status,
    revision: row.revision,
    runtimeId: row.runtimeId,
    runtimeVersion: row.runtimeVersion,
    ...(row.providerId ? { providerId: row.providerId } : {}),
    ...(row.modelId ? { modelId: row.modelId } : {}),
    ...(row.executionId ? { executionId: row.executionId } : {}),
    ...(row.configVersion !== null
      ? { configVersion: row.configVersion }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  });
}

function replyDraftRevisionToDomain(
  row: ReplyDraftRevisionRow
): DouyinReplyDraftRevision {
  return douyinReplyDraftRevisionSchema.parse({
    id: row.id,
    projectId: row.projectId,
    draftId: row.draftId,
    commentId: row.commentId,
    action: row.action,
    beforeText: row.beforeText,
    afterText: row.afterText,
    beforeStatus: row.beforeStatus,
    afterStatus: row.afterStatus,
    expectedRevision: row.expectedRevision,
    resultingRevision: row.resultingRevision,
    createdAt: row.createdAt.toISOString()
  });
}

function insightToDomain(
  row: InsightRow
): DouyinInsight {
  return douyinInsightSchema.parse({
    id: row.id,
    projectId: row.projectId,
    bindingId: row.bindingId,
    awemeId: row.awemeId,
    productTruthHash: row.productTruthHash,
    metricSnapshotIds:
      JSON.parse(row.metricSnapshotIdsJson) as string[],
    commentIds:
      JSON.parse(row.commentIdsJson) as string[],
    evidenceHash: row.evidenceHash,
    summary: row.summary,
    strengths: JSON.parse(row.strengthsJson),
    weaknesses: JSON.parse(row.weaknessesJson),
    audienceQuestions:
      JSON.parse(row.audienceQuestionsJson),
    nextCreativeActions:
      JSON.parse(row.nextCreativeActionsJson),
    runtimeId: row.runtimeId,
    runtimeVersion: row.runtimeVersion,
    ...(row.providerId ? { providerId: row.providerId } : {}),
    ...(row.modelId ? { modelId: row.modelId } : {}),
    ...(row.executionId ? { executionId: row.executionId } : {}),
    ...(row.configVersion !== null
      ? { configVersion: row.configVersion }
      : {}),
    createdAt: row.createdAt.toISOString()
  });
}

function creativeFeedbackToDomain(
  row: CreativeFeedbackRow
): DouyinCreativeFeedback {
  return douyinCreativeFeedbackSchema.parse({
    id: row.id,
    projectId: row.projectId,
    insightId: row.insightId,
    actionIndex: row.actionIndex,
    actionHash: row.actionHash,
    actionText: row.actionText,
    evidenceRefs:
      JSON.parse(row.evidenceRefsJson) as string[],
    active: row.active,
    confirmedAt: row.confirmedAt.toISOString(),
    ...(row.deactivatedAt
      ? { deactivatedAt: row.deactivatedAt.toISOString() }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  });
}

function replyWriteIntentToDomain(
  row: ReplyWriteIntentRow
): DouyinReplyWriteIntent {
  return douyinReplyWriteIntentSchema.parse({
    id: row.id,
    projectId: row.projectId,
    draftId: row.draftId,
    commentId: row.commentId,
    awemeId: row.awemeId,
    cid: row.cid,
    textHash: row.textHash,
    operationFingerprint: row.operationFingerprint,
    draftRevision: row.draftRevision,
    status: row.status,
    ...(row.externalReplyCid
      ? { externalReplyCid: row.externalReplyCid }
      : {}),
    accountPublishId: row.accountPublishId,
    accountOpsId: row.accountOpsId,
    confirmedAt: row.confirmedAt.toISOString(),
    ...(row.completedAt
      ? { completedAt: row.completedAt.toISOString() }
      : {}),
    ...(row.message ? { message: row.message } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  });
}

export class PrismaDouyinOpsRepository
  implements DouyinOpsRepository
{
  constructor(private readonly db: PrismaClient) {}

  async upsertWorkBinding(
    input: DouyinWorkBinding
  ): Promise<DouyinWorkBinding> {
    const value = douyinWorkBindingSchema.parse(input);
    const row = await this.db.douyinWorkBindingRecord.upsert({
      where: value.packageId ? { packageId: value.packageId } : { id: value.id },
      create: {
        id: value.id,
        projectId: value.projectId,
        packageId: value.packageId ?? null,
        opsAccountUid: value.opsAccountUid ?? null,
        workDescription: value.workDescription ?? null,
        publishReceiptId: value.publishReceiptId ?? null,
        awemeId: value.awemeId ?? null,
        source: value.source ?? null,
        confidence: value.confidence,
        status: value.status,
        publishedAt: value.publishedAt
          ? new Date(value.publishedAt)
          : null,
        boundAt: value.boundAt
          ? new Date(value.boundAt)
          : null,
        externalUrl: value.externalUrl ?? null,
        createdAt: new Date(value.createdAt),
        updatedAt: new Date(value.updatedAt)
      },
      update: {
        projectId: value.projectId,
        opsAccountUid: value.opsAccountUid ?? null,
        workDescription: value.workDescription ?? null,
        publishReceiptId: value.publishReceiptId ?? null,
        awemeId: value.awemeId ?? null,
        source: value.source ?? null,
        confidence: value.confidence,
        status: value.status,
        publishedAt: value.publishedAt
          ? new Date(value.publishedAt)
          : null,
        boundAt: value.boundAt
          ? new Date(value.boundAt)
          : null,
        externalUrl: value.externalUrl ?? null,
        updatedAt: new Date(value.updatedAt)
      }
    });
    return bindingToDomain(row);
  }

  async findWorkBindingById(
    id: string
  ): Promise<DouyinWorkBinding | null> {
    const row =
      await this.db.douyinWorkBindingRecord.findUnique({
        where: { id }
      });
    return row ? bindingToDomain(row) : null;
  }

  async findWorkBindingByPackage(
    packageId: string
  ): Promise<DouyinWorkBinding | null> {
    const row =
      await this.db.douyinWorkBindingRecord.findUnique({
        where: { packageId }
      });
    return row ? bindingToDomain(row) : null;
  }

  async latestWorkBinding(
    projectId: string,
    options?: { preferBound?: boolean }
  ): Promise<DouyinWorkBinding | null> {
    if (options?.preferBound) {
      const bound = await this.db.douyinWorkBindingRecord.findFirst({
        where: { projectId, status: "BOUND", awemeId: { not: null } },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }]
      });
      if (bound) return bindingToDomain(bound);
    }
    const row =
      await this.db.douyinWorkBindingRecord.findFirst({
        where: { projectId },
        orderBy: { createdAt: "desc" }
      });
    return row ? bindingToDomain(row) : null;
  }

  async createMetricSnapshot(
    input: DouyinMetricSnapshot,
    fence?:import("../../application/ports/operations-write-fence.js").OperationsWriteFence
  ): Promise<DouyinMetricSnapshot> {
    if(fence){
      if(fence.projectId!==input.projectId)throw new DomainValidationError("运营保存权限不属于当前项目");
      return this.db.$transaction(async tx=>{await assertOperationsWriteFence(tx,fence);return new PrismaDouyinOpsRepository(tx as PrismaClient).createMetricSnapshot(input);});
    }
    const value = douyinMetricSnapshotSchema.parse(input);
    const prior=await this.findMetricSnapshotByCaptureKey(value.projectId,value.captureKey);
    if(prior){if(prior.bindingId!==value.bindingId||prior.awemeId!==value.awemeId||prior.contentHash!==value.contentHash)throw new DomainValidationError("同一指标采集标识不能覆盖不同作品或内容");return prior;}
    if(value.plays===undefined||value.likes===undefined||value.comments===undefined||value.shares===undefined){
      // Existing numeric SQL columns cannot encode unknown. Preserve partial observations in the existing version store, never insert fake zeroes.
      const row=await this.db.versionedEntity.upsert({where:{projectId_entityType_entityKey_version:{projectId:value.projectId,entityType:"DouyinMetricPartialSnapshot",entityKey:value.captureKey,version:1}},create:{id:value.id,projectId:value.projectId,entityType:"DouyinMetricPartialSnapshot",entityKey:value.captureKey,version:1,status:"PARTIAL",contentHash:value.contentHash,dataJson:JSON.stringify(value)},update:{}});
      const stored=partialSnapshotToDomain(row);
      if(stored.contentHash!==value.contentHash||stored.bindingId!==value.bindingId||stored.awemeId!==value.awemeId)throw new DomainValidationError("同一指标采集标识不能覆盖不同作品或内容");return stored;
    }
    const row = await this.db.douyinMetricSnapshotRecord.upsert({
      where: {
        projectId_captureKey: {
          projectId: value.projectId,
          captureKey: value.captureKey
        }
      },
      create: {
        id: value.id,
        projectId: value.projectId,
        bindingId: value.bindingId,
        awemeId: value.awemeId,
        captureKey: value.captureKey,
        capturedAt: new Date(value.capturedAt),
        plays: value.plays,
        likes: value.likes,
        comments: value.comments,
        shares: value.shares,
        collects: value.collects ?? null,
        durationMs: value.durationMs ?? null,
        rawJson: value.rawJson,
        contentHash: value.contentHash,
        createdAt: new Date(value.createdAt)
      },
      update: {}
    });

    if (row.contentHash !== value.contentHash) {
      throw new Error(
        "Douyin metric captureKey was reused with different content"
      );
    }
    return snapshotToDomain(row);
  }

  async findMetricSnapshotByCaptureKey(
    projectId: string,
    captureKey: string
  ): Promise<DouyinMetricSnapshot | null> {
    const row =
      await this.db.douyinMetricSnapshotRecord.findUnique({
        where: {
          projectId_captureKey: {
            projectId,
            captureKey
          }
        }
      });
    if(row)return snapshotToDomain(row);
    const partial=await this.db.versionedEntity.findFirst({where:{projectId,entityType:"DouyinMetricPartialSnapshot",entityKey:captureKey,version:1}});
    if(!partial)return null;
    const value=partialSnapshotToDomain(partial);
    if(value.projectId!==projectId||value.captureKey!==captureKey)throw new DomainValidationError("部分指标观察记录校验失败");return value;
  }

  async listMetricSnapshots(input: {
    projectId: string;
    awemeId?: string;
    limit?: number;
  }): Promise<DouyinMetricSnapshot[]> {
    const limit =
      input.limit === undefined
        ? undefined
        : Math.max(1, Math.min(500, Math.trunc(input.limit)));
    const rows =
      await this.db.douyinMetricSnapshotRecord.findMany({
        where: {
          projectId: input.projectId,
          ...(input.awemeId
            ? { awemeId: input.awemeId }
            : {})
        },
        orderBy: { capturedAt: limit ? "desc" : "asc" },
        ...(limit ? { take: limit } : {})
      });
    const partials=await this.db.versionedEntity.findMany({where:{projectId:input.projectId,entityType:"DouyinMetricPartialSnapshot",...(input.awemeId?{dataJson:{contains:'"awemeId":'+JSON.stringify(input.awemeId)}}:{})},orderBy:{createdAt:"desc"},...(limit?{take:500}:{})});
    const domain=[...rows.map(snapshotToDomain),...partials.map(partialSnapshotToDomain).filter(value=>!input.awemeId||value.awemeId===input.awemeId)].sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt));
    return limit?domain.slice(-limit):domain;
  }

  async upsertComments(
    input: DouyinComment[],pageEvidence?:CommentPageEvidence,fence?:import("../../application/ports/operations-write-fence.js").OperationsWriteFence
  ): Promise<DouyinComment[]> {
    const values = input.map((item) =>
      douyinCommentSchema.parse(item)
    );
    if(!pageEvidence&&values.some(v=>v.observation?.source==="RAW_PAGE_COMPARISON"))throw new DomainValidationError("带原始来源的评论必须与原始页一起保存");
    return this.db.$transaction(async tx => {
    if(fence){if(values.some(v=>v.projectId!==fence.projectId)||pageEvidence&&pageEvidence.projectId!==fence.projectId)throw new DomainValidationError("运营评论保存权限不属于当前项目");await assertOperationsWriteFence(tx,fence);}
    if(pageEvidence){
      const evidence=commentPageEvidenceSchema.parse(pageEvidence),audit=auditDouyinReadPage({...evidence,normalized:evidence.normalized as DouyinOpsCommentPage}),key="douyin-comment-page:"+hashValue(evidence);
      if(!audit.accepted||values.some(v=>v.projectId!==evidence.projectId||v.bindingId!==evidence.bindingId||v.awemeId!==evidence.awemeId||(v.parentCid??null)!==evidence.parentCid||v.observation?.pageEvidenceId!==key||v.observation.pageHash!==audit.rawHash||!audit.comments.some(c=>c.cid===v.cid)))throw new DomainValidationError("评论原始页证据与本次保存范围不一致");
      const derived=observationsForDouyinPage({...evidence.normalized as DouyinOpsCommentPage,readEvidence:{version:"douyin-read-page-v1",kind:evidence.kind,awemeId:evidence.awemeId,parentCid:evidence.parentCid,requestCursor:evidence.requestCursor,count:evidence.count,observedAt:evidence.observedAt,raw:evidence.raw}},{awemeId:evidence.awemeId,parentCid:evidence.parentCid??undefined,requestCursor:evidence.requestCursor,count:evidence.count});
      for(const v of values){const expected=derived.observations.get(v.cid);if(!expected||hashValue({...expected,pageEvidenceId:key})!==hashValue(v.observation)||v.diggCount!==expected.counts.diggCount.value||v.replyCount!==expected.counts.replyCount.value)throw new DomainValidationError("评论计数或回复关系审计不能脱离原始页重写");}
      const binding=await tx.douyinWorkBindingRecord.findUnique({where:{id:evidence.bindingId}});
      if(!binding||binding.projectId!==evidence.projectId||binding.awemeId!==evidence.awemeId||binding.status!=="BOUND")throw new DomainValidationError("保存原始页前作品绑定已改变");
      const saved=await tx.versionedEntity.upsert({where:{projectId_entityType_entityKey_version:{projectId:evidence.projectId,entityType:"DouyinCommentPageEvidence",entityKey:key,version:1}},create:{id:key,projectId:evidence.projectId,entityType:"DouyinCommentPageEvidence",entityKey:key,version:1,status:"FROZEN",contentHash:hashValue(evidence),dataJson:JSON.stringify(evidence)},update:{}});
      if(saved.contentHash!==hashValue(evidence)||hashValue(JSON.parse(saved.dataJson))!==saved.contentHash)throw new DomainValidationError("原始评论页归档哈希不一致");
    }
    const output: DouyinComment[] = [];
    for (const value of values) {
      const previous=await tx.douyinCommentRecord.findUnique({where:{awemeId_cid:{awemeId:value.awemeId,cid:value.cid}}});
      if(previous&&Date.parse(value.syncedAt)<previous.syncedAt.getTime()){
        if(previous.projectId!==value.projectId||previous.bindingId!==value.bindingId||(previous.parentCid??undefined)!==value.parentCid)throw new DomainValidationError("旧采集不能转移评论归属或父子关系");
        output.push(commentToDomain(previous));continue;
      }
      const row = await tx.douyinCommentRecord.upsert({
        where: {
          awemeId_cid: {
            awemeId: value.awemeId,
            cid: value.cid
          }
        },
        create: {
          id: value.id,
          projectId: value.projectId,
          bindingId: value.bindingId,
          awemeId: value.awemeId,
          cid: value.cid,
          uid: value.uid ?? null,
          secUid: value.secUid ?? null,
          nickname: value.nickname,
          text: value.text,
          diggCount: value.diggCount??0,
          replyCount: value.replyCount??0,
          platformCreatedAt: value.platformCreatedAt
            ? new Date(value.platformCreatedAt)
            : null,
          parentCid: value.parentCid ?? null,
          avatarUrl: value.avatarUrl ?? null,
          sentiment: value.sentiment ?? null,
          category: value.category ?? null,
          priority: value.priority ?? null,
          syncedAt: new Date(value.syncedAt),
          rawJson: value.rawJson,
          contentHash: value.contentHash,
          createdAt: new Date(value.createdAt),
          updatedAt: new Date(value.updatedAt)
        },
        update: {
          uid: value.uid ?? null,
          secUid: value.secUid ?? null,
          nickname: value.nickname,
          text: value.text,
          diggCount: value.diggCount??0,
          replyCount: value.replyCount??0,
          platformCreatedAt: value.platformCreatedAt
            ? new Date(value.platformCreatedAt)
            : null,
          avatarUrl: value.avatarUrl ?? null,
          syncedAt: new Date(value.syncedAt),
          rawJson: value.rawJson,
          contentHash: value.contentHash,
          updatedAt: new Date(value.updatedAt)
        }
      });
      // Never transfer ownership through an upsert. The write acquires the transaction lock before checking,
      // so competing projects cannot both observe a missing row and overwrite each other's association.
      if (row.projectId !== value.projectId || row.bindingId !== value.bindingId ||
          (row.parentCid ?? undefined) !== value.parentCid) {
        throw new DomainValidationError("评论已属于其他项目、作品绑定或父评论，整批采集已回滚");
      }
      output.push(commentToDomain(row));
    }
    return output;
    });
  }

  async findCommentPageEvidence(projectId:string,id:string):Promise<CommentPageEvidence|null>{
    const row=await this.db.versionedEntity.findFirst({where:{projectId,entityType:"DouyinCommentPageEvidence",entityKey:id,version:1}});if(!row)return null;
    const value=commentPageEvidenceSchema.parse(JSON.parse(row.dataJson));if(value.projectId!==projectId||hashValue(value)!==row.contentHash||id!=="douyin-comment-page:"+row.contentHash)throw new DomainValidationError("原始评论页证据范围或哈希不一致");return value;
  }

  async listComments(input: {
    projectId: string;
    awemeId?: string;
    parentCid?: string | null;
    limit?: number;
    offset?: number;
    order?: "asc" | "desc";
  }): Promise<DouyinComment[]> {
    const limit =
      input.limit === undefined
        ? undefined
        : Math.max(1, Math.min(1000, Math.trunc(input.limit)));
    const rows = await this.db.douyinCommentRecord.findMany({
      where: {
        projectId: input.projectId,
        ...(input.awemeId ? { awemeId: input.awemeId } : {}),
        ...(input.parentCid === null
          ? { parentCid: null }
          : input.parentCid
            ? { parentCid: input.parentCid }
            : {})
      },
      orderBy: [
        { platformCreatedAt: input.order ?? "asc" },
        { createdAt: input.order ?? "asc" },
        { id: input.order ?? "asc" }
      ],
      ...(input.offset ? { skip: Math.max(0, Math.trunc(input.offset)) } : {}),
      ...(limit ? { take: limit } : {})
    });
    return rows.map(commentToDomain);
  }

  async findComment(input: {
    awemeId: string;
    cid: string;
  }): Promise<DouyinComment | null> {
    const row = await this.db.douyinCommentRecord.findUnique({
      where: {
        awemeId_cid: {
          awemeId: input.awemeId,
          cid: input.cid
        }
      }
    });
    return row ? commentToDomain(row) : null;
  }

  async findCommentsByCids(
    projectId: string,
    cids: string[]
  ): Promise<DouyinComment[]> {
    if (!cids.length) return [];
    const rows = await this.db.douyinCommentRecord.findMany({
      where: {
        projectId,
        cid: { in: [...new Set(cids)] }
      }
    });
    return rows.map(commentToDomain);
  }

  async latestCommentClassification(
    commentId: string
  ): Promise<DouyinCommentClassification | null> {
    const row =
      await this.db.douyinCommentClassificationRecord.findFirst({
        where: { commentId },
        orderBy: [
          { classifiedAt: "desc" },
          { createdAt: "desc" }
        ]
      });
    return row ? classificationToDomain(row) : null;
  }

  async saveCommentClassifications(input: {
    updates: Array<{
      commentId: string;
      sentiment: DouyinCommentClassification["sentiment"];
      category: DouyinCommentClassification["category"];
      priority: DouyinCommentClassification["priority"];
    }>;
    records: DouyinCommentClassification[];
  }): Promise<DouyinComment[]> {
    const records = input.records.map((item) =>
      douyinCommentClassificationSchema.parse(item)
    );
    const updates = new Map(
      input.updates.map((item) => [item.commentId, item])
    );

    if (
      updates.size !== input.updates.length ||
      records.length !== input.updates.length
    ) {
      throw new Error(
        "Douyin comment classification batch is inconsistent"
      );
    }

    const rows = await this.db.$transaction(async (tx) => {
      const output: CommentRow[] = [];
      for (const record of records) {
        const update = updates.get(record.commentId);
        if (!update) {
          throw new Error(
            "Missing current-comment update for classification"
          );
        }
        const row = await tx.douyinCommentRecord.update({
          where: { id: record.commentId },
          data: {
            sentiment: update.sentiment,
            category: update.category,
            priority: update.priority
          }
        });
        await tx.douyinCommentClassificationRecord.create({
          data: {
            id: record.id,
            projectId: record.projectId,
            commentId: record.commentId,
            awemeId: record.awemeId,
            cid: record.cid,
            sourceContentHash: record.sourceContentHash,
            sentiment: record.sentiment,
            category: record.category,
            priority: record.priority,
            rationale: record.rationale ?? null,
            runtimeId: record.runtimeId,
            runtimeVersion: record.runtimeVersion,
            providerId: record.providerId ?? null,
            modelId: record.modelId ?? null,
            executionId: record.executionId ?? null,
            configVersion: record.configVersion ?? null,
            classifiedAt: new Date(record.classifiedAt),
            createdAt: new Date(record.createdAt)
          }
        });
        output.push(row);
      }
      return output;
    });

    return rows.map(commentToDomain);
  }

  async listCommentClassifications(
    commentId: string
  ): Promise<DouyinCommentClassification[]> {
    const rows =
      await this.db.douyinCommentClassificationRecord.findMany({
        where: { commentId },
        orderBy: [
          { classifiedAt: "asc" },
          { createdAt: "asc" }
        ]
      });
    return rows.map(classificationToDomain);
  }

  async createReplyDraft(
    input: DouyinReplyDraft
  ): Promise<DouyinReplyDraft> {
    const value = douyinReplyDraftSchema.parse(input);
    const row = await this.db.douyinReplyDraftRecord.create({
      data: {
        id: value.id,
        projectId: value.projectId,
        commentId: value.commentId,
        awemeId: value.awemeId,
        cid: value.cid,
        sourceContentHash: value.sourceContentHash,
        classificationId: value.classificationId ?? null,
        productTruthHash: value.productTruthHash,
        usedFactIdsJson: JSON.stringify(value.usedFactIds),
        generatedText: value.generatedText,
        currentText: value.currentText,
        strategy: value.strategy,
        status: value.status,
        revision: value.revision,
        runtimeId: value.runtimeId,
        runtimeVersion: value.runtimeVersion,
        providerId: value.providerId ?? null,
        modelId: value.modelId ?? null,
        executionId: value.executionId ?? null,
        configVersion: value.configVersion ?? null,
        createdAt: new Date(value.createdAt),
        updatedAt: new Date(value.updatedAt)
      }
    });
    return replyDraftToDomain(row);
  }

  async latestReplyDraft(
    commentId: string
  ): Promise<DouyinReplyDraft | null> {
    const row =
      await this.db.douyinReplyDraftRecord.findFirst({
        where: { commentId },
        orderBy: [
          { createdAt: "desc" },
          { updatedAt: "desc" }
        ]
      });
    return row ? replyDraftToDomain(row) : null;
  }

  async listLatestReplyDrafts(input: {
    projectId: string;
    awemeId?: string;
  }): Promise<DouyinReplyDraft[]> {
    const rows =
      await this.db.douyinReplyDraftRecord.findMany({
        where: {
          projectId: input.projectId,
          ...(input.awemeId
            ? { awemeId: input.awemeId }
            : {})
        },
        orderBy: [
          { createdAt: "asc" },
          { updatedAt: "asc" }
        ]
      });
    const latest = new Map<string, ReplyDraftRow>();
    for (const row of rows) {
      latest.set(row.commentId, row);
    }
    return [...latest.values()].map(replyDraftToDomain);
  }

  async listReplyDrafts(
    commentId: string
  ): Promise<DouyinReplyDraft[]> {
    const rows =
      await this.db.douyinReplyDraftRecord.findMany({
        where: { commentId },
        orderBy: [
          { createdAt: "asc" },
          { updatedAt: "asc" }
        ]
      });
    return rows.map(replyDraftToDomain);
  }

  async findReplyDraftById(
    draftId: string
  ): Promise<DouyinReplyDraft | null> {
    const row =
      await this.db.douyinReplyDraftRecord.findUnique({
        where: { id: draftId }
      });
    return row ? replyDraftToDomain(row) : null;
  }

  async mutateReplyDraft(input: {
    draftId: string;
    expectedRevision: number;
    currentText: string;
    status: "DRAFT" | "REJECTED";
    revisionRecord: DouyinReplyDraftRevision;
  }): Promise<DouyinReplyDraft | null> {
    const audit =
      douyinReplyDraftRevisionSchema.parse(
        input.revisionRecord
      );

    return this.db.$transaction(async (tx) => {
      const updated =
        await tx.douyinReplyDraftRecord.updateMany({
          where: {
            id: input.draftId,
            revision: input.expectedRevision
          },
          data: {
            currentText: input.currentText,
            status: input.status,
            revision: { increment: 1 },
            updatedAt: new Date(audit.createdAt)
          }
        });

      if (updated.count !== 1) {
        return null;
      }

      await tx.douyinReplyDraftRevisionRecord.create({
        data: {
          id: audit.id,
          projectId: audit.projectId,
          draftId: audit.draftId,
          commentId: audit.commentId,
          action: audit.action,
          beforeText: audit.beforeText,
          afterText: audit.afterText,
          beforeStatus: audit.beforeStatus,
          afterStatus: audit.afterStatus,
          expectedRevision: audit.expectedRevision,
          resultingRevision: audit.resultingRevision,
          createdAt: new Date(audit.createdAt)
        }
      });

      const row =
        await tx.douyinReplyDraftRecord.findUnique({
          where: { id: input.draftId }
        });
      if (!row) {
        throw new Error(
          "Reply draft disappeared during mutation"
        );
      }
      return replyDraftToDomain(row);
    });
  }

  async listReplyDraftRevisions(
    draftId: string
  ): Promise<DouyinReplyDraftRevision[]> {
    const rows =
      await this.db.douyinReplyDraftRevisionRecord.findMany({
        where: { draftId },
        orderBy: [
          { resultingRevision: "asc" },
          { createdAt: "asc" }
        ]
      });
    return rows.map(replyDraftRevisionToDomain);
  }

  async createInsight(
    input: DouyinInsight
  ): Promise<DouyinInsight> {
    const value = douyinInsightSchema.parse(input);
    return this.db.$transaction(async tx=>{
    const row = await tx.douyinInsightRecord.create({
      data: {
        id: value.id,
        projectId: value.projectId,
        bindingId: value.bindingId,
        awemeId: value.awemeId,
        productTruthHash: value.productTruthHash,
        metricSnapshotIdsJson:
          JSON.stringify(value.metricSnapshotIds),
        commentIdsJson:
          JSON.stringify(value.commentIds),
        evidenceHash: value.evidenceHash,
        summary: value.summary,
        strengthsJson:
          JSON.stringify(value.strengths),
        weaknessesJson:
          JSON.stringify(value.weaknesses),
        audienceQuestionsJson:
          JSON.stringify(value.audienceQuestions),
        nextCreativeActionsJson:
          JSON.stringify(value.nextCreativeActions),
        runtimeId: value.runtimeId,
        runtimeVersion: value.runtimeVersion,
        providerId: value.providerId ?? null,
        modelId: value.modelId ?? null,
        executionId: value.executionId ?? null,
        configVersion: value.configVersion ?? null,
        createdAt: new Date(value.createdAt)
      }
    });
    if(value.observationEvidence){
      assertEvidenceScope(value.observationEvidence,value);
      await tx.versionedEntity.create({data:{id:randomUUID(),projectId:value.projectId,entityType:"DouyinInsightEvidence",entityKey:value.id,version:1,status:"FROZEN",contentHash:value.evidenceHash,dataJson:JSON.stringify(value.observationEvidence)}});
    }
    return {...insightToDomain(row),...(value.observationEvidence?{observationEvidence:value.observationEvidence}:{})};
    });
  }

  private async hydrateInsight(row:InsightRow):Promise<DouyinInsight>{
    const value=insightToDomain(row);
    const saved=await this.db.versionedEntity.findUnique({where:{projectId_entityType_entityKey_version:{projectId:value.projectId,entityType:"DouyinInsightEvidence",entityKey:value.id,version:1}}});
    if(!saved)return value; // Historical insight remains readable, never silently gains verified coverage.
    const evidence=observationEvidenceSchema.parse(JSON.parse(saved.dataJson));
    if(saved.contentHash!==value.evidenceHash||hashValue(evidence)!==saved.contentHash)throw new DomainValidationError("复盘观察快照哈希校验失败");
    assertEvidenceScope(evidence,value);return {...value,observationEvidence:evidence};
  }

  async latestInsight(
    projectId: string,
    awemeId?: string
  ): Promise<DouyinInsight | null> {
    const row =
      await this.db.douyinInsightRecord.findFirst({
        where: {
          projectId,
          ...(awemeId ? { awemeId } : {})
        },
        orderBy: { createdAt: "desc" }
      });
    return row ? this.hydrateInsight(row) : null;
  }

  async listInsights(input: {
    projectId: string;
    awemeId?: string;
    limit?: number;
  }): Promise<DouyinInsight[]> {
    const limit =
      input.limit === undefined
        ? undefined
        : Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const rows =
      await this.db.douyinInsightRecord.findMany({
        where: {
          projectId: input.projectId,
          ...(input.awemeId
            ? { awemeId: input.awemeId }
            : {})
        },
        orderBy: { createdAt: "asc" },
        ...(limit ? { take: limit } : {})
      });
    return Promise.all(rows.map(row=>this.hydrateInsight(row)));
  }

  async findInsightById(
    insightId: string
  ): Promise<DouyinInsight | null> {
    const row =
      await this.db.douyinInsightRecord.findUnique({
        where: { id: insightId }
      });
    return row ? this.hydrateInsight(row) : null;
  }

  async upsertCreativeFeedback(
    input: DouyinCreativeFeedback
  ): Promise<DouyinCreativeFeedback> {
    const value =
      douyinCreativeFeedbackSchema.parse(input);
    const row =
      await this.db.douyinCreativeFeedbackRecord.upsert({
        where: {
          insightId_actionHash: {
            insightId: value.insightId,
            actionHash: value.actionHash
          }
        },
        create: {
          id: value.id,
          projectId: value.projectId,
          insightId: value.insightId,
          actionIndex: value.actionIndex,
          actionHash: value.actionHash,
          actionText: value.actionText,
          evidenceRefsJson:
            JSON.stringify(value.evidenceRefs),
          active: value.active,
          confirmedAt: new Date(value.confirmedAt),
          deactivatedAt: value.deactivatedAt
            ? new Date(value.deactivatedAt)
            : null,
          createdAt: new Date(value.createdAt),
          updatedAt: new Date(value.updatedAt)
        },
        update: {
          actionIndex: value.actionIndex,
          actionText: value.actionText,
          evidenceRefsJson:
            JSON.stringify(value.evidenceRefs),
          active: value.active,
          confirmedAt: new Date(value.confirmedAt),
          deactivatedAt: value.deactivatedAt
            ? new Date(value.deactivatedAt)
            : null,
          updatedAt: new Date(value.updatedAt)
        }
      });
    return creativeFeedbackToDomain(row);
  }

  async findCreativeFeedbackById(
    feedbackId: string
  ): Promise<DouyinCreativeFeedback | null> {
    const row =
      await this.db.douyinCreativeFeedbackRecord.findUnique({
        where: { id: feedbackId }
      });
    return row ? creativeFeedbackToDomain(row) : null;
  }

  async listCreativeFeedback(input: {
    projectId: string;
    active?: boolean;
  }): Promise<DouyinCreativeFeedback[]> {
    const rows =
      await this.db.douyinCreativeFeedbackRecord.findMany({
        where: {
          projectId: input.projectId,
          ...(input.active !== undefined
            ? { active: input.active }
            : {})
        },
        orderBy: [
          { confirmedAt: "asc" },
          { createdAt: "asc" }
        ]
      });
    return rows.map(creativeFeedbackToDomain);
  }

  async deactivateCreativeFeedback(input: {
    feedbackId: string;
    projectId: string;
    deactivatedAt: string;
  }): Promise<DouyinCreativeFeedback | null> {
    const updated =
      await this.db.douyinCreativeFeedbackRecord.updateMany({
        where: {
          id: input.feedbackId,
          projectId: input.projectId,
          active: true
        },
        data: {
          active: false,
          deactivatedAt: new Date(input.deactivatedAt),
          updatedAt: new Date(input.deactivatedAt)
        }
      });
    if (updated.count !== 1) return null;
    const row =
      await this.db.douyinCreativeFeedbackRecord.findUnique({
        where: { id: input.feedbackId }
      });
    return row ? creativeFeedbackToDomain(row) : null;
  }

  async claimReplyWriteIntent(
    input: DouyinReplyWriteIntent
  ): Promise<{
    intent: DouyinReplyWriteIntent;
    claimed: boolean;
  }> {
    const value =
      douyinReplyWriteIntentSchema.parse(input);

    const existingById =
      await this.db.douyinReplyWriteIntentRecord.findUnique({
        where: { id: value.id }
      });
    if (existingById) {
      return {
        intent: replyWriteIntentToDomain(existingById),
        claimed: false
      };
    }

    const existingByFingerprint =
      await this.db.douyinReplyWriteIntentRecord.findUnique({
        where: {
          operationFingerprint:
            value.operationFingerprint
        }
      });
    if (existingByFingerprint) {
      return {
        intent:
          replyWriteIntentToDomain(
            existingByFingerprint
          ),
        claimed: false
      };
    }

    try {
      const row =
        await this.db.douyinReplyWriteIntentRecord.create({
          data: {
            id: value.id,
            projectId: value.projectId,
            draftId: value.draftId,
            commentId: value.commentId,
            awemeId: value.awemeId,
            cid: value.cid,
            textHash: value.textHash,
            operationFingerprint:
              value.operationFingerprint,
            draftRevision: value.draftRevision,
            status: value.status,
            externalReplyCid:
              value.externalReplyCid ?? null,
            accountPublishId:
              value.accountPublishId,
            accountOpsId: value.accountOpsId,
            confirmedAt:
              new Date(value.confirmedAt),
            completedAt: value.completedAt
              ? new Date(value.completedAt)
              : null,
            message: value.message ?? null,
            createdAt: new Date(value.createdAt),
            updatedAt: new Date(value.updatedAt)
          }
        });
      return {
        intent: replyWriteIntentToDomain(row),
        claimed: true
      };
    } catch (error) {
      const raced =
        (await this.db.douyinReplyWriteIntentRecord.findUnique({
          where: { id: value.id }
        })) ??
        (await this.db.douyinReplyWriteIntentRecord.findUnique({
          where: {
            operationFingerprint:
              value.operationFingerprint
          }
        }));
      if (raced) {
        return {
          intent: replyWriteIntentToDomain(raced),
          claimed: false
        };
      }
      throw error;
    }
  }

  async findReplyWriteIntentById(
    intentId: string
  ): Promise<DouyinReplyWriteIntent | null> {
    const row =
      await this.db.douyinReplyWriteIntentRecord.findUnique({
        where: { id: intentId }
      });
    return row ? replyWriteIntentToDomain(row) : null;
  }

  async findReplyWriteIntentByFingerprint(
    operationFingerprint: string
  ): Promise<DouyinReplyWriteIntent | null> {
    const row =
      await this.db.douyinReplyWriteIntentRecord.findUnique({
        where: { operationFingerprint }
      });
    return row ? replyWriteIntentToDomain(row) : null;
  }

  async completeReplyWriteIntent(input: {
    intentId: string;
    status: Exclude<
      DouyinReplyWriteIntent["status"],
      "PENDING"
    >;
    externalReplyCid?: string;
    message?: string;
    completedAt: string;
  }): Promise<DouyinReplyWriteIntent> {
    const row =
      await this.db.douyinReplyWriteIntentRecord.update({
        where: { id: input.intentId },
        data: {
          status: input.status,
          externalReplyCid:
            input.externalReplyCid ?? null,
          message: input.message ?? null,
          completedAt:
            new Date(input.completedAt),
          updatedAt:
            new Date(input.completedAt)
        }
      });
    return replyWriteIntentToDomain(row);
  }

  async listLatestReplyWriteIntents(input: {
    projectId: string;
    awemeId?: string;
  }): Promise<DouyinReplyWriteIntent[]> {
    const rows =
      await this.db.douyinReplyWriteIntentRecord.findMany({
        where: {
          projectId: input.projectId,
          ...(input.awemeId
            ? { awemeId: input.awemeId }
            : {})
        },
        orderBy: [
          { createdAt: "asc" },
          { updatedAt: "asc" }
        ]
      });
    const latest = new Map<string, ReplyWriteIntentRow>();
    for (const row of rows) {
      latest.set(row.draftId, row);
    }
    return [...latest.values()].map(
      replyWriteIntentToDomain
    );
  }
}

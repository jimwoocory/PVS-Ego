import type {
  DouyinComment,
  DouyinCommentClassification,
  DouyinCreativeFeedback,
  DouyinInsight,
  DouyinMetricSnapshot,
  DouyinReplyDraft,
  DouyinReplyDraftRevision,
  DouyinReplyWriteIntent,
  DouyinWorkBinding
} from "../../domain/douyin-ops.js";

export interface DouyinOpsRepository {
  upsertWorkBinding(
    input: DouyinWorkBinding
  ): Promise<DouyinWorkBinding>;

  findWorkBindingById(
    id: string
  ): Promise<DouyinWorkBinding | null>;

  findWorkBindingByPackage(
    packageId: string
  ): Promise<DouyinWorkBinding | null>;

  latestWorkBinding(
    projectId: string,
    options?: { preferBound?: boolean }
  ): Promise<DouyinWorkBinding | null>;

  createMetricSnapshot(
    input: DouyinMetricSnapshot
  ): Promise<DouyinMetricSnapshot>;

  findMetricSnapshotByCaptureKey(
    projectId: string,
    captureKey: string
  ): Promise<DouyinMetricSnapshot | null>;

  listMetricSnapshots(input: {
    projectId: string;
    awemeId?: string;
    limit?: number;
  }): Promise<DouyinMetricSnapshot[]>;

  upsertComments(
    input: DouyinComment[],
    pageEvidence?:import("../../domain/douyin-comment-observation.js").CommentPageEvidence
  ): Promise<DouyinComment[]>;
  findCommentPageEvidence?(projectId:string,id:string):Promise<import("../../domain/douyin-comment-observation.js").CommentPageEvidence|null>;

  listComments(input: {
    projectId: string;
    awemeId?: string;
    parentCid?: string | null;
    limit?: number;
    offset?: number;
    order?: "asc" | "desc";
  }): Promise<DouyinComment[]>;

  findComment(input: {
    awemeId: string;
    cid: string;
  }): Promise<DouyinComment | null>;

  findCommentsByCids(
    projectId: string,
    cids: string[]
  ): Promise<DouyinComment[]>;

  latestCommentClassification(
    commentId: string
  ): Promise<DouyinCommentClassification | null>;

  saveCommentClassifications(input: {
    updates: Array<{
      commentId: string;
      sentiment: DouyinCommentClassification["sentiment"];
      category: DouyinCommentClassification["category"];
      priority: DouyinCommentClassification["priority"];
    }>;
    records: DouyinCommentClassification[];
  }): Promise<DouyinComment[]>;

  listCommentClassifications(
    commentId: string
  ): Promise<DouyinCommentClassification[]>;

  createReplyDraft(
    input: DouyinReplyDraft
  ): Promise<DouyinReplyDraft>;

  latestReplyDraft(
    commentId: string
  ): Promise<DouyinReplyDraft | null>;

  listLatestReplyDrafts(input: {
    projectId: string;
    awemeId?: string;
  }): Promise<DouyinReplyDraft[]>;

  listReplyDrafts(
    commentId: string
  ): Promise<DouyinReplyDraft[]>;

  findReplyDraftById(
    draftId: string
  ): Promise<DouyinReplyDraft | null>;

  mutateReplyDraft(input: {
    draftId: string;
    expectedRevision: number;
    currentText: string;
    status: "DRAFT" | "REJECTED" | "POSTED";
    revisionRecord: DouyinReplyDraftRevision;
  }): Promise<DouyinReplyDraft | null>;

  listReplyDraftRevisions(
    draftId: string
  ): Promise<DouyinReplyDraftRevision[]>;

  createInsight(
    input: DouyinInsight
  ): Promise<DouyinInsight>;

  latestInsight(
    projectId: string,
    awemeId?: string
  ): Promise<DouyinInsight | null>;

  listInsights(input: {
    projectId: string;
    awemeId?: string;
    limit?: number;
  }): Promise<DouyinInsight[]>;

  findInsightById(
    insightId: string
  ): Promise<DouyinInsight | null>;

  upsertCreativeFeedback(
    input: DouyinCreativeFeedback
  ): Promise<DouyinCreativeFeedback>;

  findCreativeFeedbackById(
    feedbackId: string
  ): Promise<DouyinCreativeFeedback | null>;

  listCreativeFeedback(input: {
    projectId: string;
    active?: boolean;
  }): Promise<DouyinCreativeFeedback[]>;

  deactivateCreativeFeedback(input: {
    feedbackId: string;
    projectId: string;
    deactivatedAt: string;
  }): Promise<DouyinCreativeFeedback | null>;

  claimReplyWriteIntent(
    input: DouyinReplyWriteIntent
  ): Promise<{
    intent: DouyinReplyWriteIntent;
    claimed: boolean;
  }>;

  findReplyWriteIntentById(
    intentId: string
  ): Promise<DouyinReplyWriteIntent | null>;

  findReplyWriteIntentByFingerprint(
    operationFingerprint: string
  ): Promise<DouyinReplyWriteIntent | null>;

  completeReplyWriteIntent(input: {
    intentId: string;
    status: Exclude<
      DouyinReplyWriteIntent["status"],
      "PENDING"
    >;
    externalReplyCid?: string;
    message?: string;
    completedAt: string;
  }): Promise<DouyinReplyWriteIntent>;

  listLatestReplyWriteIntents(input: {
    projectId: string;
    awemeId?: string;
  }): Promise<DouyinReplyWriteIntent[]>;

}

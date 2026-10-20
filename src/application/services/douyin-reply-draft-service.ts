import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DouyinOpsRepository } from "../ports/douyin-ops-repository.js";
import {
  generateStructuredJson,
  type StructuredAiRuntime
} from "../ports/structured-ai-runtime.js";
import type { ProductFlowService } from "./product-flow.js";
import {
  douyinReplyDraftRevisionSchema,
  douyinReplyDraftSchema,
  douyinReplyStrategySchema,
  type DouyinCommentClassification,
  type DouyinReplyDraft,
  type DouyinReplyDraftRevision
} from "../../domain/douyin-ops.js";
import { DomainValidationError } from "../../domain/validation.js";

const replyOutputSchema = z.object({
  replyText: z.string().trim().min(1).max(280),
  strategy: douyinReplyStrategySchema,
  usedFactIds: z.array(z.string().trim().min(1)).max(20)
});

function usableClassification(
  latest: DouyinCommentClassification | null,
  sourceContentHash: string
): DouyinCommentClassification | null {
  if (
    latest &&
    latest.sourceContentHash === sourceContentHash
  ) {
    return latest;
  }
  return null;
}

export class DouyinReplyDraftService {
  constructor(
    private readonly repo: DouyinOpsRepository,
    private readonly productFlow: Pick<
      ProductFlowService,
      "getWorkspace"
    >,
    private readonly runtime: StructuredAiRuntime
  ) {}

  async generate(input: {
    projectId: string;
    cid: string;
    createdAt?: string;
  }): Promise<DouyinReplyDraft> {
    const workspace =
      await this.productFlow.getWorkspace(
        input.projectId
      );
    if (!workspace) {
      throw new DomainValidationError("项目不存在");
    }

    const truth = workspace.productTruth;
    if (!truth || truth.status !== "CONFIRMED") {
      throw new DomainValidationError(
        "当前项目没有已确认的产品事实，不能生成安全的评论回复草稿"
      );
    }

    const binding =
      await this.repo.latestWorkBinding(input.projectId, { preferBound: true });
    if (
      !binding ||
      binding.status !== "BOUND" ||
      !binding.awemeId
    ) {
      throw new DomainValidationError(
        "当前项目尚未确认抖音作品绑定，不能生成回复草稿"
      );
    }

    const comment = await this.repo.findComment({
      awemeId: binding.awemeId,
      cid: input.cid
    });
    if (!comment || comment.projectId !== input.projectId) {
      throw new DomainValidationError(
        "评论不存在或不属于当前项目"
      );
    }

    const latestClassification =
      usableClassification(
        await this.repo.latestCommentClassification(
          comment.id
        ),
        comment.contentHash
      );

    if (
      latestClassification?.category ===
      "SPAM_OR_IRRELEVANT"
    ) {
      throw new DomainValidationError(
        "该评论已标记为无关或垃圾内容，默认不生成回复草稿"
      );
    }

    const facts = [
      ...truth.confirmedFeatures,
      ...truth.sellingPoints
    ].map((fact) => ({
      id: fact.id,
      statement: fact.statement
    }));
    const allowedFactIds = new Set(
      facts.map((fact) => fact.id)
    );
    const usageRules = (truth.usageRules ?? [])
      .filter((rule) => rule.status === "CONFIRMED")
      .map((rule) => ({
        id: rule.id,
        category: rule.category,
        polarity: rule.polarity,
        statement: rule.statement
      }));

    const aiResult = await generateStructuredJson(
      this.runtime,
      {
        task: "DOUYIN_REPLY_DRAFT",
        instructions: [
          "你为 Product Video Studio 生成一条抖音评论回复草稿。",
          "只输出草稿，不执行发布，也不要要求系统自动回复。",
          "任何关于产品参数、功能、使用方法、限制或效果的事实性表述，只能来自输入 confirmedFacts 或 confirmedUsageRules。",
          "如果评论问题无法由这些已确认事实回答，不要猜测具体参数或功效；使用 CLARIFY_WITHOUT_CLAIMING，以自然方式说明需要进一步确认或给出不带具体断言的回应。",
          "绝对不要使用、推断或补写输入中不存在的产品事实。",
          "usedFactIds 必须列出草稿实际使用到的 confirmedFacts id；没有使用事实时返回空数组。",
          "回复应自然、简洁、礼貌，通常 1–2 句，优先控制在 120 个中文字符以内。",
          "不要写虚假承诺、绝对化保证、未证实效果或诱导性夸大。",
          "strategy 只能是 ANSWER_QUESTION、ACKNOWLEDGE_FEEDBACK、THANK_AND_ENGAGE、DEESCALATE、CLARIFY_WITHOUT_CLAIMING。"
        ].join("\n"),
        input: {
          comment: {
            cid: comment.cid,
            text: comment.text,
            ...(latestClassification
              ? {
                  classification: {
                    sentiment:
                      latestClassification.sentiment,
                    category:
                      latestClassification.category,
                    priority:
                      latestClassification.priority,
                    rationale:
                      latestClassification.rationale
                  }
                }
              : {})
          },
          product: {
            productName: truth.productName,
            ...(truth.brand
              ? { brand: truth.brand }
              : {}),
            ...(truth.category
              ? { category: truth.category }
              : {}),
            confirmedFacts: facts,
            confirmedUsageRules: usageRules
          }
        },
        outputContract: {
          replyText: "string, 1–2 句自然中文",
          strategy:
            "ANSWER_QUESTION|ACKNOWLEDGE_FEEDBACK|THANK_AND_ENGAGE|DEESCALATE|CLARIFY_WITHOUT_CLAIMING",
          usedFactIds: [
            "仅允许使用 confirmedFacts 中存在的 id"
          ]
        },
        context: {
          projectId: input.projectId,
          step: "DOUYIN_OPS"
        }
      }
    );

    const parsedResult =
      replyOutputSchema.safeParse(aiResult.data);
    if (!parsedResult.success) {
      throw new Error(
        "AI 回复草稿结果格式无效"
      );
    }
    const output = parsedResult.data;
    const uniqueFactIds = [
      ...new Set(output.usedFactIds)
    ];
    const invalidFactIds = uniqueFactIds.filter(
      (id) => !allowedFactIds.has(id)
    );
    if (invalidFactIds.length) {
      throw new DomainValidationError(
        "AI 回复草稿引用了未确认的产品事实：" +
          invalidFactIds.join("、")
      );
    }

    const now =
      input.createdAt ?? new Date().toISOString();
    const metadata = aiResult.metadata;
    const draft = douyinReplyDraftSchema.parse({
      id: randomUUID(),
      projectId: input.projectId,
      commentId: comment.id,
      awemeId: comment.awemeId,
      cid: comment.cid,
      sourceContentHash: comment.contentHash,
      ...(latestClassification
        ? { classificationId: latestClassification.id }
        : {}),
      productTruthHash: truth.contentHash,
      usedFactIds: uniqueFactIds,
      generatedText: output.replyText,
      currentText: output.replyText,
      strategy: output.strategy,
      status: "DRAFT",
      revision: 1,
      runtimeId: this.runtime.id,
      runtimeVersion: this.runtime.version,
      ...(metadata?.providerId
        ? { providerId: metadata.providerId }
        : {}),
      ...(metadata?.modelId
        ? { modelId: metadata.modelId }
        : {}),
      ...(metadata?.executionId
        ? { executionId: metadata.executionId }
        : {}),
      ...(metadata?.configVersion
        ? { configVersion: metadata.configVersion }
        : {}),
      createdAt: now,
      updatedAt: now
    });

    return this.repo.createReplyDraft(draft);
  }


  private async requireEditableDraft(input: {
    projectId: string;
    draftId: string;
    expectedRevision: number;
  }): Promise<DouyinReplyDraft> {
    if (
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    ) {
      throw new DomainValidationError(
        "草稿 revision 无效"
      );
    }

    const draft =
      await this.repo.findReplyDraftById(
        input.draftId
      );
    if (!draft || draft.projectId !== input.projectId) {
      throw new DomainValidationError(
        "回复草稿不存在或不属于当前项目"
      );
    }
    if (draft.status !== "DRAFT") {
      throw new DomainValidationError(
        "只有 DRAFT 状态的回复草稿可以编辑或拒绝"
      );
    }

    const writeIntents =
      await this.repo.listLatestReplyWriteIntents({
        projectId: draft.projectId,
        awemeId: draft.awemeId
      });
    const activeWrite = writeIntents.find(
      (item) =>
        item.draftId === draft.id &&
        [
          "PENDING",
          "SUBMISSION_UNKNOWN",
          "REPLY_POSTED_CONFIRMED"
        ].includes(item.status)
    );
    if (activeWrite) {
      throw new DomainValidationError(
        activeWrite.status ===
        "REPLY_POSTED_CONFIRMED"
          ? "这条回复已经确认发布，不能再编辑草稿"
          : "这条回复存在进行中或状态不明的发布意图，禁止继续编辑或重试"
      );
    }

    if (draft.revision !== input.expectedRevision) {
      throw new DomainValidationError(
        "回复草稿已被更新，请刷新页面后重试"
      );
    }
    return draft;
  }

  async edit(input: {
    projectId: string;
    draftId: string;
    expectedRevision: number;
    currentText: string;
    updatedAt?: string;
  }): Promise<DouyinReplyDraft> {
    const currentText = input.currentText.trim();
    if (!currentText || currentText.length > 280) {
      throw new DomainValidationError(
        "回复草稿内容必须为 1–280 个字符"
      );
    }

    const draft = await this.requireEditableDraft(
      input
    );
    const now =
      input.updatedAt ?? new Date().toISOString();

    const audit =
      douyinReplyDraftRevisionSchema.parse({
        id: randomUUID(),
        projectId: input.projectId,
        draftId: draft.id,
        commentId: draft.commentId,
        action: "EDIT",
        beforeText: draft.currentText,
        afterText: currentText,
        beforeStatus: draft.status,
        afterStatus: "DRAFT",
        expectedRevision: draft.revision,
        resultingRevision: draft.revision + 1,
        createdAt: now
      });

    const updated =
      await this.repo.mutateReplyDraft({
        draftId: draft.id,
        expectedRevision: draft.revision,
        currentText,
        status: "DRAFT",
        revisionRecord: audit
      });
    if (!updated) {
      throw new DomainValidationError(
        "回复草稿已被更新，请刷新页面后重试"
      );
    }
    return updated;
  }

  async reject(input: {
    projectId: string;
    draftId: string;
    expectedRevision: number;
    updatedAt?: string;
  }): Promise<DouyinReplyDraft> {
    const draft = await this.requireEditableDraft(
      input
    );
    const now =
      input.updatedAt ?? new Date().toISOString();

    const audit =
      douyinReplyDraftRevisionSchema.parse({
        id: randomUUID(),
        projectId: input.projectId,
        draftId: draft.id,
        commentId: draft.commentId,
        action: "REJECT",
        beforeText: draft.currentText,
        afterText: draft.currentText,
        beforeStatus: draft.status,
        afterStatus: "REJECTED",
        expectedRevision: draft.revision,
        resultingRevision: draft.revision + 1,
        createdAt: now
      });

    const updated =
      await this.repo.mutateReplyDraft({
        draftId: draft.id,
        expectedRevision: draft.revision,
        currentText: draft.currentText,
        status: "REJECTED",
        revisionRecord: audit
      });
    if (!updated) {
      throw new DomainValidationError(
        "回复草稿已被更新，请刷新页面后重试"
      );
    }
    return updated;
  }

  revisions(
    draftId: string
  ): Promise<DouyinReplyDraftRevision[]> {
    return this.repo.listReplyDraftRevisions(
      draftId
    );
  }

  latestForWork(input: {
    projectId: string;
    awemeId: string;
  }): Promise<DouyinReplyDraft[]> {
    return this.repo.listLatestReplyDrafts(input);
  }

  history(
    commentId: string
  ): Promise<DouyinReplyDraft[]> {
    return this.repo.listReplyDrafts(commentId);
  }
}

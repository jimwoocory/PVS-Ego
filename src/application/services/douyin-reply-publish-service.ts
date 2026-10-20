import { randomUUID } from "node:crypto";
import type { DouyinOpsRepository } from "../ports/douyin-ops-repository.js";
import type { DouyinOpsRuntime } from "../ports/douyin-ops-runtime.js";
import { DouyinOpsRuntimeError } from "../ports/douyin-ops-runtime.js";
import type {
  DouyinReplyWriterRuntime
} from "../ports/douyin-reply-writer-runtime.js";
import {
  douyinReplyDraftRevisionSchema,
  douyinReplyWriteIntentSchema,
  type DouyinComment,
  type DouyinReplyWriteIntent
} from "../../domain/douyin-ops.js";
import { sha256Text } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import type {
  DouyinAccountBindingService
} from "./douyin-account-binding-service.js";

export type DouyinReplyPublishResult = {
  intent: DouyinReplyWriteIntent;
  externalCalled: boolean;
  draftMarkedPosted: boolean;
};

function validIntentId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

export class DouyinReplyPublishService {
  constructor(
    private readonly repo: DouyinOpsRepository,
    private readonly opsRuntime: DouyinOpsRuntime,
    private readonly accountBinding: DouyinAccountBindingService,
    private readonly writer: DouyinReplyWriterRuntime
  ) {}

  private async recheckPlatformComment(input: {
    awemeId: string;
    cid: string;
    expectedText: string;
  }): Promise<DouyinComment | null> {
    let cursor = "0";
    const seen = new Set<string>();

    for (let page = 0; page < 5; page += 1) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const result =
        await this.opsRuntime.getComments({
          awemeId: input.awemeId,
          cursor,
          count: 20
        });
      const found = result.comments.find(
        (comment) => comment.cid === input.cid
      );
      if (found) {
        if (
          found.text.trim() !==
          input.expectedText.trim()
        ) {
          throw new DomainValidationError(
            "平台上的源评论内容已变化，禁止发布旧回复草稿"
          );
        }
        return found as unknown as DouyinComment;
      }
      if (!result.hasMore) break;
      if (!result.cursor || result.cursor === cursor) {
        break;
      }
      cursor = result.cursor;
    }
    return null;
  }

  private async markDraftPosted(input: {
    draftId: string;
    projectId: string;
    expectedRevision: number;
    sentText: string;
    completedAt: string;
  }): Promise<boolean> {
    const current =
      await this.repo.findReplyDraftById(
        input.draftId
      );
    if (
      !current ||
      current.projectId !== input.projectId ||
      current.status !== "DRAFT" ||
      current.revision !== input.expectedRevision ||
      sha256Text(current.currentText) !==
        sha256Text(input.sentText)
    ) {
      return false;
    }

    const audit =
      douyinReplyDraftRevisionSchema.parse({
        id: randomUUID(),
        projectId: input.projectId,
        draftId: current.id,
        commentId: current.commentId,
        action: "POST",
        beforeText: current.currentText,
        afterText: current.currentText,
        beforeStatus: "DRAFT",
        afterStatus: "POSTED",
        expectedRevision: current.revision,
        resultingRevision: current.revision + 1,
        createdAt: input.completedAt
      });

    const updated =
      await this.repo.mutateReplyDraft({
        draftId: current.id,
        expectedRevision: current.revision,
        currentText: current.currentText,
        status: "POSTED",
        revisionRecord: audit
      });
    return Boolean(updated);
  }

  async publish(input: {
    projectId: string;
    draftId: string;
    expectedRevision: number;
    writeIntentId: string;
    confirmed: boolean;
    confirmedAt?: string;
  }): Promise<DouyinReplyPublishResult> {
    if (input.confirmed !== true) {
      throw new DomainValidationError(
        "需要明确确认后才能向抖音发布单条回复"
      );
    }
    if (!validIntentId(input.writeIntentId)) {
      throw new DomainValidationError(
        "writeIntentId 必须是 UUID"
      );
    }

    const existingIntent =
      await this.repo.findReplyWriteIntentById(
        input.writeIntentId
      );
    if (existingIntent) {
      if (
        existingIntent.projectId !== input.projectId ||
        existingIntent.draftId !== input.draftId ||
        existingIntent.draftRevision !==
          input.expectedRevision
      ) {
        throw new DomainValidationError(
          "writeIntentId 已被用于不同的回复请求"
        );
      }
      return {
        intent: existingIntent,
        externalCalled: false,
        draftMarkedPosted:
          existingIntent.status ===
          "REPLY_POSTED_CONFIRMED"
      };
    }

    const draft =
      await this.repo.findReplyDraftById(
        input.draftId
      );
    if (
      !draft ||
      draft.projectId !== input.projectId
    ) {
      throw new DomainValidationError(
        "回复草稿不存在或不属于当前项目"
      );
    }
    if (draft.status !== "DRAFT") {
      throw new DomainValidationError(
        "只有 DRAFT 状态的回复草稿可以确认发布"
      );
    }
    if (draft.revision !== input.expectedRevision) {
      throw new DomainValidationError(
        "回复草稿已被更新，请刷新页面并重新确认"
      );
    }

    const textHash = sha256Text(
      draft.currentText
    );
    const operationFingerprint = sha256Text(
      JSON.stringify({
        projectId: input.projectId,
        draftId: draft.id,
        awemeId: draft.awemeId,
        cid: draft.cid,
        revision: draft.revision,
        textHash
      })
    );

    const sameId =
      await this.repo.findReplyWriteIntentById(
        input.writeIntentId
      );
    if (
      sameId &&
      sameId.operationFingerprint !==
        operationFingerprint
    ) {
      throw new DomainValidationError(
        "writeIntentId 已被用于不同的回复请求"
      );
    }
    if (sameId) {
      return {
        intent: sameId,
        externalCalled: false,
        draftMarkedPosted:
          sameId.status ===
          "REPLY_POSTED_CONFIRMED"
      };
    }

    const duplicate =
      await this.repo.findReplyWriteIntentByFingerprint(
        operationFingerprint
      );
    if (duplicate) {
      return {
        intent: duplicate,
        externalCalled: false,
        draftMarkedPosted:
          duplicate.status ===
          "REPLY_POSTED_CONFIRMED"
      };
    }

    const account =
      await this.accountBinding.inspect();
    if (
      account.status !== "MATCHED" ||
      !account.canAutoBindPublishedWork ||
      !account.publish.platformUserId ||
      !account.ops.uniqueId
    ) {
      throw new DomainValidationError(
        "发布账号与运营账号尚未强 ID 匹配，禁止发布评论回复"
      );
    }

    const binding =
      await this.repo.latestWorkBinding(input.projectId, { preferBound: true });
    if (
      !binding ||
      binding.status !== "BOUND" ||
      !binding.awemeId ||
      binding.awemeId !== draft.awemeId
    ) {
      throw new DomainValidationError(
        "当前抖音作品绑定与回复草稿不一致"
      );
    }

    const storedComment =
      await this.repo.findComment({
        awemeId: draft.awemeId,
        cid: draft.cid
      });
    if (
      !storedComment ||
      storedComment.id !== draft.commentId
    ) {
      throw new DomainValidationError(
        "源评论不存在或与回复草稿不一致"
      );
    }
    if (
      storedComment.contentHash !==
      draft.sourceContentHash
    ) {
      throw new DomainValidationError(
        "源评论已重新同步并发生变化，请重新生成回复草稿"
      );
    }

    const liveComment =
      await this.recheckPlatformComment({
        awemeId: draft.awemeId,
        cid: draft.cid,
        expectedText: storedComment.text
      });
    if (!liveComment) {
      throw new DomainValidationError(
        "未能在当前抖音作品中重新确认源评论，禁止发布回复"
      );
    }

    const latestDraft =
      await this.repo.findReplyDraftById(
        draft.id
      );
    if (
      !latestDraft ||
      latestDraft.status !== "DRAFT" ||
      latestDraft.revision !==
        input.expectedRevision ||
      sha256Text(latestDraft.currentText) !==
        textHash
    ) {
      throw new DomainValidationError(
        "回复草稿在确认过程中发生变化，请刷新页面并重新确认"
      );
    }

    const now =
      input.confirmedAt ?? new Date().toISOString();
    const claim =
      await this.repo.claimReplyWriteIntent(
        douyinReplyWriteIntentSchema.parse({
          id: input.writeIntentId,
          projectId: input.projectId,
          draftId: draft.id,
          commentId: draft.commentId,
          awemeId: draft.awemeId,
          cid: draft.cid,
          textHash,
          operationFingerprint,
          draftRevision:
            input.expectedRevision,
          status: "PENDING",
          accountPublishId:
            account.publish.platformUserId,
          accountOpsId:
            account.ops.uniqueId,
          confirmedAt: now,
          createdAt: now,
          updatedAt: now
        })
      );

    if (!claim.claimed) {
      return {
        intent: claim.intent,
        externalCalled: false,
        draftMarkedPosted:
          claim.intent.status ===
          "REPLY_POSTED_CONFIRMED"
      };
    }

    let writeResult;
    try {
      writeResult =
        await this.writer.postReply({
          awemeId: draft.awemeId,
          cid: draft.cid,
          text: draft.currentText,
          writeIntentId:
            claim.intent.id,
          confirmed: true
        });
    } catch (error) {
      const definitiveLocalFailure =
        error instanceof DouyinOpsRuntimeError &&
        error.code === "ENGINE_UNAVAILABLE";
      const completedAt =
        new Date().toISOString();
      const intent =
        await this.repo.completeReplyWriteIntent({
          intentId: claim.intent.id,
          status: definitiveLocalFailure
            ? "FAILED"
            : "SUBMISSION_UNKNOWN",
          message:
            definitiveLocalFailure
              ? error.message
              : "外部写入调用异常，平台状态无法确认；禁止自动重试。",
          completedAt
        });
      return {
        intent,
        externalCalled: true,
        draftMarkedPosted: false
      };
    }

    const completedAt =
      new Date().toISOString();
    if (
      writeResult.status ===
        "REPLY_POSTED_CONFIRMED" &&
      writeResult.confirmed &&
      writeResult.replyCid
    ) {
      const intent =
        await this.repo.completeReplyWriteIntent({
          intentId: claim.intent.id,
          status:
            "REPLY_POSTED_CONFIRMED",
          externalReplyCid:
            writeResult.replyCid,
          message:
            writeResult.message,
          completedAt
        });
      const draftMarkedPosted =
        await this.markDraftPosted({
          draftId: draft.id,
          projectId: input.projectId,
          expectedRevision:
            input.expectedRevision,
          sentText: draft.currentText,
          completedAt
        });
      return {
        intent,
        externalCalled: true,
        draftMarkedPosted
      };
    }

    const status =
      writeResult.status === "REJECTED"
        ? "REJECTED"
        : "SUBMISSION_UNKNOWN";
    const intent =
      await this.repo.completeReplyWriteIntent({
        intentId: claim.intent.id,
        status,
        message:
          writeResult.message ??
          (status === "SUBMISSION_UNKNOWN"
            ? "平台状态无法确认；禁止自动重试。"
            : "抖音明确拒绝了本次回复。"),
        completedAt
      });
    return {
      intent,
      externalCalled: true,
      draftMarkedPosted: false
    };
  }
}

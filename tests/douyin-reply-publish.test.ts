import test from "node:test";
import assert from "node:assert/strict";
import type { DouyinOpsRepository } from "../src/application/ports/douyin-ops-repository.js";
import type { DouyinOpsRuntime } from "../src/application/ports/douyin-ops-runtime.js";
import type {
  DouyinReplyWriterRuntime,
  DouyinReplyWriteResult
} from "../src/application/ports/douyin-reply-writer-runtime.js";
import type { DouyinAccountBindingService } from "../src/application/services/douyin-account-binding-service.js";
import { DouyinReplyPublishService } from "../src/application/services/douyin-reply-publish-service.js";
import {
  douyinCommentSchema,
  douyinReplyDraftSchema,
  douyinWorkBindingSchema,
  type DouyinReplyDraft,
  type DouyinReplyWriteIntent
} from "../src/domain/douyin-ops.js";
import { sha256Text } from "../src/domain/hashing.js";
import { DomainValidationError } from "../src/domain/validation.js";

const NOW = "2026-10-07T08:00:00.000Z";
const PROJECT_ID = "reply-publish-project";
const AWEME_ID = "7900000000000000010";
const CID = "2001";
const DRAFT_ID = "reply-draft-publish-1";
const WRITE_INTENT_ID =
  "11111111-1111-4111-8111-111111111111";
const SECOND_INTENT_ID =
  "22222222-2222-4222-8222-222222222222";

function fixture() {
  const commentRaw = JSON.stringify({
    cid: CID,
    awemeId: AWEME_ID,
    text: "这个功能怎么样？"
  });
  const comment = douyinCommentSchema.parse({
    id: "comment-publish-1",
    projectId: PROJECT_ID,
    bindingId: "binding-publish-1",
    awemeId: AWEME_ID,
    cid: CID,
    nickname: "测试用户",
    text: "这个功能怎么样？",
    diggCount: 0,
    replyCount: 0,
    syncedAt: NOW,
    rawJson: commentRaw,
    contentHash: sha256Text(commentRaw),
    createdAt: NOW,
    updatedAt: NOW
  });
  const binding = douyinWorkBindingSchema.parse({
    id: "binding-publish-1",
    projectId: PROJECT_ID,
    packageId: "package-publish-1",
    publishReceiptId: "receipt-publish-1",
    awemeId: AWEME_ID,
    source: "PUBLISH_RECEIPT",
    confidence: "TRUSTED",
    status: "BOUND",
    boundAt: NOW,
    externalUrl:
      "https://www.douyin.com/video/" + AWEME_ID,
    createdAt: NOW,
    updatedAt: NOW
  });
  let draft: DouyinReplyDraft =
    douyinReplyDraftSchema.parse({
      id: DRAFT_ID,
      projectId: PROJECT_ID,
      commentId: comment.id,
      awemeId: AWEME_ID,
      cid: CID,
      sourceContentHash: comment.contentHash,
      productTruthHash: "a".repeat(64),
      usedFactIds: ["fact-1"],
      generatedText: "感谢关注，已确认的产品事实支持测试功能。",
      currentText: "感谢关注，已确认的产品事实支持测试功能。",
      strategy: "ANSWER_QUESTION",
      status: "DRAFT",
      revision: 1,
      runtimeId: "TEST_REPLY",
      runtimeVersion: "1",
      createdAt: NOW,
      updatedAt: NOW
    });

  const intentsById = new Map<
    string,
    DouyinReplyWriteIntent
  >();
  const intentsByFingerprint = new Map<
    string,
    DouyinReplyWriteIntent
  >();

  const repo = {
    async findReplyDraftById(id: string) {
      return id === draft.id
        ? structuredClone(draft)
        : null;
    },
    async latestWorkBinding(projectId: string) {
      return projectId === PROJECT_ID
        ? structuredClone(binding)
        : null;
    },
    async findComment(input: {
      awemeId: string;
      cid: string;
    }) {
      return input.awemeId === AWEME_ID &&
        input.cid === CID
        ? structuredClone(comment)
        : null;
    },
    async findReplyWriteIntentById(id: string) {
      return intentsById.get(id) ?? null;
    },
    async findReplyWriteIntentByFingerprint(
      fingerprint: string
    ) {
      return (
        intentsByFingerprint.get(fingerprint) ?? null
      );
    },
    async claimReplyWriteIntent(
      intent: DouyinReplyWriteIntent
    ) {
      const duplicate =
        intentsByFingerprint.get(
          intent.operationFingerprint
        );
      if (duplicate) {
        return {
          intent: duplicate,
          claimed: false
        };
      }
      intentsById.set(intent.id, intent);
      intentsByFingerprint.set(
        intent.operationFingerprint,
        intent
      );
      return {
        intent,
        claimed: true
      };
    },
    async completeReplyWriteIntent(input: {
      intentId: string;
      status: Exclude<
        DouyinReplyWriteIntent["status"],
        "PENDING"
      >;
      externalReplyCid?: string;
      message?: string;
      completedAt: string;
    }) {
      const current = intentsById.get(input.intentId);
      assert.ok(current);
      const completed = {
        ...current,
        status: input.status,
        ...(input.externalReplyCid
          ? {
              externalReplyCid:
                input.externalReplyCid
            }
          : {}),
        ...(input.message
          ? { message: input.message }
          : {}),
        completedAt: input.completedAt,
        updatedAt: input.completedAt
      } satisfies DouyinReplyWriteIntent;
      intentsById.set(completed.id, completed);
      intentsByFingerprint.set(
        completed.operationFingerprint,
        completed
      );
      return completed;
    },
    async mutateReplyDraft(input: {
      draftId: string;
      expectedRevision: number;
      currentText: string;
      status: DouyinReplyDraft["status"];
      revisionRecord: {
        createdAt: string;
      };
    }) {
      if (
        input.draftId !== draft.id ||
        input.expectedRevision !== draft.revision
      ) {
        return null;
      }
      draft = {
        ...draft,
        currentText: input.currentText,
        status: input.status,
        revision: draft.revision + 1,
        updatedAt: input.revisionRecord.createdAt
      };
      return structuredClone(draft);
    }
  } as unknown as DouyinOpsRepository;

  let liveCommentPresent = true;
  const opsRuntime = {
    async getComments() {
      return {
        comments: liveCommentPresent
          ? [
              {
                cid: CID,
                awemeId: AWEME_ID,
                uid: "uid",
                secUid: "sec",
                nickname: "测试用户",
                text: comment.text,
                diggCount: 0,
                replyCount: 0,
                createdAt: NOW,
                parentCid: "0",
                avatarUrl: ""
              }
            ]
          : [],
        cursor: "0",
        hasMore: false
      };
    }
  } as unknown as DouyinOpsRuntime;

  let accountMatched = true;
  const accountBinding = {
    async inspect() {
      return {
        status: accountMatched
          ? "MATCHED"
          : "MISMATCH",
        canAutoBindPublishedWork: accountMatched,
        publish: {
          platformUserId: "50805615998"
        },
        ops: {
          uniqueId: accountMatched
            ? "50805615998"
            : "other-account"
        }
      };
    }
  } as unknown as DouyinAccountBindingService;

  const writerCalls: Array<{
    writeIntentId: string;
    text: string;
  }> = [];
  let writerMode:
    | "SUCCESS"
    | "UNKNOWN"
    | "REJECTED"
    | "THROW" = "SUCCESS";
  const writer = {
    async postReply(input: {
      awemeId: string;
      cid: string;
      text: string;
      writeIntentId: string;
      confirmed: true;
    }): Promise<DouyinReplyWriteResult> {
      writerCalls.push({
        writeIntentId: input.writeIntentId,
        text: input.text
      });
      if (writerMode === "THROW") {
        throw new Error("transport interrupted");
      }
      if (writerMode === "UNKNOWN") {
        return {
          status: "SUBMISSION_UNKNOWN",
          confirmed: false,
          writeIntentId: input.writeIntentId,
          message: "platform result unknown"
        };
      }
      if (writerMode === "REJECTED") {
        return {
          status: "REJECTED",
          confirmed: false,
          writeIntentId: input.writeIntentId,
          message: "platform rejected"
        };
      }
      return {
        status: "REPLY_POSTED_CONFIRMED",
        confirmed: true,
        writeIntentId: input.writeIntentId,
        replyCid: "99887766",
        message: "posted"
      };
    }
  } as DouyinReplyWriterRuntime;

  const service = new DouyinReplyPublishService(
    repo,
    opsRuntime,
    accountBinding,
    writer
  );

  return {
    service,
    writerCalls,
    intentsById,
    getDraft: () => structuredClone(draft),
    setAccountMatched(value: boolean) {
      accountMatched = value;
    },
    setLiveCommentPresent(value: boolean) {
      liveCommentPresent = value;
    },
    setWriterMode(
      value:
        | "SUCCESS"
        | "UNKNOWN"
        | "REJECTED"
        | "THROW"
    ) {
      writerMode = value;
    }
  };
}

function publishInput(
  writeIntentId = WRITE_INTENT_ID
) {
  return {
    projectId: PROJECT_ID,
    draftId: DRAFT_ID,
    expectedRevision: 1,
    writeIntentId,
    confirmed: true as const
  };
}

test("single confirmed reply is invoked exactly once and same writeIntentId is idempotent", async () => {
  const fx = fixture();

  const first = await fx.service.publish(
    publishInput()
  );
  assert.equal(
    first.intent.status,
    "REPLY_POSTED_CONFIRMED"
  );
  assert.equal(first.externalCalled, true);
  assert.equal(first.draftMarkedPosted, true);
  assert.equal(fx.writerCalls.length, 1);
  assert.equal(
    fx.getDraft().status,
    "POSTED"
  );

  const repeated = await fx.service.publish(
    publishInput()
  );
  assert.equal(
    repeated.intent.status,
    "REPLY_POSTED_CONFIRMED"
  );
  assert.equal(repeated.externalCalled, false);
  assert.equal(repeated.draftMarkedPosted, true);
  assert.equal(fx.writerCalls.length, 1);
});

test("unknown platform state is persisted and never externally retried even with a new intent id", async () => {
  const fx = fixture();
  fx.setWriterMode("UNKNOWN");

  const first = await fx.service.publish(
    publishInput()
  );
  assert.equal(
    first.intent.status,
    "SUBMISSION_UNKNOWN"
  );
  assert.equal(first.externalCalled, true);
  assert.equal(fx.writerCalls.length, 1);
  assert.equal(fx.getDraft().status, "DRAFT");

  const repeated = await fx.service.publish(
    publishInput(SECOND_INTENT_ID)
  );
  assert.equal(
    repeated.intent.status,
    "SUBMISSION_UNKNOWN"
  );
  assert.equal(repeated.externalCalled, false);
  assert.equal(fx.writerCalls.length, 1);
});

test("all fail-closed gates block the writer before any Douyin write", async () => {
  {
    const fx = fixture();
    await assert.rejects(
      fx.service.publish({
        ...publishInput(),
        confirmed: false
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /明确确认/.test(error.message)
    );
    assert.equal(fx.writerCalls.length, 0);
  }

  {
    const fx = fixture();
    fx.setAccountMatched(false);
    await assert.rejects(
      fx.service.publish(publishInput()),
      /账号.*匹配/
    );
    assert.equal(fx.writerCalls.length, 0);
  }

  {
    const fx = fixture();
    await assert.rejects(
      fx.service.publish({
        ...publishInput(),
        expectedRevision: 2
      }),
      /草稿已被更新/
    );
    assert.equal(fx.writerCalls.length, 0);
  }

  {
    const fx = fixture();
    fx.setLiveCommentPresent(false);
    await assert.rejects(
      fx.service.publish(publishInput()),
      /重新确认源评论/
    );
    assert.equal(fx.writerCalls.length, 0);
  }
});

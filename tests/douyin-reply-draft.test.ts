import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { PrismaDouyinOpsRepository } from "../src/adapters/db/prisma-douyin-ops-repository.js";
import { DouyinReplyDraftService } from "../src/application/services/douyin-reply-draft-service.js";
import type {
  StructuredAiRequest,
  StructuredAiResult,
  StructuredAiRuntime
} from "../src/application/ports/structured-ai-runtime.js";
import type { ProductFlowService } from "../src/application/services/product-flow.js";
import {
  douyinCommentClassificationSchema,
  douyinCommentSchema,
  douyinWorkBindingSchema,
  type DouyinComment
} from "../src/domain/douyin-ops.js";
import { sha256Text } from "../src/domain/hashing.js";
import { DomainValidationError } from "../src/domain/validation.js";
import { makeProductTruth } from "./fixtures.js";

const exec = promisify(execFile);
const NOW = "2026-10-07T07:10:00.000Z";
const AWEME = "7900000000000000010";

class FakeReplyAi implements StructuredAiRuntime {
  readonly id = "TEST_REPLY_AI";
  readonly version = "1.0";
  calls: StructuredAiRequest[] = [];
  fail = false;
  data: unknown = {
    replyText: "已确认的产品事实显示支持测试功能，感谢关注。",
    strategy: "ANSWER_QUESTION",
    usedFactIds: ["fact-1"]
  };

  async generateJson(
    request: StructuredAiRequest
  ): Promise<unknown> {
    this.calls.push(request);
    if (this.fail) throw new Error("reply ai failed");
    return structuredClone(this.data);
  }

  async generateJsonWithMetadata(
    request: StructuredAiRequest
  ): Promise<StructuredAiResult> {
    this.calls.push(request);
    if (this.fail) throw new Error("reply ai failed");
    return {
      data: structuredClone(this.data),
      metadata: {
        executionId: "reply-exec-1",
        providerId: "aihubmix",
        modelId: "deepseek-v4.1-flash",
        configVersion: 7
      }
    };
  }
}

function makeComment(input: {
  projectId: string;
  bindingId: string;
  cid?: string;
  text?: string;
}): DouyinComment {
  const cid = input.cid ?? "2001";
  const text = input.text ?? "这个功能怎么样？";
  const raw = {
    cid,
    awemeId: AWEME,
    text,
    nickname: "测试用户"
  };
  const rawJson = JSON.stringify(raw);
  return douyinCommentSchema.parse({
    id: "douyin-comment:" + AWEME + ":" + cid,
    projectId: input.projectId,
    bindingId: input.bindingId,
    awemeId: AWEME,
    cid,
    nickname: "测试用户",
    text,
    diggCount: 0,
    replyCount: 0,
    syncedAt: NOW,
    rawJson,
    contentHash: sha256Text(rawJson),
    createdAt: NOW,
    updatedAt: NOW
  });
}

async function fixture(input?: {
  confirmedTruth?: boolean;
}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-douyin-reply-")
  );
  const database =
    "file:" +
    path.join(root, "fixture.db").replaceAll("\\", "/");

  await exec(
    process.execPath,
    [
      path.resolve("node_modules/prisma/build/index.js"),
      "migrate",
      "deploy"
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: database
      },
      windowsHide: true,
      timeout: 90_000
    }
  );

  const db = new PrismaClient({
    datasources: { db: { url: database } }
  });
  const projectId = "reply-project";
  await db.project.create({
    data: {
      id: projectId,
      name: "回复草稿测试",
      status: "PUBLISHED",
      targetPlatform: "douyin",
      targetDurationMs: 15000,
      aspectRatio: "9:16"
    }
  });

  const repo = new PrismaDouyinOpsRepository(db);
  const binding = douyinWorkBindingSchema.parse({
    id: "binding-reply",
    projectId,
    packageId: "package-reply",
    publishReceiptId: "receipt-reply",
    awemeId: AWEME,
    source: "PUBLISH_RECEIPT",
    confidence: "TRUSTED",
    status: "BOUND",
    boundAt: NOW,
    externalUrl:
      "https://www.douyin.com/video/" + AWEME,
    createdAt: NOW,
    updatedAt: NOW
  });
  await repo.upsertWorkBinding(binding);

  const comment = makeComment({
    projectId,
    bindingId: binding.id
  });
  await repo.upsertComments([comment]);

  const baseTruth = makeProductTruth();
  const truth = {
    ...baseTruth,
    projectId,
    productName: "测试耳机",
    brand: "TestBrand",
    status:
      input?.confirmedTruth === false
        ? ("DRAFT" as const)
        : ("CONFIRMED" as const),
    confirmedFeatures: [
      {
        id: "fact-1",
        statement: "支持测试功能",
        sourceType: "user" as const,
        createdAt: NOW
      }
    ],
    sellingPoints: [
      {
        id: "fact-2",
        statement: "外形轻巧",
        sourceType: "user" as const,
        createdAt: NOW
      }
    ],
    uncertainClaims: [
      {
        id: "claim-danger",
        statement: "未经确认的夸张参数",
        reason: "没有证据",
        status: "UNVERIFIED" as const,
        dispositionConfirmedByUser: true
      }
    ],
    contentHash:
      "f".repeat(64),
    ...(input?.confirmedTruth === false
      ? { confirmedAt: undefined }
      : { confirmedAt: NOW })
  };

  const productFlow = {
    async getWorkspace(id: string) {
      if (id !== projectId) return null;
      return {
        project: {
          id: projectId
        },
        productTruth: truth
      } as never;
    }
  } as unknown as Pick<
    ProductFlowService,
    "getWorkspace"
  >;

  const ai = new FakeReplyAi();
  const service = new DouyinReplyDraftService(
    repo,
    productFlow,
    ai
  );

  return {
    root,
    database,
    db,
    repo,
    binding,
    comment,
    truth,
    productFlow,
    ai,
    service,
    projectId,
    cleanup: async () => {
      await db.$disconnect();
      await fs.rm(root, {
        recursive: true,
        force: true
      });
    }
  };
}

test("generates a local reply draft from confirmed facts and audits fact ids", async () => {
  const fx = await fixture();
  try {
    const draft = await fx.service.generate({
      projectId: fx.projectId,
      cid: fx.comment.cid,
      createdAt: "2026-10-07T07:11:00.000Z"
    });

    assert.equal(draft.status, "DRAFT");
    assert.equal(draft.revision, 1);
    assert.equal(draft.commentId, fx.comment.id);
    assert.equal(draft.awemeId, AWEME);
    assert.equal(
      draft.productTruthHash,
      fx.truth.contentHash
    );
    assert.deepEqual(draft.usedFactIds, ["fact-1"]);
    assert.equal(
      draft.generatedText,
      draft.currentText
    );
    assert.equal(
      draft.providerId,
      "aihubmix"
    );
    assert.equal(
      draft.modelId,
      "deepseek-v4.1-flash"
    );
    assert.equal(
      draft.executionId,
      "reply-exec-1"
    );

    const stored =
      await fx.repo.latestReplyDraft(
        fx.comment.id
      );
    assert.equal(stored?.id, draft.id);

    assert.equal(fx.ai.calls.length, 1);
    assert.equal(
      fx.ai.calls[0]!.context?.step,
      "DOUYIN_OPS"
    );
    assert.equal(
      fx.ai.calls[0]!.task,
      "DOUYIN_REPLY_DRAFT"
    );

    const aiInput = JSON.stringify(
      fx.ai.calls[0]!.input
    );
    assert.match(aiInput, /支持测试功能/);
    assert.match(aiInput, /外形轻巧/);
    assert.doesNotMatch(
      aiInput,
      /未经确认的夸张参数/
    );
    assert.doesNotMatch(aiInput, /claim-danger/);
  } finally {
    await fx.cleanup();
  }
});

test("AI reply draft cannot cite an unknown or unconfirmed fact id", async () => {
  const fx = await fixture();
  try {
    fx.ai.data = {
      replyText: "这是一个没有事实依据的参数回复。",
      strategy: "ANSWER_QUESTION",
      usedFactIds: ["claim-danger"]
    };

    await assert.rejects(
      fx.service.generate({
        projectId: fx.projectId,
        cid: fx.comment.cid
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /未确认的产品事实/.test(error.message)
    );

    assert.equal(
      (
        await fx.repo.listReplyDrafts(
          fx.comment.id
        )
      ).length,
      0
    );
  } finally {
    await fx.cleanup();
  }
});

test("malformed AI output and AI failure create zero reply drafts", async () => {
  const fx = await fixture();
  try {
    fx.ai.data = {
      replyText: "",
      strategy: "NOT_ALLOWED",
      usedFactIds: []
    };
    await assert.rejects(
      fx.service.generate({
        projectId: fx.projectId,
        cid: fx.comment.cid
      }),
      /结果格式无效/
    );

    fx.ai.fail = true;
    await assert.rejects(
      fx.service.generate({
        projectId: fx.projectId,
        cid: fx.comment.cid
      }),
      /reply ai failed/
    );

    assert.equal(
      (
        await fx.repo.listReplyDrafts(
          fx.comment.id
        )
      ).length,
      0
    );
  } finally {
    await fx.cleanup();
  }
});

test("unconfirmed ProductTruth blocks draft generation before AI call", async () => {
  const fx = await fixture({
    confirmedTruth: false
  });
  try {
    await assert.rejects(
      fx.service.generate({
        projectId: fx.projectId,
        cid: fx.comment.cid
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /没有已确认的产品事实/.test(
          error.message
        )
    );
    assert.equal(fx.ai.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("spam classification blocks draft generation by default", async () => {
  const fx = await fixture();
  try {
    const classification =
      douyinCommentClassificationSchema.parse({
        id: "classification-spam",
        projectId: fx.projectId,
        commentId: fx.comment.id,
        awemeId: AWEME,
        cid: fx.comment.cid,
        sourceContentHash:
          fx.comment.contentHash,
        sentiment: "NEUTRAL",
        category: "SPAM_OR_IRRELEVANT",
        priority: "LOW",
        rationale: "测试垃圾内容",
        runtimeId: "test",
        runtimeVersion: "1",
        classifiedAt: NOW,
        createdAt: NOW
      });
    await fx.repo.saveCommentClassifications({
      updates: [
        {
          commentId: fx.comment.id,
          sentiment: classification.sentiment,
          category: classification.category,
          priority: classification.priority
        }
      ],
      records: [classification]
    });

    await assert.rejects(
      fx.service.generate({
        projectId: fx.projectId,
        cid: fx.comment.cid
      }),
      /无关或垃圾内容/
    );
    assert.equal(fx.ai.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("repeated generation keeps draft history and returns the newest draft", async () => {
  const fx = await fixture();
  try {
    const first = await fx.service.generate({
      projectId: fx.projectId,
      cid: fx.comment.cid,
      createdAt: "2026-10-07T07:11:00.000Z"
    });

    fx.ai.data = {
      replyText: "第二版草稿，只用于本地预览。",
      strategy: "THANK_AND_ENGAGE",
      usedFactIds: []
    };
    const second = await fx.service.generate({
      projectId: fx.projectId,
      cid: fx.comment.cid,
      createdAt: "2026-10-07T07:12:00.000Z"
    });

    const history =
      await fx.service.history(
        fx.comment.id
      );
    assert.equal(history.length, 2);
    assert.equal(history[0]!.id, first.id);
    assert.equal(history[1]!.id, second.id);

    const latest =
      await fx.repo.latestReplyDraft(
        fx.comment.id
      );
    assert.equal(latest?.id, second.id);
    assert.equal(
      latest?.currentText,
      "第二版草稿，只用于本地预览。"
    );

    assert.equal(
      await fx.db.douyinReplyDraftRecord.count(),
      2
    );
  } finally {
    await fx.cleanup();
  }
});

test("draft generation requires a stored comment on the current bound work", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      fx.service.generate({
        projectId: fx.projectId,
        cid: "999999"
      }),
      /评论不存在或不属于当前项目/
    );
    assert.equal(fx.ai.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("edits a local reply draft with optimistic revision and immutable audit", async () => {
  const fx = await fixture();
  try {
    const draft = await fx.service.generate({
      projectId: fx.projectId,
      cid: fx.comment.cid,
      createdAt: "2026-10-07T07:11:00.000Z"
    });

    const edited = await fx.service.edit({
      projectId: fx.projectId,
      draftId: draft.id,
      expectedRevision: 1,
      currentText: "人工修改后的草稿，只保存在 PVS。",
      updatedAt: "2026-10-07T07:13:00.000Z"
    });

    assert.equal(edited.status, "DRAFT");
    assert.equal(edited.revision, 2);
    assert.equal(
      edited.currentText,
      "人工修改后的草稿，只保存在 PVS。"
    );
    assert.equal(
      edited.generatedText,
      draft.generatedText
    );

    const revisions =
      await fx.service.revisions(draft.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]!.action, "EDIT");
    assert.equal(revisions[0]!.beforeText, draft.currentText);
    assert.equal(revisions[0]!.afterText, edited.currentText);
    assert.equal(revisions[0]!.expectedRevision, 1);
    assert.equal(revisions[0]!.resultingRevision, 2);
  } finally {
    await fx.cleanup();
  }
});

test("stale reply draft revision fails without overwriting newer text", async () => {
  const fx = await fixture();
  try {
    const draft = await fx.service.generate({
      projectId: fx.projectId,
      cid: fx.comment.cid
    });

    const edited = await fx.service.edit({
      projectId: fx.projectId,
      draftId: draft.id,
      expectedRevision: 1,
      currentText: "第一窗口已经保存的新内容"
    });
    assert.equal(edited.revision, 2);

    await assert.rejects(
      fx.service.edit({
        projectId: fx.projectId,
        draftId: draft.id,
        expectedRevision: 1,
        currentText: "旧窗口试图覆盖"
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /已被更新/.test(error.message)
    );

    const latest =
      await fx.repo.findReplyDraftById(draft.id);
    assert.equal(latest?.revision, 2);
    assert.equal(
      latest?.currentText,
      "第一窗口已经保存的新内容"
    );
    assert.equal(
      (await fx.service.revisions(draft.id)).length,
      1
    );
  } finally {
    await fx.cleanup();
  }
});

test("rejects a local draft and prevents later editing", async () => {
  const fx = await fixture();
  try {
    const draft = await fx.service.generate({
      projectId: fx.projectId,
      cid: fx.comment.cid
    });

    const rejected = await fx.service.reject({
      projectId: fx.projectId,
      draftId: draft.id,
      expectedRevision: 1,
      updatedAt: "2026-10-07T07:14:00.000Z"
    });
    assert.equal(rejected.status, "REJECTED");
    assert.equal(rejected.revision, 2);
    assert.equal(rejected.currentText, draft.currentText);

    const revisions =
      await fx.service.revisions(draft.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]!.action, "REJECT");
    assert.equal(revisions[0]!.afterStatus, "REJECTED");

    await assert.rejects(
      fx.service.edit({
        projectId: fx.projectId,
        draftId: draft.id,
        expectedRevision: 2,
        currentText: "拒绝后不能继续编辑"
      }),
      /只有 DRAFT 状态/
    );
  } finally {
    await fx.cleanup();
  }
});

test("P1-03 service exposes no approval or posting action", async () => {
  const source = await fs.readFile(
    path.resolve(
      "src/application/services/douyin-reply-draft-service.ts"
    ),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /postReply|publishReply|approveReply|status:\s*"POSTED"|status:\s*"APPROVED"/
  );
});

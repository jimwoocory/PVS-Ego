import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { PrismaDouyinOpsRepository } from "../src/adapters/db/prisma-douyin-ops-repository.js";
import { DouyinCommentClassificationService } from "../src/application/services/douyin-comment-classification-service.js";
import type {
  StructuredAiRequest,
  StructuredAiResult,
  StructuredAiRuntime
} from "../src/application/ports/structured-ai-runtime.js";
import {
  douyinCommentSchema,
  douyinWorkBindingSchema,
  type DouyinComment
} from "../src/domain/douyin-ops.js";
import { sha256Text } from "../src/domain/hashing.js";
import { DomainValidationError } from "../src/domain/validation.js";

const exec = promisify(execFile);
const NOW = "2026-10-07T06:30:00.000Z";
const AWEME = "7900000000000000010";

type AiResponseFactory = (
  request: StructuredAiRequest
) => unknown;

class FakeAiRuntime implements StructuredAiRuntime {
  readonly id = "TEST_DOUYIN_AI";
  readonly version = "1.0";
  calls: StructuredAiRequest[] = [];
  fail = false;
  factory: AiResponseFactory = (request) => {
    const input = request.input as {
      comments: Array<{ cid: string; text: string }>;
    };
    return {
      items: input.comments.map((comment) => ({
        cid: comment.cid,
        sentiment:
          comment.text.includes("不好")
            ? "NEGATIVE"
            : "POSITIVE",
        category:
          comment.text.includes("?") ||
          comment.text.includes("吗")
            ? "PRODUCT_QUESTION"
            : "PRAISE",
        priority:
          comment.text.includes("?") ||
          comment.text.includes("吗")
            ? "HIGH"
            : "LOW",
        rationale: "测试分类"
      }))
    };
  };

  async generateJson(
    request: StructuredAiRequest
  ): Promise<unknown> {
    this.calls.push(request);
    if (this.fail) throw new Error("ai failed");
    return this.factory(request);
  }

  async generateJsonWithMetadata(
    request: StructuredAiRequest
  ): Promise<StructuredAiResult> {
    this.calls.push(request);
    if (this.fail) throw new Error("ai failed");
    return {
      data: this.factory(request),
      metadata: {
        executionId: "exec-douyin-1",
        providerId: "aihubmix",
        modelId: "deepseek-v4.1-flash",
        configVersion: 3
      }
    };
  }
}

function makeComment(input: {
  projectId: string;
  bindingId: string;
  cid: string;
  text: string;
  sentiment?: string;
  category?: string;
  priority?: string;
  syncedAt?: string;
}): DouyinComment {
  const normalized = {
    cid: input.cid,
    awemeId: AWEME,
    uid: "user-" + input.cid,
    secUid: "sec-" + input.cid,
    nickname: "用户" + input.cid,
    text: input.text,
    diggCount: 0,
    replyCount: 0,
    createdAt: NOW,
    parentCid: "",
    avatarUrl: ""
  };
  const rawJson = JSON.stringify(normalized);
  return douyinCommentSchema.parse({
    id: "douyin-comment:" + AWEME + ":" + input.cid,
    projectId: input.projectId,
    bindingId: input.bindingId,
    awemeId: AWEME,
    cid: input.cid,
    uid: normalized.uid,
    secUid: normalized.secUid,
    nickname: normalized.nickname,
    text: input.text,
    diggCount: 0,
    replyCount: 0,
    platformCreatedAt: NOW,
    ...(input.sentiment
      ? { sentiment: input.sentiment }
      : {}),
    ...(input.category
      ? { category: input.category }
      : {}),
    ...(input.priority
      ? { priority: input.priority }
      : {}),
    syncedAt: input.syncedAt ?? NOW,
    rawJson,
    contentHash: sha256Text(rawJson),
    createdAt: NOW,
    updatedAt: input.syncedAt ?? NOW
  });
}

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-douyin-classify-")
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
  const projectId = "douyin-classification-project";
  await db.project.create({
    data: {
      id: projectId,
      name: "抖音评论 AI 分类测试",
      status: "PUBLISHED",
      targetPlatform: "douyin",
      targetDurationMs: 15000,
      aspectRatio: "9:16"
    }
  });

  const repo = new PrismaDouyinOpsRepository(db);
  const binding = douyinWorkBindingSchema.parse({
    id: "binding-1",
    projectId,
    packageId: "package-1",
    publishReceiptId: "receipt-1",
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

  const ai = new FakeAiRuntime();
  const service =
    new DouyinCommentClassificationService(
      repo,
      ai
    );

  return {
    root,
    database,
    db,
    repo,
    binding,
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

test("classifies stored comments and keeps immutable audit history", async () => {
  const fx = await fixture();
  try {
    const c1 = makeComment({
      projectId: fx.projectId,
      bindingId: fx.binding.id,
      cid: "1001",
      text: "这个耳机续航多久吗？"
    });
    const c2 = makeComment({
      projectId: fx.projectId,
      bindingId: fx.binding.id,
      cid: "1002",
      text: "看起来很好"
    });
    await fx.repo.upsertComments([c1, c2]);

    const before1 =
      await fx.repo.findComment({
        awemeId: AWEME,
        cid: "1001"
      });
    assert.ok(before1);

    const result = await fx.service.classify({
      projectId: fx.projectId,
      cids: ["1001", "1002"],
      classifiedAt: "2026-10-07T06:31:00.000Z"
    });

    assert.equal(result.classifiedCount, 2);
    assert.equal(result.skippedCount, 0);
    assert.equal(
      result.execution?.providerId,
      "aihubmix"
    );
    assert.equal(
      result.execution?.modelId,
      "deepseek-v4.1-flash"
    );

    const after1 =
      await fx.repo.findComment({
        awemeId: AWEME,
        cid: "1001"
      });
    const after2 =
      await fx.repo.findComment({
        awemeId: AWEME,
        cid: "1002"
      });
    assert.equal(after1?.sentiment, "POSITIVE");
    assert.equal(
      after1?.category,
      "PRODUCT_QUESTION"
    );
    assert.equal(after1?.priority, "HIGH");
    assert.equal(after2?.category, "PRAISE");
    assert.equal(after2?.priority, "LOW");

    // Source fields are untouched by classification.
    assert.equal(after1?.text, before1.text);
    assert.equal(after1?.rawJson, before1.rawJson);
    assert.equal(
      after1?.contentHash,
      before1.contentHash
    );

    const history =
      await fx.repo.listCommentClassifications(
        c1.id
      );
    assert.equal(history.length, 1);
    assert.equal(
      history[0]!.sourceContentHash,
      c1.contentHash
    );
    assert.equal(
      history[0]!.executionId,
      "exec-douyin-1"
    );
    assert.equal(
      history[0]!.providerId,
      "aihubmix"
    );
    assert.equal(
      history[0]!.modelId,
      "deepseek-v4.1-flash"
    );

    assert.equal(fx.ai.calls.length, 1);
    assert.equal(
      fx.ai.calls[0]!.context?.step,
      "DOUYIN_OPS"
    );
    assert.equal(
      fx.ai.calls[0]!.task,
      "DOUYIN_COMMENT_CLASSIFICATION"
    );
  } finally {
    await fx.cleanup();
  }
});

test("valid current classifications are skipped unless force=true", async () => {
  const fx = await fixture();
  try {
    const c = makeComment({
      projectId: fx.projectId,
      bindingId: fx.binding.id,
      cid: "1101",
      text: "很不错"
    });
    await fx.repo.upsertComments([c]);

    await fx.service.classify({
      projectId: fx.projectId,
      cids: ["1101"],
      classifiedAt: "2026-10-07T06:31:00.000Z"
    });
    assert.equal(fx.ai.calls.length, 1);

    const skipped = await fx.service.classify({
      projectId: fx.projectId,
      cids: ["1101"],
      classifiedAt: "2026-10-07T06:32:00.000Z"
    });
    assert.equal(skipped.classifiedCount, 0);
    assert.equal(skipped.skippedCount, 1);
    assert.equal(fx.ai.calls.length, 1);

    fx.ai.factory = (request) => {
      const input = request.input as {
        comments: Array<{ cid: string }>;
      };
      return {
        items: input.comments.map((item) => ({
          cid: item.cid,
          sentiment: "NEUTRAL",
          category: "GENERAL_INTERACTION",
          priority: "MEDIUM",
          rationale: "强制重分类"
        }))
      };
    };

    const forced = await fx.service.classify({
      projectId: fx.projectId,
      cids: ["1101"],
      force: true,
      classifiedAt: "2026-10-07T06:33:00.000Z"
    });
    assert.equal(forced.classifiedCount, 1);
    assert.equal(fx.ai.calls.length, 2);

    const history =
      await fx.repo.listCommentClassifications(
        c.id
      );
    assert.equal(history.length, 2);
    assert.equal(
      history[1]!.category,
      "GENERAL_INTERACTION"
    );
  } finally {
    await fx.cleanup();
  }
});

test("source-content change automatically invalidates skip optimization", async () => {
  const fx = await fixture();
  try {
    const original = makeComment({
      projectId: fx.projectId,
      bindingId: fx.binding.id,
      cid: "1201",
      text: "很好"
    });
    await fx.repo.upsertComments([original]);
    await fx.service.classify({
      projectId: fx.projectId,
      cids: ["1201"],
      classifiedAt: "2026-10-07T06:31:00.000Z"
    });

    const first =
      await fx.repo.findComment({
        awemeId: AWEME,
        cid: "1201"
      });
    assert.equal(first?.category, "PRAISE");

    // P0 resync preserves derived fields but replaces source content/hash.
    const changed = makeComment({
      projectId: fx.projectId,
      bindingId: fx.binding.id,
      cid: "1201",
      text: "这个不好用吗？",
      sentiment: first?.sentiment,
      category: first?.category,
      priority: first?.priority,
      syncedAt: "2026-10-07T06:34:00.000Z"
    });
    await fx.repo.upsertComments([changed]);

    await fx.service.classify({
      projectId: fx.projectId,
      cids: ["1201"],
      classifiedAt: "2026-10-07T06:35:00.000Z"
    });

    assert.equal(fx.ai.calls.length, 2);
    const latest =
      await fx.repo.findComment({
        awemeId: AWEME,
        cid: "1201"
      });
    assert.equal(latest?.sentiment, "NEGATIVE");
    assert.equal(
      latest?.category,
      "PRODUCT_QUESTION"
    );
    assert.equal(latest?.priority, "HIGH");

    const history =
      await fx.repo.listCommentClassifications(
        original.id
      );
    assert.equal(history.length, 2);
    assert.notEqual(
      history[0]!.sourceContentHash,
      history[1]!.sourceContentHash
    );
  } finally {
    await fx.cleanup();
  }
});

test("AI output with unknown or missing cid performs zero writes", async () => {
  const fx = await fixture();
  try {
    const c1 = makeComment({
      projectId: fx.projectId,
      bindingId: fx.binding.id,
      cid: "1301",
      text: "问题一？"
    });
    const c2 = makeComment({
      projectId: fx.projectId,
      bindingId: fx.binding.id,
      cid: "1302",
      text: "问题二？"
    });
    await fx.repo.upsertComments([c1, c2]);

    fx.ai.factory = () => ({
      items: [
        {
          cid: "9999",
          sentiment: "NEUTRAL",
          category: "GENERAL_INTERACTION",
          priority: "LOW"
        }
      ]
    });

    await assert.rejects(
      fx.service.classify({
        projectId: fx.projectId,
        cids: ["1301", "1302"]
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /不存在的 cid/.test(error.message)
    );

    const r1 =
      await fx.repo.findComment({
        awemeId: AWEME,
        cid: "1301"
      });
    const r2 =
      await fx.repo.findComment({
        awemeId: AWEME,
        cid: "1302"
      });
    assert.equal(r1?.sentiment, undefined);
    assert.equal(r1?.category, undefined);
    assert.equal(r1?.priority, undefined);
    assert.equal(r2?.sentiment, undefined);
    assert.equal(
      (
        await fx.repo.listCommentClassifications(
          c1.id
        )
      ).length,
      0
    );
    assert.equal(
      (
        await fx.repo.listCommentClassifications(
          c2.id
        )
      ).length,
      0
    );
  } finally {
    await fx.cleanup();
  }
});

test("AI output that omits a requested cid performs zero writes", async () => {
  const fx = await fixture();
  try {
    const c1 = makeComment({
      projectId: fx.projectId,
      bindingId: fx.binding.id,
      cid: "1351",
      text: "问题一？"
    });
    const c2 = makeComment({
      projectId: fx.projectId,
      bindingId: fx.binding.id,
      cid: "1352",
      text: "问题二？"
    });
    await fx.repo.upsertComments([c1, c2]);

    fx.ai.factory = () => ({
      items: [
        {
          cid: "1351",
          sentiment: "NEUTRAL",
          category: "PRODUCT_QUESTION",
          priority: "HIGH",
          rationale: "只返回一条，模拟模型遗漏"
        }
      ]
    });

    await assert.rejects(
      fx.service.classify({
        projectId: fx.projectId,
        cids: ["1351", "1352"]
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /遗漏 cid/.test(error.message)
    );

    const stored1 = await fx.repo.findComment({
      awemeId: AWEME,
      cid: "1351"
    });
    const stored2 = await fx.repo.findComment({
      awemeId: AWEME,
      cid: "1352"
    });
    assert.equal(stored1?.sentiment, undefined);
    assert.equal(stored2?.sentiment, undefined);
    assert.equal(
      (
        await fx.repo.listCommentClassifications(
          c1.id
        )
      ).length,
      0
    );
    assert.equal(
      (
        await fx.repo.listCommentClassifications(
          c2.id
        )
      ).length,
      0
    );
  } finally {
    await fx.cleanup();
  }
});

test("AI exception leaves raw comments and classifications unchanged", async () => {
  const fx = await fixture();
  try {
    const c = makeComment({
      projectId: fx.projectId,
      bindingId: fx.binding.id,
      cid: "1401",
      text: "测试"
    });
    await fx.repo.upsertComments([c]);
    fx.ai.fail = true;

    await assert.rejects(
      fx.service.classify({
        projectId: fx.projectId,
        cids: ["1401"]
      }),
      /ai failed/
    );

    const stored =
      await fx.repo.findComment({
        awemeId: AWEME,
        cid: "1401"
      });
    assert.equal(stored?.text, "测试");
    assert.equal(stored?.sentiment, undefined);
    assert.equal(stored?.category, undefined);
    assert.equal(stored?.priority, undefined);
    assert.equal(
      (
        await fx.repo.listCommentClassifications(
          c.id
        )
      ).length,
      0
    );
  } finally {
    await fx.cleanup();
  }
});

test("classification requires comments from the requested project", async () => {
  const fx = await fixture();
  try {
    const c = makeComment({
      projectId: fx.projectId,
      bindingId: fx.binding.id,
      cid: "1501",
      text: "测试"
    });
    await fx.repo.upsertComments([c]);

    await assert.rejects(
      fx.service.classify({
        projectId: "another-project",
        cids: ["1501"]
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /不属于当前项目/.test(error.message)
    );
    assert.equal(fx.ai.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

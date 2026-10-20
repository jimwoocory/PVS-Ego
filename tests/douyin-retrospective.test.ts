import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { PrismaDouyinOpsRepository } from "../src/adapters/db/prisma-douyin-ops-repository.js";
import { DouyinRetrospectiveService } from "../src/application/services/douyin-retrospective-service.js";
import type {
  StructuredAiRequest,
  StructuredAiResult,
  StructuredAiRuntime
} from "../src/application/ports/structured-ai-runtime.js";
import type { ProductFlowService } from "../src/application/services/product-flow.js";
import {
  douyinCommentSchema,
  douyinMetricSnapshotSchema,
  douyinWorkBindingSchema
} from "../src/domain/douyin-ops.js";
import { sha256Text } from "../src/domain/hashing.js";
import { DomainValidationError } from "../src/domain/validation.js";
import { makeProductTruth } from "./fixtures.js";

const exec = promisify(execFile);
const AWEME = "7900000000000000010";
const NOW = "2026-10-07T07:50:00.000Z";

class FakeRetroAi implements StructuredAiRuntime {
  readonly id = "TEST_RETRO_AI";
  readonly version = "1.0";
  calls: StructuredAiRequest[] = [];
  fail = false;
  data: unknown = {
    summary: "播放逐步增长，当前评论样本偏少。",
    strengths: [
      {
        text: "播放量从 100 增长到 150。",
        evidenceRefs: ["metric:snapshot-1", "metric:snapshot-2"]
      }
    ],
    weaknesses: [
      {
        text: "评论样本较少，暂不做强因果判断。",
        evidenceRefs: ["metric:snapshot-2"]
      }
    ],
    audienceQuestions: [
      {
        text: "用户询问佩戴舒适度。",
        evidenceRefs: ["comment:comment-1"]
      }
    ],
    nextCreativeActions: [
      {
        text: "下一条视频直接回应佩戴舒适度。",
        evidenceRefs: ["comment:comment-1", "metric:snapshot-2"]
      }
    ]
  };

  async generateJson(request: StructuredAiRequest): Promise<unknown> {
    this.calls.push(request);
    if (this.fail) throw new Error("retro ai failed");
    return structuredClone(this.data);
  }

  async generateJsonWithMetadata(
    request: StructuredAiRequest
  ): Promise<StructuredAiResult> {
    this.calls.push(request);
    if (this.fail) throw new Error("retro ai failed");
    return {
      data: structuredClone(this.data),
      metadata: {
        executionId: "retro-exec-1",
        providerId: "aihubmix",
        modelId: "deepseek-v4.1-flash",
        configVersion: 8
      }
    };
  }
}

async function fixture(input?: {
  confirmedTruth?: boolean;
  withMetrics?: boolean;
}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-douyin-retro-")
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
  const projectId = "retro-project";
  await db.project.create({
    data: {
      id: projectId,
      name: "抖音复盘测试",
      status: "PUBLISHED",
      targetPlatform: "douyin",
      targetDurationMs: 15000,
      aspectRatio: "9:16"
    }
  });

  const repo = new PrismaDouyinOpsRepository(db);
  const binding = douyinWorkBindingSchema.parse({
    id: "binding-retro",
    projectId,
    packageId: "package-retro",
    publishReceiptId: "receipt-retro",
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

  if (input?.withMetrics !== false) {
    for (const [id, capturedAt, plays] of [
      ["snapshot-1", "2026-10-07T07:30:00.000Z", 100],
      ["snapshot-2", "2026-10-07T07:45:00.000Z", 150]
    ] as const) {
      const rawJson = JSON.stringify({
        awemeId: AWEME,
        plays,
        likes: plays / 10,
        comments: plays === 100 ? 1 : 2,
        shares: 0
      });
      await repo.createMetricSnapshot(
        douyinMetricSnapshotSchema.parse({
          id,
          projectId,
          bindingId: binding.id,
          awemeId: AWEME,
          captureKey: id,
          capturedAt,
          plays,
          likes: plays / 10,
          comments: plays === 100 ? 1 : 2,
          shares: 0,
          rawJson,
          contentHash: sha256Text(rawJson),
          createdAt: capturedAt
        })
      );
    }
  }

  const rawComment = JSON.stringify({
    cid: "3001",
    text: "戴久了舒服吗？"
  });
  await repo.upsertComments([
    douyinCommentSchema.parse({
      id: "comment-1",
      projectId,
      bindingId: binding.id,
      awemeId: AWEME,
      cid: "3001",
      nickname: "用户A",
      text: "戴久了舒服吗？",
      diggCount: 1,
      replyCount: 0,
      category: "PRODUCT_QUESTION",
      priority: "HIGH",
      sentiment: "NEUTRAL",
      syncedAt: NOW,
      rawJson: rawComment,
      contentHash: sha256Text(rawComment),
      createdAt: NOW,
      updatedAt: NOW
    })
  ]);

  const baseTruth = makeProductTruth();
  const truth = {
    ...baseTruth,
    projectId,
    productName: "测试耳机",
    status:
      input?.confirmedTruth === false
        ? ("DRAFT" as const)
        : ("CONFIRMED" as const),
    confirmedFeatures: [
      {
        id: "fact-1",
        statement: "采用耳夹式佩戴结构",
        sourceType: "user" as const,
        createdAt: NOW
      }
    ],
    contentHash: "e".repeat(64),
    ...(input?.confirmedTruth === false
      ? { confirmedAt: undefined }
      : { confirmedAt: NOW })
  };

  const productFlow = {
    async getWorkspace(id: string) {
      if (id !== projectId) return null;
      return {
        project: { id: projectId },
        productTruth: truth
      } as never;
    }
  } as unknown as Pick<ProductFlowService, "getWorkspace">;

  const ai = new FakeRetroAi();
  const service = new DouyinRetrospectiveService(
    repo,
    productFlow,
    ai
  );

  return {
    root,
    db,
    repo,
    binding,
    truth,
    ai,
    service,
    projectId,
    cleanup: async () => {
      await db.$disconnect();
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

test("retrospective uses metric history and comment evidence and persists audit metadata", async () => {
  const fx = await fixture();
  try {
    const insight = await fx.service.generate({
      projectId: fx.projectId,
      createdAt: NOW
    });

    assert.equal(insight.metricSnapshotIds.length, 2);
    assert.deepEqual(
      insight.metricSnapshotIds,
      ["snapshot-1", "snapshot-2"]
    );
    assert.deepEqual(insight.commentIds, ["comment-1"]);
    assert.equal(insight.providerId, "aihubmix");
    assert.equal(insight.modelId, "deepseek-v4.1-flash");
    assert.equal(insight.executionId, "retro-exec-1");
    assert.equal(
      insight.nextCreativeActions[0]!.evidenceRefs[0],
      "comment:comment-1"
    );

    assert.equal(fx.ai.calls.length, 1);
    assert.equal(
      fx.ai.calls[0]!.task,
      "DOUYIN_POST_PUBLISH_RETROSPECTIVE"
    );
    assert.equal(
      fx.ai.calls[0]!.context?.step,
      "DOUYIN_OPS"
    );
    const inputJson = JSON.stringify(fx.ai.calls[0]!.input);
    assert.match(inputJson, /snapshot-1/);
    assert.match(inputJson, /snapshot-2/);
    assert.match(inputJson, /戴久了舒服吗/);

    const stored = await fx.repo.latestInsight(
      fx.projectId,
      AWEME
    );
    assert.equal(stored?.id, insight.id);
  } finally {
    await fx.cleanup();
  }
});

test("unknown AI evidence reference causes zero retrospective writes", async () => {
  const fx = await fixture();
  try {
    fx.ai.data = {
      summary: "测试",
      strengths: [
        {
          text: "引用不存在证据",
          evidenceRefs: ["metric:not-real"]
        }
      ],
      weaknesses: [],
      audienceQuestions: [],
      nextCreativeActions: []
    };

    await assert.rejects(
      fx.service.generate({
        projectId: fx.projectId
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /不存在的证据/.test(error.message)
    );

    assert.equal(
      await fx.db.douyinInsightRecord.count(),
      0
    );
  } finally {
    await fx.cleanup();
  }
});

test("AI failure creates zero retrospective records", async () => {
  const fx = await fixture();
  try {
    fx.ai.fail = true;
    await assert.rejects(
      fx.service.generate({
        projectId: fx.projectId
      }),
      /retro ai failed/
    );
    assert.equal(
      await fx.db.douyinInsightRecord.count(),
      0
    );
  } finally {
    await fx.cleanup();
  }
});

test("retrospective requires stored metric evidence", async () => {
  const fx = await fixture({ withMetrics: false });
  try {
    await assert.rejects(
      fx.service.generate({
        projectId: fx.projectId
      }),
      /至少需要一条已保存的作品指标快照/
    );
    assert.equal(fx.ai.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("unconfirmed product truth blocks retrospective before AI call", async () => {
  const fx = await fixture({ confirmedTruth: false });
  try {
    await assert.rejects(
      fx.service.generate({
        projectId: fx.projectId
      }),
      /没有已确认的产品事实/
    );
    assert.equal(fx.ai.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

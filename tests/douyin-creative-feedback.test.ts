import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { PrismaDouyinOpsRepository } from "../src/adapters/db/prisma-douyin-ops-repository.js";
import { DouyinCreativeFeedbackService } from "../src/application/services/douyin-creative-feedback-service.js";
import { AiGenerationService } from "../src/application/services/ai-generation.js";
import type {
  StructuredAiRequest,
  StructuredAiResult,
  StructuredAiRuntime
} from "../src/application/ports/structured-ai-runtime.js";
import {
  douyinInsightSchema,
  douyinWorkBindingSchema
} from "../src/domain/douyin-ops.js";
import { makeProductTruth } from "./fixtures.js";
import { DomainValidationError } from "../src/domain/validation.js";

const exec = promisify(execFile);
const AWEME = "7900000000000000010";
const NOW = "2026-10-07T08:20:00.000Z";

class FakeCreativeAi implements StructuredAiRuntime {
  readonly id = "TEST_CREATIVE_AI";
  readonly version = "1.0";
  calls: StructuredAiRequest[] = [];

  private data(request: StructuredAiRequest) {
    const input = request.input as {
      targetDurationMs: number;
    };
    return {
      concepts: Array.from({ length: 4 }, (_, index) => ({
        title: "创意" + (index + 1),
        targetAudience: "目标用户",
        painPoint: "测试痛点",
        hook: "前三秒直接展示",
        coreSellingPoint: "核心卖点",
        narrativePattern: "问题-产品-结果",
        expectedDurationMs: input.targetDurationMs,
        productShowcaseStrategy: "真实展示产品",
        generationRisk: "LOW",
        requiredFactIds: ["fact-1"]
      }))
    };
  }

  async generateJson(
    request: StructuredAiRequest
  ): Promise<unknown> {
    this.calls.push(request);
    return this.data(request);
  }

  async generateJsonWithMetadata(
    request: StructuredAiRequest
  ): Promise<StructuredAiResult> {
    this.calls.push(request);
    return {
      data: this.data(request),
      metadata: {
        executionId: "creative-exec-1",
        providerId: "aihubmix",
        modelId: "deepseek-v4.1-flash",
        configVersion: 9
      }
    };
  }
}

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-douyin-feedback-")
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
  const projectId = "feedback-project";
  await db.project.create({
    data: {
      id: projectId,
      name: "复盘回流测试",
      status: "PUBLISHED",
      targetPlatform: "douyin",
      targetDurationMs: 15000,
      aspectRatio: "9:16"
    }
  });
  const repo = new PrismaDouyinOpsRepository(db);
  const binding = douyinWorkBindingSchema.parse({
    id: "binding-feedback",
    projectId,
    packageId: "package-feedback",
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

  const insight = await repo.createInsight(
    douyinInsightSchema.parse({
      id: "insight-feedback",
      projectId,
      bindingId: binding.id,
      awemeId: AWEME,
      productTruthHash: "e".repeat(64),
      metricSnapshotIds: ["snapshot-1"],
      commentIds: ["comment-1"],
      evidenceHash: "f".repeat(64),
      summary: "用户关注佩戴舒适度。",
      strengths: [],
      weaknesses: [],
      audienceQuestions: [
        {
          text: "用户询问舒适度",
          evidenceRefs: ["comment:comment-1"]
        }
      ],
      nextCreativeActions: [
        {
          text: "下一条视频前三秒直接回应佩戴舒适度。",
          evidenceRefs: [
            "comment:comment-1",
            "metric:snapshot-1"
          ]
        },
        {
          text: "保留当前产品特写节奏。",
          evidenceRefs: ["metric:snapshot-1"]
        }
      ],
      runtimeId: "TEST_RETRO",
      runtimeVersion: "1",
      createdAt: NOW
    })
  );

  const service =
    new DouyinCreativeFeedbackService(repo);

  return {
    root,
    db,
    repo,
    binding,
    insight,
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

test("retrospective action requires explicit confirmation and exact action index", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      fx.service.promote({
        projectId: fx.projectId,
        insightId: fx.insight.id,
        actionIndex: 0,
        confirmed: false
      }),
      /明确确认/
    );
    assert.equal(
      (
        await fx.service.active(fx.projectId)
      ).length,
      0
    );

    await assert.rejects(
      fx.service.promote({
        projectId: fx.projectId,
        insightId: fx.insight.id,
        actionIndex: 99,
        confirmed: true
      }),
      /所选复盘建议不存在/
    );
  } finally {
    await fx.cleanup();
  }
});

test("confirmed evidence-backed action becomes active and is auditable", async () => {
  const fx = await fixture();
  try {
    const feedback = await fx.service.promote({
      projectId: fx.projectId,
      insightId: fx.insight.id,
      actionIndex: 0,
      confirmed: true,
      confirmedAt: NOW
    });

    assert.equal(feedback.active, true);
    assert.equal(feedback.actionIndex, 0);
    assert.equal(
      feedback.actionText,
      fx.insight.nextCreativeActions[0]!.text
    );
    assert.deepEqual(
      feedback.evidenceRefs,
      fx.insight.nextCreativeActions[0]!.evidenceRefs
    );

    const context =
      await fx.service.context(fx.projectId);
    assert.deepEqual(context, [
      {
        feedbackId: feedback.id,
        insightId: fx.insight.id,
        text:
          "下一条视频前三秒直接回应佩戴舒适度。",
        evidenceRefs: [
          "comment:comment-1",
          "metric:snapshot-1"
        ]
      }
    ]);
  } finally {
    await fx.cleanup();
  }
});

test("active confirmed feedback is injected into next creative generation and disappears after deactivation", async () => {
  const fx = await fixture();
  try {
    const truth = {
      ...makeProductTruth(),
      projectId: fx.projectId
    };
    const ai = new FakeCreativeAi();
    const generation = new AiGenerationService(
      ai,
      undefined,
      (projectId) => fx.service.context(projectId)
    );

    await generation.generateCreativeBatch(
      truth,
      1,
      15000
    );
    const before = ai.calls.at(-1)!;
    const beforeInput =
      before.input as Record<string, unknown>;
    assert.equal(
      "douyinFeedback" in beforeInput,
      false
    );

    const feedback = await fx.service.promote({
      projectId: fx.projectId,
      insightId: fx.insight.id,
      actionIndex: 0,
      confirmed: true,
      confirmedAt: NOW
    });

    await generation.generateCreativeBatch(
      truth,
      2,
      15000
    );
    const withFeedback =
      ai.calls.at(-1)!.input as {
        douyinFeedback?: Array<{
          text: string;
          evidenceRefs: string[];
        }>;
      };
    assert.equal(
      withFeedback.douyinFeedback?.[0]?.text,
      "下一条视频前三秒直接回应佩戴舒适度。"
    );
    assert.deepEqual(
      withFeedback.douyinFeedback?.[0]?.evidenceRefs,
      [
        "comment:comment-1",
        "metric:snapshot-1"
      ]
    );

    await fx.service.deactivate({
      projectId: fx.projectId,
      feedbackId: feedback.id,
      confirmed: true,
      deactivatedAt:
        "2026-10-07T08:21:00.000Z"
    });

    await generation.generateCreativeBatch(
      truth,
      3,
      15000
    );
    const after =
      ai.calls.at(-1)!.input as Record<string, unknown>;
    assert.equal(
      "douyinFeedback" in after,
      false
    );
  } finally {
    await fx.cleanup();
  }
});

test("feedback cannot be deactivated without explicit confirmation", async () => {
  const fx = await fixture();
  try {
    const feedback = await fx.service.promote({
      projectId: fx.projectId,
      insightId: fx.insight.id,
      actionIndex: 0,
      confirmed: true
    });
    await assert.rejects(
      fx.service.deactivate({
        projectId: fx.projectId,
        feedbackId: feedback.id,
        confirmed: false
      }),
      /明确确认/
    );
    assert.equal(
      (
        await fx.service.active(fx.projectId)
      ).length,
      1
    );
  } finally {
    await fx.cleanup();
  }
});

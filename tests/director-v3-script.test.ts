import test from "node:test";
import assert from "node:assert/strict";
import type {
  CreativeBatch,
  ScriptDraft
} from "../src/domain/schemas.js";
import type { StructuredAiRuntime } from "../src/application/ports/structured-ai-runtime.js";
import { ScriptFeasibilityService } from "../src/application/services/script-feasibility-service.js";
import { makeProductTruth, H, ISO } from "./fixtures.js";

function batch(): CreativeBatch {
  const truth = makeProductTruth();
  const concepts = Array.from({ length: 4 }, (_, index) => ({
    id: "creative-" + (index + 1),
    title: "Concept " + (index + 1),
    targetAudience: "office workers",
    painPoint: "neck fatigue",
    hook: "late work creates a need",
    coreSellingPoint: "confirmed product feature",
    narrativePattern: "need -> product -> use",
    expectedDurationMs: 21000,
    productShowcaseStrategy: "natural use",
    generationRisk: "LOW" as const,
    requiredFactIds: ["fact-1"]
  }));
  return {
    id: "batch-1",
    projectId: truth.projectId,
    version: 1,
    status: "ACTIVE",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: truth.id,
      version: truth.version,
      hash: truth.contentHash
    },
    generatorVersion: "test@1",
    concepts,
    contentHash: H.b,
    createdAt: ISO
  };
}

function overloadedScript(): ScriptDraft {
  const truth = makeProductTruth();
  const b = batch();
  const texts = [
    "0-3秒高角度俯拍，双手拍平并翻面，0.9秒硬切草本，画面下方打出大字字幕。",
    "切到工位，收拾桌面、合上电脑、揉脖子、背包、关灯离开。",
    "回家进入卧室，打开柜门、取出产品、翻面、放到桌面。",
    "特写拆开外罩、拉开内胆、分装草本、逐个展示。",
    "双手拍、压、翻、调整产品，再贴近看分层。",
    "床头俯拍，把产品摆正、轻压、平铺。",
    "Hero 定帧 3 秒，字幕打出 CTA。"
  ];
  return {
    id: "script-overloaded",
    projectId: truth.projectId,
    version: 1,
    status: "DRAFT",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: truth.id,
      version: truth.version,
      hash: truth.contentHash
    },
    creativeBatchRef: {
      entityType: "CreativeBatch",
      entityId: b.id,
      version: b.version,
      hash: b.contentHash
    },
    selectedCreativeId: "creative-1",
    targetDurationMs: 21000,
    beats: texts.map((text, index) => ({
      id: "beat-over-" + index,
      order: index + 1,
      purpose: index === 0 ? "HOOK" : index === 6 ? "CTA" : "FEATURE",
      text,
      estimatedDurationMs: 3000,
      requiredFactIds: index > 1 ? ["fact-1"] : []
    })),
    contentHash: H.c
  };
}

function cleanScript(): ScriptDraft {
  const truth = makeProductTruth();
  const b = batch();
  const beat = (
    id: string,
    order: number,
    purpose: ScriptDraft["beats"][number]["purpose"],
    location: string,
    action: string,
    stateIn: string,
    stateOut: string,
    productRole: string,
    text: string
  ): ScriptDraft["beats"][number] => ({
    id,
    order,
    purpose,
    text,
    estimatedDurationMs:
      order === 1 ? 5000 : order === 4 ? 6000 : 5000,
    requiredFactIds:
      purpose === "PRODUCT" || purpose === "FEATURE"
        ? ["fact-1"]
        : [],
    videoIntent: {
      location,
      storyAction: action,
      productRole,
      stateIn,
      stateOut,
      audioIntent: {
        ambience: [
          location === "办公室"
            ? "安静办公室环境声"
            : "卧室自然环境声"
        ],
        sfx: ["自然交互声"],
        bgm: false
      },
      postProductionText: []
    }
  });
  return {
    id: "script-clean",
    projectId: truth.projectId,
    version: 1,
    status: "DRAFT",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: truth.id,
      version: truth.version,
      hash: truth.contentHash
    },
    creativeBatchRef: {
      entityType: "CreativeBatch",
      entityId: b.id,
      version: b.version,
      hash: b.contentHash
    },
    selectedCreativeId: "creative-1",
    targetDurationMs: 21000,
    beats: [
      beat("beat-1", 1, "HOOK", "办公室", "结束工作并揉后颈", "仍在工作", "准备离开", "产品不出现", "深夜工作结束，颈部疲劳。"),
      beat("beat-2", 2, "PRODUCT", "卧室", "从床边取出产品", "产品收在床边", "产品完整放到床上", "产品完整出现", "回家后取出产品并放到床上。"),
      beat("beat-3", 3, "FEATURE", "卧室", "打开产品展示一次内部状态", "产品闭合", "产品打开", "展示已确认产品状态", "打开产品，展示一个明确的内部状态。"),
      beat("beat-4", 4, "RESULT", "卧室", "整理产品并自然收束", "产品打开", "产品完整平铺", "完整产品 Hero", "整理产品并回到完整成品。")
    ],
    contentHash: H.d
  };
}

test("Director V3 script QA rejects the current 21s-style overloaded editing script", () => {
  const service = new ScriptFeasibilityService({
    id: "unused",
    version: "1",
    async generateJson() {
      throw new Error("not used");
    }
  });
  const report = service.review(overloadedScript());
  assert.equal(report.status, "REVISE");
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.ok(codes.has("TOO_MANY_BEATS"));
  assert.ok(codes.has("ACTION_DENSITY_HIGH"));
  assert.ok(codes.has("EDITING_INSTRUCTION_IN_STORY"));
  assert.ok(codes.has("BURNED_TEXT_INSTRUCTION"));
  assert.ok(codes.has("AUDIO_INTENT_MISSING"));
});

test("Director V3 script QA accepts a story-level script with explicit native audio intent", () => {
  const service = new ScriptFeasibilityService({
    id: "unused",
    version: "1",
    async generateJson() {
      throw new Error("not used");
    }
  });
  const report = service.review(cleanScript());
  assert.equal(report.status, "PASS");
  assert.equal(report.issues.length, 0);
});

test("Director V3 can repair an overloaded script and the repaired result passes QA", async () => {
  const runtime: StructuredAiRuntime = {
    id: "mock-v3",
    version: "1",
    async generateJson() {
      return {
        beats: cleanScript().beats.map((beat) => ({
          purpose: beat.purpose,
          text: beat.text,
          estimatedDurationMs: beat.estimatedDurationMs,
          requiredFactIds: beat.requiredFactIds,
          videoIntent: beat.videoIntent
        }))
      };
    }
  };
  const service = new ScriptFeasibilityService(runtime);
  const source = overloadedScript();
  const report = service.review(source);
  const repaired = await service.repair({
    truth: makeProductTruth(),
    batch: batch(),
    script: source,
    report,
    outputVersion: source.version + 1
  });
  const repairedReport = service.review(repaired);
  assert.equal(repairedReport.status, "PASS");
  assert.equal(repaired.version, source.version + 1);
  assert.equal(repaired.beats.length, 4);
  assert.ok(
    repaired.beats.every(
      (beat) => beat.videoIntent?.audioIntent.bgm === false
    )
  );
});

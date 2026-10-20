import test from "node:test";
import assert from "node:assert/strict";
import type {
  StructuredAiRequest,
  StructuredAiRuntime
} from "../src/application/ports/structured-ai-runtime.js";
import { UsageComplianceService } from "../src/application/services/usage-compliance.js";
import { DomainValidationError } from "../src/domain/validation.js";
import type {
  ProductTruth,
  ProductionPlan,
  ScriptDraft
} from "../src/domain/schemas.js";
import { H, ISO, makeProductTruth, makeValidClip } from "./fixtures.js";

class ComplianceRuntime implements StructuredAiRuntime {
  readonly id = "compliance-test";
  readonly version = "1";
  constructor(
    private readonly response: {
      violations: Array<{
        ruleId: string;
        description: string;
        evidence: string;
      }>;
    }
  ) {}
  async generateJson(_request: StructuredAiRequest): Promise<unknown> {
    return structuredClone(this.response);
  }
}

function truthWithUsageRule(): ProductTruth {
  const truth = makeProductTruth();
  return {
    ...truth,
    usageRules: [
      {
        id: "usage-rule-wearing",
        category: "WEARING_POSITION",
        polarity: "MUST",
        statement: "耳夹应夹在耳廓，不得塞入耳道。",
        sourceType: "research",
        evidenceRefs: ["research-evidence:e1"],
        confidence: "HIGH",
        status: "CONFIRMED",
        dispositionConfirmedByUser: true
      }
    ]
  };
}

function scriptFor(truth: ProductTruth): ScriptDraft {
  return {
    id: "script-usage",
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
      entityId: "batch-usage",
      version: 1,
      hash: H.b
    },
    selectedCreativeId: "creative-usage",
    targetDurationMs: 10000,
    beats: [
      {
        id: "beat-usage",
        order: 1,
        purpose: "PRODUCT",
        text: "把耳机塞入耳道开始听歌。",
        estimatedDurationMs: 10000,
        requiredFactIds: []
      }
    ],
    contentHash: H.c
  };
}

function planFor(truth: ProductTruth): ProductionPlan {
  const clip = makeValidClip();
  clip.sourceBeatIds = ["beat-usage"];
  clip.requiredFactIds = [];
  clip.segments = clip.segments.map((segment) => ({
    ...segment,
    sourceBeatIds: ["beat-usage"],
    requiredFactIds: []
  }));
  return {
    id: "plan-usage",
    projectId: truth.projectId,
    version: 1,
    status: "DRAFT",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: truth.id,
      version: truth.version,
      hash: truth.contentHash
    },
    scriptRef: {
      entityType: "ScriptDraft",
      entityId: "script-usage",
      version: 1,
      hash: H.c
    },
    selectedCreativeId: "creative-usage",
    visualDirection: "真实使用演示",
    soundDirection: "清晰",
    productShowcaseRules: ["展示正确佩戴"],
    continuityLock: {
      product: {
        stableAttributes: [],
        forbiddenChanges: structuredClone(truth.forbiddenChanges)
      },
      characters: [],
      environments: [
        { sceneId: "scene-usage", stableElements: ["室内"] }
      ]
    },
    scenes: [
      {
        id: "scene-usage",
        order: 1,
        purpose: "佩戴演示",
        location: "室内",
        visualState: "稳定",
        sourceBeatIds: ["beat-usage"],
        requiredFactIds: [],
        clips: [
          {
            ...clip,
            sceneId: "scene-usage",
            productVisibility: "CLEAR",
            openingState: {
              ...clip.openingState,
              productState: "耳机在手中"
            },
            closingState: {
              ...clip.closingState,
              productState: "耳机塞入耳道"
            },
            segments: clip.segments.map((segment) => ({
              ...segment,
              subjectAction: "人物把耳夹式耳机塞入耳道",
              productState: "耳机位于耳道内"
            }))
          }
        ]
      }
    ],
    contentHash: H.d
  };
}

test("usage compliance blocks a script that conflicts with a confirmed wearing rule", async () => {
  const truth = truthWithUsageRule();
  const service = new UsageComplianceService(
    new ComplianceRuntime({
      violations: [
        {
          ruleId: "usage-rule-wearing",
          description: "佩戴位置错误",
          evidence: "把耳机塞入耳道"
        }
      ]
    })
  );

  await assert.rejects(
    service.assertScript(truth, scriptFor(truth)),
    (error: unknown) =>
      error instanceof DomainValidationError &&
      /脚本与已确认的产品使用规则冲突/.test(error.message)
  );
});

test("usage compliance blocks a director plan that conflicts with a confirmed wearing rule", async () => {
  const truth = truthWithUsageRule();
  const service = new UsageComplianceService(
    new ComplianceRuntime({
      violations: [
        {
          ruleId: "usage-rule-wearing",
          description: "分镜展示了错误佩戴位置",
          evidence: "耳机位于耳道内"
        }
      ]
    })
  );

  await assert.rejects(
    service.assertPlan(truth, planFor(truth)),
    (error: unknown) =>
      error instanceof DomainValidationError &&
      /导演分镜与已确认的产品使用规则冲突/.test(error.message)
  );
});

test("usage compliance accepts content when the checker reports no conflict", async () => {
  const truth = truthWithUsageRule();
  const service = new UsageComplianceService(
    new ComplianceRuntime({ violations: [] })
  );
  await assert.doesNotReject(
    service.assertScript(truth, scriptFor(truth))
  );
});

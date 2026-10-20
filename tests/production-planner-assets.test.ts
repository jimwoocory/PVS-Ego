import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ArtifactRecord, AssetRef } from "../src/domain/schemas.js";
import type { ArtifactRepository, PendingArtifactInput } from "../src/application/ports/artifact-repository.js";
import type { StructuredAiRuntime } from "../src/application/ports/structured-ai-runtime.js";
import type { ProductionImageProvider } from "../src/application/ports/production-image-provider.js";
import { ProductionPlannerService } from "../src/application/services/production-planner.js";
import { ProductionAssetService } from "../src/application/services/production-asset-service.js";
import {
  ProductionImageSubmissionUnknownError,
  interpretDreaminaImageStatus
} from "../src/adapters/image/domestic-jimeng-image-provider.js";
import { sha256Bytes } from "../src/domain/hashing.js";
import {
  productionAssetSetSchema,
  productionStrategySchema
} from "../src/domain/production-strategy.js";
import { directorCase } from "./model-aware-fixtures.js";
import { H, ISO } from "./fixtures.js";

class MemoryArtifacts implements ArtifactRepository {
  records = new Map<string, ArtifactRecord>();
  async createPending(input: PendingArtifactInput) {
    const record: ArtifactRecord = {
      ...input,
      integrityStatus: "PENDING",
      createdAt: ISO
    };
    this.records.set(record.id, record);
    return structuredClone(record);
  }
  async markReady(id: string, fields: { sha256: string; sizeBytes: number; mimeType?: string }) {
    const old = this.records.get(id)!;
    const record: ArtifactRecord = {
      ...old,
      ...fields,
      integrityStatus: "READY"
    };
    this.records.set(id, record);
    return structuredClone(record);
  }
  async markMissing(id: string) {
    const old = this.records.get(id)!;
    const next = { ...old, integrityStatus: "MISSING" as const };
    this.records.set(id, next);
    return structuredClone(next);
  }
  async markCorrupt(id: string) {
    const old = this.records.get(id)!;
    const next = { ...old, integrityStatus: "CORRUPT" as const };
    this.records.set(id, next);
    return structuredClone(next);
  }
  async findById(id: string) {
    return structuredClone(this.records.get(id) ?? null);
  }
  async listByProject(projectId: string, kind?: ArtifactRecord["kind"]) {
    return structuredClone(
      [...this.records.values()].filter(
        item => item.projectId === projectId && (!kind || item.kind === kind)
      )
    );
  }
  async listPending() {
    return structuredClone(
      [...this.records.values()].filter(item => item.integrityStatus === "PENDING")
    );
  }
}

test("Dreamina querying with a finished queue is surfaced as a stale-result observation", () => {
  const status = interpretDreaminaImageStatus({
    gen_status: "querying",
    queue_info: {
      queue_status: "Finish",
      queue_idx: 0,
      queue_length: 0
    }
  });
  assert.deepEqual(status, {
    status: "PROCESSING",
    observation: "QUEUE_FINISHED_WITHOUT_RESULT"
  });
});

function productAsset(): AssetRef {
  return {
    id: "asset-1",
    artifactId: "artifact-product",
    type: "image",
    source: "user_upload",
    sha256: H.a,
    mimeType: "image/png",
    sizeBytes: 1000,
    createdAt: ISO
  };
}

test("Production Planner converts the selected creative into the minimum reusable asset plan and always locks the product", async () => {
  const c = directorCase();
  const runtime: StructuredAiRuntime = {
    id: "planner-test",
    version: "1",
    async generateJson() {
      return {
        contentType: "SHORT_DRAMA",
        summary: "两个固定室友在同一卧室完成三段连续剧情",
        rationale: [
          "两名室友跨镜头出现，需要固定人物身份",
          "卧室跨镜头复用，需要固定空间布局"
        ],
        assetRequirements: [
          {
            key: "CHARACTER_A",
            kind: "CHARACTER",
            label: "女主",
            description: "年轻成年女性，短发，灰色家居服",
            purpose: "跨镜头保持女主身份",
            required: true,
            reuseScope: "MULTI_CLIP",
            generationMode: "GENERATE_IMAGE",
            generationPrompt: "生成同一成年女主的中性角色身份参考图，无文字。",
            referenceAssetIds: [],
            clipCountHint: 3,
            confidence: "HIGH",
            needsReview: false
          },
          {
            key: "SET_A",
            kind: "SET",
            label: "合租卧室",
            description: "两张单人床并排的夜间合租卧室",
            purpose: "保持空间连续",
            required: true,
            reuseScope: "MULTI_CLIP",
            generationMode: "GENERATE_IMAGE",
            generationPrompt: "生成空的夜间合租卧室空间参考图，两张单人床并排，无人物无文字。",
            referenceAssetIds: [],
            clipCountHint: 3,
            confidence: "HIGH",
            needsReview: false
          }
        ]
      };
    }
  };
  const strategy = await new ProductionPlannerService(runtime).plan({
    projectId: c.input.productTruth.projectId,
    version: 1,
    truth: c.input.productTruth,
    creativeBatch: c.input.creativeBatch,
    selectedCreativeId: "creative-1",
    targetDurationMs: 15000
  });
  assert.equal(strategy.contentType, "SHORT_DRAMA");
  assert.equal(strategy.assetRequirements[0]!.key, "PRODUCT_MAIN");
  assert.equal(
    strategy.assetRequirements[0]!.generationMode,
    "REUSE_PRODUCT_REFERENCE"
  );
  assert.ok(strategy.assetRequirements.some(item => item.kind === "CHARACTER"));
  assert.ok(strategy.assetRequirements.some(item => item.kind === "SET"));
  assert.equal(
    strategy.assetRequirements.filter(item => item.kind === "PRODUCT").length,
    1
  );
});

test("Production Planner ignores blank generation prompts on reused product and reference assets", async () => {
  const c = directorCase();
  let calls = 0;
  const runtime: StructuredAiRuntime = {
    id: "planner-empty-reuse-test",
    version: "1",
    async generateJson() {
      calls += 1;
      return {
        contentType: "PRODUCT_DEMO",
        summary: "复用现有参考图",
        rationale: ["现有图片已足够"],
        assetRequirements: [
          {
            key: "PRODUCT_FROM_AI",
            kind: "PRODUCT",
            label: "原产品图",
            description: "产品现有外观",
            purpose: "统一产品身份",
            required: true,
            reuseScope: "RUN",
            generationMode: "REUSE_PRODUCT_REFERENCE",
            generationPrompt: "",
            referenceAssetIds: [c.input.productTruth.canonicalImageId],
            confidence: "HIGH",
            needsReview: false
          },
          {
            key: "SET_EXISTING",
            kind: "SET",
            label: "现有场景",
            description: "用现有素材作为场景参考",
            purpose: "确保场景一致",
            required: true,
            reuseScope: "MULTI_CLIP",
            generationMode: "REUSE_EXISTING_REFERENCE",
            generationPrompt: "   ",
            referenceAssetIds: [c.input.productTruth.canonicalImageId],
            confidence: "HIGH",
            needsReview: false
          }
        ]
      };
    }
  };
  const strategy = await new ProductionPlannerService(runtime).plan({
    projectId: c.input.productTruth.projectId,
    version: 1,
    truth: c.input.productTruth,
    creativeBatch: c.input.creativeBatch,
    selectedCreativeId: "creative-1",
    targetDurationMs: 15000
  });
  assert.equal(calls, 1, "reused images must never trigger prompt repair");
  assert.deepEqual(strategy.assetRequirements.map(item => item.key), ["PRODUCT_MAIN", "SET_EXISTING"]);
  assert.equal(strategy.assetRequirements[1]!.generationPrompt, undefined);
  assert.equal(strategy.assetRequirements[1]!.generationMode, "REUSE_EXISTING_REFERENCE");
});

test("Production Planner repairs a missing generated-image prompt once without changing the asset plan", async () => {
  const c = directorCase();
  let calls = 0;
  const runtime: StructuredAiRuntime = {
    id: "planner-prompt-repair-test",
    version: "1",
    async generateJson(request) {
      calls += 1;
      if (calls === 2) {
        assert.match(request.task, /missing image-generation prompts/);
        return { prompts: [{ key: "SET_A", generationPrompt: "生成空摄影棚参考图，固定灯光与空间，不显示文字。" }] };
      }
      return {
        contentType: "PRODUCT_DEMO",
        summary: "在固定摄影棚展示产品",
        rationale: ["摄影棚需要跨镜头保持一致"],
        assetRequirements: [{
          key: "SET_A",
          kind: "SET",
          label: "摄影棚",
          description: "固定白色摄影棚",
          purpose: "保持空间连续",
          required: true,
          reuseScope: "MULTI_CLIP",
          generationMode: "GENERATE_IMAGE",
          generationPrompt: " ",
          referenceAssetIds: [],
          confidence: "HIGH",
          needsReview: false
        }]
      };
    }
  };
  const strategy = await new ProductionPlannerService(runtime).plan({
    projectId: c.input.productTruth.projectId,
    version: 1,
    truth: c.input.productTruth,
    creativeBatch: c.input.creativeBatch,
    selectedCreativeId: "creative-1",
    targetDurationMs: 15000
  });
  assert.equal(calls, 2, "one planning request and one bounded missing-prompt repair");
  assert.deepEqual(strategy.assetRequirements.map(item => item.key), ["PRODUCT_MAIN", "SET_A"]);
  assert.equal(strategy.assetRequirements[1]!.generationPrompt, "生成空摄影棚参考图，固定灯光与空间，不显示文字。");
});

test("Production Planner reports a bounded Chinese failure when missing prompt repair is invalid", async () => {
  const c = directorCase();
  let calls = 0;
  const runtime: StructuredAiRuntime = {
    id: "planner-invalid-repair-test",
    version: "1",
    async generateJson() {
      calls += 1;
      if (calls === 2) return { prompts: [{ key: "WRONG_KEY", generationPrompt: "错误资产" }] };
      return {
        contentType: "PRODUCT_DEMO",
        summary: "产品介绍",
        rationale: ["固定场景"],
        assetRequirements: [{
          key: "SET_A",
          kind: "SET",
          label: "摄影棚",
          description: "空摄影棚",
          purpose: "场景连续",
          required: true,
          reuseScope: "MULTI_CLIP",
          generationMode: "GENERATE_IMAGE",
          generationPrompt: "",
          referenceAssetIds: [],
          confidence: "HIGH",
          needsReview: false
        }]
      };
    }
  };
  await assert.rejects(
    () => new ProductionPlannerService(runtime).plan({
      projectId: c.input.productTruth.projectId,
      version: 1,
      truth: c.input.productTruth,
      creativeBatch: c.input.creativeBatch,
      selectedCreativeId: "creative-1",
      targetDurationMs: 15000
    }),
    /制作资产生图提示词缺失：摄影棚.*自动补全但未成功/
  );
  assert.equal(calls, 2, "invalid repair must not loop");
});

test("Production Planner converts schema errors into a readable Chinese message", async () => {
  const c = directorCase();
  const runtime: StructuredAiRuntime = {
    id: "planner-invalid-schema-test",
    version: "1",
    async generateJson() {
      return {
        contentType: "PRODUCT_DEMO",
        summary: "",
        rationale: ["固定产品"],
        assetRequirements: []
      };
    }
  };
  await assert.rejects(
    () => new ProductionPlannerService(runtime).plan({
      projectId: c.input.productTruth.projectId,
      version: 1,
      truth: c.input.productTruth,
      creativeBatch: c.input.creativeBatch,
      selectedCreativeId: "creative-1",
      targetDurationMs: 15000
    }),
    /AI 返回的制作策略格式不符合要求（字段：summary）/
  );
});

test("Production Asset Set requires an explicit paid scope, persists generated identity art and never hides the product reference", async () => {
  const c = directorCase();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-production-assets-"));
  const artifacts = new MemoryArtifacts();
  let submits = 0;
  const provider: ProductionImageProvider = {
    id: "fixture-image-provider",
    async probe() {
      return { ready: true, providerVersion: "fixture" };
    },
    async submit() {
      submits += 1;
      return { submitId: "submit-character-1" };
    },
    async status() {
      return {
        status: "SUCCEEDED",
        imageUrl: "https://example.invalid/generated.jpg"
      };
    },
    async download(_url, outputPath) {
      const bytes = Buffer.from("fixture-image-bytes");
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, bytes);
      return {
        path: outputPath,
        sha256: sha256Bytes(bytes),
        sizeBytes: bytes.length,
        mimeType: "image/jpeg"
      };
    }
  };
  const reviewRuntime: StructuredAiRuntime = {
    id: "asset-review",
    version: "1",
    async generateJson() {
      return {
        status: "PASS",
        confidence: "HIGH",
        summary: "单一人物身份清晰，可跨镜头复用",
        identityLock: ["短发", "灰色家居服", "同一成年女性面部身份"]
      };
    }
  };
  const strategyBase = {
    id: "strategy-assets",
    projectId: c.input.productTruth.projectId,
    version: 1,
    selectedCreativeId: "creative-1",
    contentType: "SHORT_DRAMA" as const,
    summary: "固定女主",
    rationale: ["女主跨镜头"],
    assetRequirements: [
      {
        key: "PRODUCT_MAIN",
        kind: "PRODUCT" as const,
        label: "当前产品",
        description: "确认产品",
        purpose: "产品身份",
        required: true,
        reuseScope: "RUN" as const,
        generationMode: "REUSE_PRODUCT_REFERENCE" as const,
        referenceAssetIds: ["asset-1"],
        confidence: "HIGH" as const,
        needsReview: false
      },
      {
        key: "CHARACTER_A",
        kind: "CHARACTER" as const,
        label: "女主",
        description: "年轻成年女性，短发，灰色家居服",
        purpose: "跨镜头保持身份",
        required: true,
        reuseScope: "MULTI_CLIP" as const,
        generationMode: "GENERATE_IMAGE" as const,
        generationPrompt: "中性角色身份参考图，无文字。",
        referenceAssetIds: [],
        confidence: "HIGH" as const,
        needsReview: false
      }
    ],
    plannerVersion: "fixture",
    createdAt: ISO
  };
  const strategy = productionStrategySchema.parse({
    ...strategyBase,
    contentHash: H.f
  });
  const productInput = {
    id: "input-1",
    projectId: c.input.productTruth.projectId,
    version: 1,
    productName: "Test Product",
    featureDescription: "fixture",
    assets: [productAsset()],
    forbiddenChanges: [],
    contentHash: H.b,
    createdAt: ISO
  };
  const service = new ProductionAssetService(
    artifacts,
    provider,
    reviewRuntime,
    root
  );
  try {
    const prepared = await service.prepare({
      strategy,
      truth: c.input.productTruth,
      productInput
    });
    assert.equal(prepared.set.status, "PLANNED");
    assert.ok(prepared.paidScope);
    assert.equal(prepared.paidScope!.assets.length, 1);
    assert.equal(prepared.paidScope!.assets[0]!.key, "CHARACTER_A");
    assert.equal(submits, 0);
    await service.validatePaidScope({
      strategy,
      set: prepared.set,
      scope: prepared.paidScope!
    });
    let set = await service.advance({
      set: prepared.set,
      strategy,
      productInput
    });
    assert.equal(set.entries.find(item => item.key === "CHARACTER_A")!.status, "SUBMITTED");
    assert.equal(submits, 1);
    set = await service.advance({ set, strategy, productInput });
    assert.equal(set.status, "NEEDS_REVIEW");
    assert.equal(submits, 1);
    let character = set.entries.find(item => item.key === "CHARACTER_A")!;
    assert.equal(character.status, "NEEDS_REVIEW");
    assert.equal(character.artifactIds[0], character.referenceAssetId);
    set = service.acceptReview(set, "CHARACTER_A");
    assert.equal(set.status, "READY");
    character = set.entries.find(item => item.key === "CHARACTER_A")!;
    assert.ok(character.humanConfirmedAt);
    assert.equal(
      set.entries.find(item => item.key === "PRODUCT_MAIN")!.referenceAssetId,
      "asset-1"
    );
    const refs = await service.toAssetRefs(set);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.id, character.referenceAssetId);
    // Local redo of the selected clip must not require an unrelated clip's
    // failed/missing image, while an unscoped production remains strict.
    const unrelatedMissing = {
      ...set,
      entries: [
        ...set.entries,
        {
          ...character,
          key: "CHARACTER_B",
          referenceAssetId: "production-asset:unrelated:CHARACTER_B",
          artifactIds: ["not-downloaded"]
        }
      ]
    };
    const scopedRefs = await service.toAssetRefs(
      unrelatedMissing, new Set([character.referenceAssetId])
    );
    assert.deepEqual(scopedRefs.map(ref => ref.id), [character.referenceAssetId]);
    await assert.rejects(
      service.toAssetRefs(unrelatedMissing),
      /制作资产文件不可用/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("unknown production-asset submission is never automatically resubmitted", async () => {
  const c = directorCase();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-production-assets-unknown-"));
  const artifacts = new MemoryArtifacts();
  let submits = 0;
  const provider: ProductionImageProvider = {
    id: "fixture-image-provider",
    async probe() { return { ready: true }; },
    async submit() {
      submits += 1;
      throw new ProductionImageSubmissionUnknownError("network lost after submit");
    },
    async status() {
      throw new Error("must not poll without submit id");
    },
    async download() {
      throw new Error("must not download");
    }
  };
  const runtime: StructuredAiRuntime = {
    id: "unused",
    version: "1",
    async generateJson() {
      throw new Error("unused");
    }
  };
  const strategyBase = {
    id: "strategy-unknown",
    projectId: c.input.productTruth.projectId,
    version: 1,
    selectedCreativeId: "creative-1",
    contentType: "SHORT_DRAMA" as const,
    summary: "固定女主",
    rationale: ["跨镜头"],
    assetRequirements: [
      {
        key: "PRODUCT_MAIN",
        kind: "PRODUCT" as const,
        label: "当前产品",
        description: "确认产品",
        purpose: "产品身份",
        required: true,
        reuseScope: "RUN" as const,
        generationMode: "REUSE_PRODUCT_REFERENCE" as const,
        referenceAssetIds: ["asset-1"],
        confidence: "HIGH" as const,
        needsReview: false
      },
      {
        key: "CHARACTER_A",
        kind: "CHARACTER" as const,
        label: "女主",
        description: "固定人物",
        purpose: "连续性",
        required: true,
        reuseScope: "MULTI_CLIP" as const,
        generationMode: "GENERATE_IMAGE" as const,
        generationPrompt: "角色参考图",
        referenceAssetIds: [],
        confidence: "HIGH" as const,
        needsReview: false
      }
    ],
    plannerVersion: "fixture",
    createdAt: ISO
  };
  const strategy = productionStrategySchema.parse({
    ...strategyBase,
    contentHash: H.f
  });
  const productInput = {
    id: "input-1",
    projectId: c.input.productTruth.projectId,
    version: 1,
    productName: "Test Product",
    featureDescription: "fixture",
    assets: [productAsset()],
    forbiddenChanges: [],
    contentHash: H.b,
    createdAt: ISO
  };
  const service = new ProductionAssetService(artifacts, provider, runtime, root);
  try {
    const prepared = await service.prepare({
      strategy,
      truth: c.input.productTruth,
      productInput
    });
    let set = await service.advance({
      set: prepared.set,
      strategy,
      productInput
    });
    assert.equal(set.status, "FAILED");
    assert.equal(
      set.entries.find(item => item.key === "CHARACTER_A")!.status,
      "SUBMISSION_UNKNOWN"
    );
    assert.equal(submits, 1);
    set = await service.advance({ set, strategy, productInput });
    assert.equal(submits, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("finished Dreamina queue without an image becomes explicit stale state and requires fresh paid scope before retry", async () => {
  const c = directorCase();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-production-assets-stale-"));
  const artifacts = new MemoryArtifacts();
  let submits = 0;
  const provider: ProductionImageProvider = {
    id: "fixture-image-provider",
    async probe() { return { ready: true }; },
    async submit() { submits += 1; return { submitId: "unexpected-new-submit" }; },
    async status() {
      return {
        status: "PROCESSING",
        observation: "QUEUE_FINISHED_WITHOUT_RESULT"
      };
    },
    async download() { throw new Error("must not download"); }
  };
  const runtime: StructuredAiRuntime = {
    id: "unused",
    version: "1",
    async generateJson() { throw new Error("unused"); }
  };
  const strategy = productionStrategySchema.parse({
    id: "strategy-stale",
    projectId: c.input.productTruth.projectId,
    version: 1,
    selectedCreativeId: "creative-1",
    contentType: "SHORT_DRAMA",
    summary: "固定女主",
    rationale: ["跨镜头"],
    assetRequirements: [
      {
        key: "PRODUCT_MAIN", kind: "PRODUCT", label: "当前产品", description: "确认产品", purpose: "产品身份", required: true,
        reuseScope: "RUN", generationMode: "REUSE_PRODUCT_REFERENCE", referenceAssetIds: ["asset-1"], confidence: "HIGH", needsReview: false
      },
      {
        key: "CHARACTER_A", kind: "CHARACTER", label: "女主", description: "固定人物", purpose: "连续性", required: true,
        reuseScope: "MULTI_CLIP", generationMode: "GENERATE_IMAGE", generationPrompt: "角色参考图", referenceAssetIds: [], confidence: "HIGH", needsReview: false
      }
    ],
    plannerVersion: "fixture",
    contentHash: H.f,
    createdAt: ISO
  });
  const set = productionAssetSetSchema.parse({
    id: "asset-set-stale",
    projectId: c.input.productTruth.projectId,
    version: 1,
    strategyRef: { entityType: "ProductionStrategy", entityId: strategy.id, version: strategy.version, hash: strategy.contentHash },
    selectedCreativeId: "creative-1",
    status: "PREPARING",
    entries: [
      {
        key: "PRODUCT_MAIN", referenceAssetId: "asset-1", kind: "PRODUCT", label: "当前产品", description: "确认产品", purpose: "产品身份", required: true,
        reuseScope: "RUN", source: "PRODUCT_INPUT", status: "READY", artifactIds: ["artifact-product"], sourceReferenceAssetIds: ["asset-1"], identityLock: ["保持产品身份"], confidence: "HIGH"
      },
      {
        key: "CHARACTER_A", referenceAssetId: "production-asset:asset-set-stale:CHARACTER_A", kind: "CHARACTER", label: "女主", description: "固定人物", purpose: "连续性", required: true,
        reuseScope: "MULTI_CLIP", source: "DREAMINA_GENERATED", status: "PROCESSING", artifactIds: [], sourceReferenceAssetIds: [], identityLock: ["固定人物"],
        generationPrompt: "角色参考图", generationRequestHash: H.c, submitId: "submit-stale", submittedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        queueFinishedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString()
      }
    ],
    contentHash: H.e,
    createdAt: ISO,
    updatedAt: ISO
  });
  const productInput = {
    id: "input-1", projectId: c.input.productTruth.projectId, version: 1, productName: "Test Product", featureDescription: "fixture",
    assets: [productAsset()], forbiddenChanges: [], contentHash: H.b, createdAt: ISO
  };
  const service = new ProductionAssetService(artifacts, provider, runtime, root);
  try {
    const stale = await service.advance({ set, strategy, productInput });
    const entry = stale.entries.find(item => item.key === "CHARACTER_A")!;
    assert.equal(stale.status, "FAILED");
    assert.equal(entry.status, "SUBMISSION_UNKNOWN");
    assert.equal(entry.errorCode, "ASSET_REMOTE_RESULT_STALE");
    assert.equal(entry.submitId, "submit-stale");
    assert.equal(submits, 0);

    const retried = service.retryUnknown(stale, strategy, "CHARACTER_A");
    const reset = retried.set.entries.find(item => item.key === "CHARACTER_A")!;
    assert.equal(retried.set.status, "PLANNED");
    assert.equal(reset.status, "PLANNED");
    assert.equal(reset.submitId, undefined);
    assert.equal(reset.queueFinishedAt, undefined);
    assert.ok(retried.paidScope.authorizationNonce);
    assert.equal(retried.paidScope.assets.some(item => item.key === "CHARACTER_A"), true);
    assert.equal(submits, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

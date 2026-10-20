import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ArtifactRecord, AssetRef } from "../src/domain/schemas.js";
import type { ArtifactRepository, PendingArtifactInput } from "../src/application/ports/artifact-repository.js";
import type { StructuredAiRuntime } from "../src/application/ports/structured-ai-runtime.js";
import type { ProductionImageProvider } from "../src/application/ports/production-image-provider.js";
import { ProductionAssetService } from "../src/application/services/production-asset-service.js";
import { productionAssetSetSchema, productionStrategySchema } from "../src/domain/production-strategy.js";
import { sha256Bytes } from "../src/domain/hashing.js";
import { directorCase } from "./model-aware-fixtures.js";
import { H, ISO } from "./fixtures.js";

class MemoryArtifacts implements ArtifactRepository {
  records = new Map<string, ArtifactRecord>();
  async createPending(input: PendingArtifactInput) {
    const record: ArtifactRecord = { ...input, integrityStatus: "PENDING", createdAt: ISO };
    this.records.set(record.id, record);
    return structuredClone(record);
  }
  async markReady(id: string, fields: { sha256: string; sizeBytes: number; mimeType?: string }) {
    const record: ArtifactRecord = { ...this.records.get(id)!, ...fields, integrityStatus: "READY" };
    this.records.set(id, record);
    return structuredClone(record);
  }
  async markMissing(id: string) {
    const record = { ...this.records.get(id)!, integrityStatus: "MISSING" as const };
    this.records.set(id, record);
    return structuredClone(record);
  }
  async markCorrupt(id: string) {
    const record = { ...this.records.get(id)!, integrityStatus: "CORRUPT" as const };
    this.records.set(id, record);
    return structuredClone(record);
  }
  async findById(id: string) { return structuredClone(this.records.get(id) ?? null); }
  async listByProject(projectId: string, kind?: ArtifactRecord["kind"]) {
    return structuredClone([...this.records.values()].filter(item => item.projectId === projectId && (!kind || item.kind === kind)));
  }
  async listPending() {
    return structuredClone([...this.records.values()].filter(item => item.integrityStatus === "PENDING"));
  }
}

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

function productInput(projectId: string) {
  return {
    id: "input-1",
    projectId,
    version: 1,
    productName: "Test Product",
    featureDescription: "fixture",
    assets: [productAsset()],
    forbiddenChanges: [],
    contentHash: H.b,
    createdAt: ISO
  };
}

const reviewRuntime: StructuredAiRuntime = {
  id: "asset-review",
  version: "1",
  async generateJson() {
    return {
      status: "PASS",
      confidence: "HIGH",
      summary: "画面可作为固定参考，但仍需用户确认",
      identityLock: ["空间结构稳定"]
    };
  }
};

test("independent production assets submit concurrently and every generated image stops for human review", async () => {
  const c = directorCase();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-production-assets-parallel-"));
  const artifacts = new MemoryArtifacts();
  let inFlight = 0;
  let maxInFlight = 0;
  const submittedKeys: string[] = [];
  const provider: ProductionImageProvider = {
    id: "fixture-parallel-provider",
    async probe() { return { ready: true }; },
    async submit(input) {
      submittedKeys.push(input.businessKey);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 15));
      inFlight -= 1;
      return { submitId: "submit-" + input.businessKey };
    },
    async status() {
      return { status: "SUCCEEDED", imageUrl: "https://example.invalid/generated.jpg" };
    },
    async download(_url, outputPath) {
      const bytes = Buffer.from("parallel-image-" + outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, bytes);
      return { path: outputPath, sha256: sha256Bytes(bytes), sizeBytes: bytes.length, mimeType: "image/jpeg" };
    }
  };
  const strategy = productionStrategySchema.parse({
    id: "strategy-parallel",
    projectId: c.input.productTruth.projectId,
    version: 1,
    selectedCreativeId: "creative-1",
    contentType: "SHORT_DRAMA",
    summary: "两个互不相关的固定场景",
    rationale: ["场景独立，可并行生成"],
    assetRequirements: [
      {
        key: "PRODUCT_MAIN", kind: "PRODUCT", label: "当前产品", description: "确认产品", purpose: "产品身份", required: true,
        reuseScope: "RUN", generationMode: "REUSE_PRODUCT_REFERENCE", referenceAssetIds: ["asset-1"], confidence: "HIGH", needsReview: false
      },
      {
        key: "SET_A", kind: "SET", label: "办公室", description: "空办公室", purpose: "第一幕", required: true,
        reuseScope: "MULTI_CLIP", generationMode: "GENERATE_IMAGE", generationPrompt: "空办公室，无人物无文字", referenceAssetIds: [], dependsOnAssetKeys: [], confidence: "HIGH", needsReview: false
      },
      {
        key: "SET_B", kind: "SET", label: "卧室", description: "空卧室", purpose: "第二幕", required: true,
        reuseScope: "MULTI_CLIP", generationMode: "GENERATE_IMAGE", generationPrompt: "空卧室，无人物无文字", referenceAssetIds: [], dependsOnAssetKeys: [], confidence: "HIGH", needsReview: false
      }
    ],
    plannerVersion: "fixture",
    contentHash: H.f,
    createdAt: ISO
  });
  const input = productInput(c.input.productTruth.projectId);
  const service = new ProductionAssetService(artifacts, provider, reviewRuntime, root);
  try {
    const prepared = await service.prepare({ strategy, truth: c.input.productTruth, productInput: input });
    let set = await service.advance({ set: prepared.set, strategy, productInput: input });
    assert.deepEqual([...submittedKeys].sort(), ["SET_A", "SET_B"]);
    assert.equal(maxInFlight, 2);
    assert.equal(set.entries.find(item => item.key === "SET_A")!.status, "SUBMITTED");
    assert.equal(set.entries.find(item => item.key === "SET_B")!.status, "SUBMITTED");

    set = await service.advance({ set, strategy, productInput: input });
    assert.equal(set.status, "NEEDS_REVIEW");
    assert.equal(set.entries.find(item => item.key === "SET_A")!.status, "NEEDS_REVIEW");
    assert.equal(set.entries.find(item => item.key === "SET_B")!.status, "NEEDS_REVIEW");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("dependent production assets wait for a human-confirmed upstream image and use it as generation reference", async () => {
  const c = directorCase();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-production-assets-dependent-"));
  const artifacts = new MemoryArtifacts();
  const submitted: Array<{ key: string; refs: string[] }> = [];
  const provider: ProductionImageProvider = {
    id: "fixture-dependent-provider",
    async probe() { return { ready: true }; },
    async submit(input) {
      submitted.push({ key: input.businessKey, refs: [...(input.referenceImagePaths ?? [])] });
      return { submitId: "submit-" + input.businessKey };
    },
    async status() {
      return { status: "SUCCEEDED", imageUrl: "https://example.invalid/generated.jpg" };
    },
    async download(_url, outputPath) {
      const bytes = Buffer.from("dependent-image-" + outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, bytes);
      return { path: outputPath, sha256: sha256Bytes(bytes), sizeBytes: bytes.length, mimeType: "image/jpeg" };
    }
  };
  const strategy = productionStrategySchema.parse({
    id: "strategy-dependent",
    projectId: c.input.productTruth.projectId,
    version: 1,
    selectedCreativeId: "creative-1",
    contentType: "SHORT_DRAMA",
    summary: "后续场景依赖前置场景",
    rationale: ["子资产需要继承父资产视觉"],
    assetRequirements: [
      {
        key: "PRODUCT_MAIN", kind: "PRODUCT", label: "当前产品", description: "确认产品", purpose: "产品身份", required: true,
        reuseScope: "RUN", generationMode: "REUSE_PRODUCT_REFERENCE", referenceAssetIds: ["asset-1"], confidence: "HIGH", needsReview: false
      },
      {
        key: "SET_PARENT", kind: "SET", label: "主场景", description: "主场景", purpose: "空间基准", required: true,
        reuseScope: "MULTI_CLIP", generationMode: "GENERATE_IMAGE", generationPrompt: "主场景", referenceAssetIds: [], dependsOnAssetKeys: [], confidence: "HIGH", needsReview: false
      },
      {
        key: "SET_CHILD", kind: "SET", label: "关联角度", description: "同一空间的关联角度", purpose: "延续主场景", required: true,
        reuseScope: "MULTI_CLIP", generationMode: "GENERATE_IMAGE", generationPrompt: "保持主场景结构的另一角度", referenceAssetIds: [], dependsOnAssetKeys: ["SET_PARENT"], confidence: "HIGH", needsReview: false
      }
    ],
    plannerVersion: "fixture",
    contentHash: H.f,
    createdAt: ISO
  });
  const input = productInput(c.input.productTruth.projectId);
  const service = new ProductionAssetService(artifacts, provider, reviewRuntime, root);
  try {
    const prepared = await service.prepare({ strategy, truth: c.input.productTruth, productInput: input });
    let set = await service.advance({ set: prepared.set, strategy, productInput: input });
    assert.deepEqual(submitted.map(item => item.key), ["SET_PARENT"]);
    assert.equal(set.entries.find(item => item.key === "SET_CHILD")!.status, "PLANNED");

    set = await service.advance({ set, strategy, productInput: input });
    assert.equal(set.entries.find(item => item.key === "SET_PARENT")!.status, "NEEDS_REVIEW");
    assert.equal(set.entries.find(item => item.key === "SET_CHILD")!.status, "PLANNED");

    set = service.acceptReview(set, "SET_PARENT");
    set = await service.advance({ set, strategy, productInput: input });
    assert.deepEqual(submitted.map(item => item.key), ["SET_PARENT", "SET_CHILD"]);
    const childSubmit = submitted.find(item => item.key === "SET_CHILD")!;
    assert.equal(childSubmit.refs.length, 1);
    assert.match(childSubmit.refs[0]!, /production-assets/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("previously failed result is recovered from its submit ID; other in-flight image is preserved and visual QA may fall back to human review", async () => {
  const c = directorCase();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-asset-recover-existing-"));
  const artifacts = new MemoryArtifacts();
  const submitted: string[] = [];
  const queried: string[] = [];
  const provider: ProductionImageProvider = {
    id: "fixture-recover-provider",
    async probe() { return { ready: true }; },
    async submit(input) {
      submitted.push(input.businessKey);
      return { submitId: "original-" + input.businessKey };
    },
    async status(id) {
      queried.push(id);
      return { status: "SUCCEEDED", imageUrl: "https://example.invalid/saved.png" };
    },
    async download(_url, outputPath) {
      const bytes = Buffer.from("fixture-image-" + outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, bytes);
      return { path: outputPath, sha256: sha256Bytes(bytes), sizeBytes: bytes.length, mimeType: "image/png" };
    }
  };
  const runtime: StructuredAiRuntime = {
    id: "optional-image-qa",
    version: "1",
    async generateJson(request) {
      if ((request.input as { label?: string }).label === "商场") {
        throw new Error("terminated");
      }
      return { status: "PASS", confidence: "HIGH", summary: "人物清晰，待用户确认", identityLock: ["人物身份一致"] };
    }
  };
  const strategy = productionStrategySchema.parse({
    id: "strategy-recover-original", projectId: c.input.productTruth.projectId, version: 1, selectedCreativeId: "creative-1",
    contentType: "SHORT_DRAMA", summary: "独立生成", rationale: ["独立人物和场景"],
    assetRequirements: [
      { key: "PRODUCT_MAIN", kind: "PRODUCT", label: "产品", description: "已确认", purpose: "产品连续", required: true,
        reuseScope: "RUN", generationMode: "REUSE_PRODUCT_REFERENCE", referenceAssetIds: ["asset-1"], confidence: "HIGH", needsReview: false },
      { key: "CHARACTER_B", kind: "CHARACTER", label: "闺蜜B", description: "固定成年女性", purpose: "人物连续", required: true,
        reuseScope: "MULTI_CLIP", generationMode: "GENERATE_IMAGE", generationPrompt: "人物参考", referenceAssetIds: [], confidence: "HIGH", needsReview: false },
      { key: "SET_A", kind: "SET", label: "商场", description: "室内休息区", purpose: "场景连续", required: true,
        reuseScope: "MULTI_CLIP", generationMode: "GENERATE_IMAGE", generationPrompt: "商场室内场景", referenceAssetIds: [], confidence: "HIGH", needsReview: false }
    ],
    plannerVersion: "fixture", contentHash: H.f, createdAt: ISO
  });
  const input = productInput(strategy.projectId);
  const service = new ProductionAssetService(artifacts, provider, runtime, root);
  try {
    const prepared = await service.prepare({ strategy, truth: c.input.productTruth, productInput: input });
    const submittedSet = await service.advance({ set: prepared.set, strategy, productInput: input });
    assert.deepEqual([...submitted].sort(), ["CHARACTER_B", "SET_A"]);
    const originalId = submittedSet.entries.find(item => item.key === "SET_A")!.submitId;
    const failed = productionAssetSetSchema.parse({
      ...submittedSet,
      status: "FAILED",
      contentHash: H.e,
      entries: submittedSet.entries.map(item =>
        item.key === "SET_A" ? {
          ...item, status: "FAILED", errorCode: "ASSET_RESULT_PROCESSING_FAILED", errorMessage: "terminated"
        } : item
      )
    });
    const recovered = service.recoverResultProcessing(failed);
    const setAfterRecover = recovered.entries.find(item => item.key === "SET_A")!;
    assert.equal(setAfterRecover.status, "PROCESSING");
    assert.equal(setAfterRecover.submitId, originalId);
    assert.equal(recovered.status, "PREPARING");
    assert.equal(service.recoverResultProcessing(recovered).contentHash, recovered.contentHash);
    const finished = await service.advance({ set: recovered, strategy, productInput: input });
    assert.deepEqual([...submitted].sort(), ["CHARACTER_B", "SET_A"], "no duplicate paid submit");
    assert.deepEqual([...queried].sort(), ["original-CHARACTER_B", "original-SET_A"]);
    const b = finished.entries.find(item => item.key === "CHARACTER_B")!;
    const scene = finished.entries.find(item => item.key === "SET_A")!;
    assert.equal(b.status, "NEEDS_REVIEW");
    assert.equal(scene.status, "NEEDS_REVIEW");
    assert.equal(scene.confidence, "LOW");
    assert.equal(scene.errorCode, "ASSET_VISUAL_REVIEW_UNAVAILABLE");
    assert.equal(scene.artifactIds.length, 1, "generated image saved before QA fallback");
    assert.equal(scene.humanConfirmedAt, undefined, "AI fallback never impersonates human approval");
    assert.equal(finished.status, "NEEDS_REVIEW");
    assert.equal(artifacts.records.get(scene.referenceAssetId)?.integrityStatus, "READY");
    const cannotRecover = productionAssetSetSchema.parse({
      ...failed, contentHash: H.d,
      entries: failed.entries.map(item => item.key === "SET_A"
        ? { ...item, errorCode: "ASSET_REMOTE_FAILED" }
        : item)
    });
    assert.equal(service.recoverResultProcessing(cannotRecover).contentHash, cannotRecover.contentHash);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("temporary result download failures retry original submit then require safe explicit recovery without resubmitting", async () => {
  const c = directorCase();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-asset-retry-result-"));
  const artifacts = new MemoryArtifacts();
  let submits = 0;
  let polls = 0;
  let downloads = 0;
  const provider: ProductionImageProvider = {
    id: "fixture-result-fail",
    async probe() { return { ready: true }; },
    async submit() { submits++; return { submitId: "original-existing-asset" }; },
    async status(id) {
      assert.equal(id, "original-existing-asset");
      polls++;
      return { status: "SUCCEEDED", imageUrl: "https://example.invalid/original-image.png" };
    },
    async download() { downloads++; throw new Error("terminated"); }
  };
  const strategy = productionStrategySchema.parse({
    id: "strategy-result-retry", projectId: c.input.productTruth.projectId, version: 1, selectedCreativeId: "creative-1",
    contentType: "PRODUCT_DEMO", summary: "固定单一场景", rationale: ["场景一致"],
    assetRequirements: [
      { key: "PRODUCT_MAIN", kind: "PRODUCT", label: "产品", description: "已确认", purpose: "产品身份", required: true,
        reuseScope: "RUN", generationMode: "REUSE_PRODUCT_REFERENCE", referenceAssetIds: ["asset-1"], confidence: "HIGH", needsReview: false },
      { key: "SET_A", kind: "SET", label: "室内", description: "固定场景", purpose: "连续", required: true,
        reuseScope: "MULTI_CLIP", generationMode: "GENERATE_IMAGE", generationPrompt: "室内参考", referenceAssetIds: [], confidence: "HIGH", needsReview: false }
    ],
    plannerVersion: "fixture", contentHash: H.f, createdAt: ISO
  });
  const input = productInput(strategy.projectId);
  const service = new ProductionAssetService(artifacts, provider, reviewRuntime, root);
  try {
    let set = (await service.prepare({ strategy, truth: c.input.productTruth, productInput: input })).set;
    set = await service.advance({ set, strategy, productInput: input });
    assert.equal(submits, 1);
    for (let attempt = 1; attempt <= 3; attempt++) {
      set = await service.advance({ set, strategy, productInput: input });
      const entry = set.entries.find(item => item.key === "SET_A")!;
      assert.equal(entry.resultReceiveFailures, attempt);
      assert.equal(entry.status, attempt === 3 ? "FAILED" : "PROCESSING");
    }
    assert.equal(submits, 1);
    assert.equal(downloads, 3);
    assert.equal(polls, 3);
    const reset = service.recoverResultProcessing(set);
    const entry = reset.entries.find(item => item.key === "SET_A")!;
    assert.equal(entry.status, "PROCESSING");
    assert.equal(entry.submitId, "original-existing-asset");
    assert.equal(entry.resultReceiveFailures, 0);
    assert.equal(submits, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy generated READY assets return to review unless an explicit user confirmation is recorded", () => {
  const service = new ProductionAssetService(
    new MemoryArtifacts(),
    {} as ProductionImageProvider,
    {} as StructuredAiRuntime,
    "C:\\unused"
  );
  const set = productionAssetSetSchema.parse({
    id: "legacy-set",
    projectId: "project-1",
    version: 1,
    strategyRef: { entityType: "ProductionStrategy", entityId: "strategy-1", version: 1, hash: H.a },
    selectedCreativeId: "creative-1",
    status: "READY",
    entries: [
      {
        key: "SET_CONFIRMED", referenceAssetId: "production-asset:confirmed", kind: "SET", label: "已确认场景",
        description: "已确认", purpose: "连续性", required: true, reuseScope: "MULTI_CLIP", source: "DREAMINA_GENERATED",
        status: "READY", artifactIds: ["artifact-confirmed"], sourceReferenceAssetIds: [], identityLock: ["稳定"],
        generationPrompt: "已确认场景", generationRequestHash: H.b, reviewSummary: "自动检查完成；用户已明确确认用于本轮生产"
      },
      {
        key: "SET_AUTO", referenceAssetId: "production-asset:auto", kind: "SET", label: "旧自动场景",
        description: "旧自动采用", purpose: "连续性", required: true, reuseScope: "MULTI_CLIP", source: "DREAMINA_GENERATED",
        status: "READY", artifactIds: ["artifact-auto"], sourceReferenceAssetIds: [], identityLock: ["稳定"],
        generationPrompt: "旧自动场景", generationRequestHash: H.c, reviewSummary: "自动检查高置信通过"
      }
    ],
    contentHash: H.d,
    createdAt: ISO,
    updatedAt: ISO
  });
  const reconciled = service.reconcileHumanReview(set);
  assert.equal(reconciled.status, "NEEDS_REVIEW");
  const confirmed = reconciled.entries.find(item => item.key === "SET_CONFIRMED")!;
  const auto = reconciled.entries.find(item => item.key === "SET_AUTO")!;
  assert.equal(confirmed.status, "READY");
  assert.ok(confirmed.humanConfirmedAt);
  assert.equal(auto.status, "NEEDS_REVIEW");
  assert.equal(auto.humanConfirmedAt, undefined);
});

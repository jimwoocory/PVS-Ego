import test from "node:test";
import assert from "node:assert/strict";
import type {
  CommitVersionInput,
  ProductFlowRepository,
  ProjectPointerPatch,
  StoredVersionInput,
  VersionedEntityType
} from "../src/application/ports/product-flow-repository.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import type {
  CreativeBatch,
  ProductTruth,
  ProductionPlan,
  Project,
  ScriptDraft
} from "../src/domain/schemas.js";
import { DomainValidationError } from "../src/domain/validation.js";
import { H, ISO, makeProductTruth, makeValidClip } from "./fixtures.js";

type Stored = StoredVersionInput;

class MemoryProductFlowRepository implements ProductFlowRepository {
  project: Project | null = null;
  versions = new Map<string, Stored>();

  private key(type: string, id: string, version: number) {
    return `${type}:${id}:${version}`;
  }

  async createProject(project: Project): Promise<Project> {
    this.project = structuredClone(project);
    return structuredClone(project);
  }

  async listProjects(): Promise<Project[]> {
    return this.project ? [structuredClone(this.project)] : [];
  }

  async getProject(projectId: string): Promise<Project | null> {
    return this.project?.id === projectId ? structuredClone(this.project) : null;
  }

  async nextVersion(
    projectId: string,
    entityType: VersionedEntityType,
    entityKey: string
  ): Promise<number> {
    const versions = [...this.versions.values()]
      .filter(
        (item) =>
          item.projectId === projectId &&
          item.entityType === entityType &&
          item.entityKey === entityKey
      )
      .map((item) => item.version);
    return (versions.length ? Math.max(...versions) : 0) + 1;
  }

  async getVersion<T>(
    projectId: string,
    entityType: VersionedEntityType,
    id: string,
    version: number
  ): Promise<T | null> {
    const item = this.versions.get(this.key(entityType, id, version));
    if (!item || item.projectId !== projectId) return null;
    return structuredClone(item.data) as T;
  }

  async commitVersion(input: CommitVersionInput): Promise<Project> {
    if (!this.project || this.project.id !== input.version.projectId) throw new Error("project missing");
    for (const item of this.versions.values()) {
      if (
        item.projectId === input.version.projectId &&
        input.staleEntityTypes.includes(item.entityType) &&
        item.status !== "STALE"
      ) {
        item.status = "STALE";
        if (typeof item.data === "object" && item.data) {
          (item.data as Record<string, unknown>).status = "STALE";
        }
      }
    }
    this.versions.set(
      this.key(input.version.entityType, input.version.id, input.version.version),
      structuredClone(input.version)
    );
    this.project = applyPatch(this.project, input.projectPatch);
    return structuredClone(this.project);
  }

  async commitProjectUpdate(
    projectId: string,
    staleEntityTypes: readonly VersionedEntityType[],
    patch: ProjectPointerPatch
  ): Promise<Project> {
    if (!this.project || this.project.id !== projectId) throw new Error("project missing");
    for (const item of this.versions.values()) {
      if (
        item.projectId === projectId &&
        staleEntityTypes.includes(item.entityType) &&
        item.status !== "STALE"
      ) {
        item.status = "STALE";
        if (typeof item.data === "object" && item.data) {
          (item.data as Record<string, unknown>).status = "STALE";
        }
      }
    }
    this.project = applyPatch(this.project, patch);
    return structuredClone(this.project);
  }
}

function applyPatch(project: Project, patch: ProjectPointerPatch): Project {
  const next = structuredClone(project);
  if (patch.status !== undefined) next.status = patch.status;
  const fields = [
    "currentProductTruthRef",
    "currentCreativeBatchRef",
    "currentScriptRef",
    "currentProductionPlanRef"
  ] as const;
  for (const field of fields) {
    const value = patch[field];
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  if (patch.selectedCreativeId === null) delete next.selectedCreativeId;
  else if (patch.selectedCreativeId !== undefined) next.selectedCreativeId = patch.selectedCreativeId;
  next.updatedAt = ISO;
  return next;
}

function makeProject(): Project {
  return {
    id: "project-1",
    name: "Test project",
    status: "DRAFT",
    targetPlatform: "douyin",
    targetDurationMs: 60000,
    aspectRatio: "9:16",
    createdAt: ISO,
    updatedAt: ISO
  };
}

function truthRef(truth: ProductTruth) {
  return {
    entityType: "ProductTruth",
    entityId: truth.id,
    version: truth.version,
    hash: truth.contentHash
  };
}

function makeCreativeBatch(truth: ProductTruth): CreativeBatch {
  const concepts = Array.from({ length: 4 }, (_, index) => ({
    id: `creative-${index + 1}`,
    title: `Concept ${index + 1}`,
    targetAudience: "buyers",
    painPoint: "need",
    hook: "hook",
    coreSellingPoint: "Feature one",
    narrativePattern: "problem-solution",
    expectedDurationMs: 60000,
    productShowcaseStrategy: "hero",
    generationRisk: "LOW" as const,
    requiredFactIds: ["fact-1"]
  }));
  return {
    id: "creative-batch-1",
    projectId: truth.projectId,
    version: 1,
    status: "ACTIVE",
    productTruthRef: truthRef(truth),
    generatorVersion: "test-v1",
    concepts,
    contentHash: H.b,
    createdAt: ISO
  };
}

function makeScript(truth: ProductTruth, batch: CreativeBatch): ScriptDraft {
  return {
    id: "script-1",
    projectId: truth.projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: truthRef(truth),
    creativeBatchRef: {
      entityType: "CreativeBatch",
      entityId: batch.id,
      version: batch.version,
      hash: batch.contentHash
    },
    selectedCreativeId: "creative-1",
    targetDurationMs: 60000,
    beats: [
      {
        id: "beat-1",
        order: 1,
        purpose: "PRODUCT",
        text: "Feature one",
        estimatedDurationMs: 60000,
        requiredFactIds: ["fact-1"]
      }
    ],
    contentHash: H.c,
    confirmedAt: ISO
  };
}

function makePlan(truth: ProductTruth, script: ScriptDraft): ProductionPlan {
  const clip = makeValidClip();
  clip.requiredFactIds = ["fact-1"];
  clip.sourceBeatIds = ["beat-1"];
  for (const segment of clip.segments) {
    segment.requiredFactIds = ["fact-1"];
    segment.sourceBeatIds = ["beat-1"];
  }
  return {
    id: "plan-1",
    projectId: truth.projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: truthRef(truth),
    scriptRef: {
      entityType: "ScriptDraft",
      entityId: script.id,
      version: script.version,
      hash: script.contentHash
    },
    selectedCreativeId: script.selectedCreativeId,
    visualDirection: "clean studio",
    soundDirection: "clear narration",
    productShowcaseRules: ["show product"],
    continuityLock: {
      product: {
        stableAttributes: ["logo"],
        forbiddenChanges: structuredClone(truth.forbiddenChanges)
      },
      characters: [],
      environments: [{ sceneId: "scene-1", stableElements: ["studio"] }]
    },
    scenes: [
      {
        id: "scene-1",
        order: 1,
        purpose: "product reveal",
        location: "studio",
        visualState: "clean",
        sourceBeatIds: ["beat-1"],
        requiredFactIds: ["fact-1"],
        clips: [clip]
      }
    ],
    contentHash: H.e,
    confirmedAt: ISO
  };
}

test("Product flow advances only through confirmed current versions", async () => {
  const repo = new MemoryProductFlowRepository();
  const service = new ProductFlowService(repo);
  await service.createProject(makeProject());

  const truth = makeProductTruth();
  let project = await service.confirmProductTruth(truth);
  assert.equal(project.status, "CREATIVE_REVIEW");
  assert.equal(project.currentProductTruthRef?.entityId, truth.id);

  const batch = makeCreativeBatch(truth);
  project = await service.activateCreativeBatch(batch);
  assert.equal(project.currentCreativeBatchRef?.entityId, batch.id);

  project = await service.selectCreative(project.id, "creative-1");
  assert.equal(project.status, "SCRIPT_REVIEW");
  assert.equal(project.selectedCreativeId, "creative-1");

  const script = makeScript(truth, batch);
  project = await service.confirmScript(script);
  assert.equal(project.status, "DIRECTOR_REVIEW");
  assert.equal(project.currentScriptRef?.entityId, script.id);

  const plan = makePlan(truth, script);
  project = await service.confirmProductionPlan(plan);
  assert.equal(project.status, "READY_TO_GENERATE");
  assert.equal(project.currentProductionPlanRef?.entityId, plan.id);
});

test("adopting an immutable saved candidate updates pointers without reinserting or overwriting history", async () => {
  const repo = new MemoryProductFlowRepository(), service = new ProductFlowService(repo);
  await service.createProject(makeProject());
  const truth = makeProductTruth(); await service.confirmProductTruth(truth);
  const batch = makeCreativeBatch(truth);
  await repo.commitVersion({ version: { id: batch.id, projectId: batch.projectId, entityType: "CreativeBatch", entityKey: "creative-batch",
    version: batch.version, status: batch.status, contentHash: batch.contentHash, data: batch }, staleEntityTypes: [], projectPatch: {} });
  const count = repo.versions.size;
  const insert = repo.commitVersion.bind(repo);
  repo.commitVersion = async () => { throw new Error("duplicate insert forbidden"); };
  const adopted = await service.activateCreativeBatch(batch);
  assert.equal(adopted.currentCreativeBatchRef?.entityId, batch.id);
  assert.equal(repo.versions.size, count);
  await assert.rejects(service.activateCreativeBatch({ ...batch, concepts: batch.concepts.map((c, n) => n === 0 ? { ...c, title: "tampered" } : c) }), /内容.*不一致/);
  assert.deepEqual(await repo.getVersion(batch.projectId, "CreativeBatch", batch.id, batch.version), batch);
  repo.commitVersion = insert;
});

test("CreativeBatch is blocked before a current confirmed ProductTruth exists", async () => {
  const repo = new MemoryProductFlowRepository();
  const service = new ProductFlowService(repo);
  await service.createProject(makeProject());
  const truth = makeProductTruth();

  await assert.rejects(
    service.activateCreativeBatch(makeCreativeBatch(truth)),
    (error: unknown) =>
      error instanceof DomainValidationError &&
      /ProductTruth ref is not current/.test(error.message)
  );
});

test("Script is blocked when it references a stale ProductTruth", async () => {
  const repo = new MemoryProductFlowRepository();
  const service = new ProductFlowService(repo);
  await service.createProject(makeProject());
  const truth = makeProductTruth();
  await service.confirmProductTruth(truth);
  const batch = makeCreativeBatch(truth);
  await service.activateCreativeBatch(batch);
  await service.selectCreative("project-1", "creative-1");

  const script = makeScript(truth, batch);
  script.productTruthRef = { ...script.productTruthRef, hash: H.f };

  await assert.rejects(
    service.confirmScript(script),
    (error: unknown) =>
      error instanceof DomainValidationError &&
      /ProductTruth ref is not current/.test(error.message)
  );
});

test("ProductionPlan cannot drop a HARD forbidden change", async () => {
  const repo = new MemoryProductFlowRepository();
  const service = new ProductFlowService(repo);
  await service.createProject(makeProject());
  const truth = makeProductTruth();
  await service.confirmProductTruth(truth);
  const batch = makeCreativeBatch(truth);
  await service.activateCreativeBatch(batch);
  await service.selectCreative("project-1", "creative-1");
  const script = makeScript(truth, batch);
  await service.confirmScript(script);

  const plan = makePlan(truth, script);
  plan.continuityLock.product.forbiddenChanges = [];

  await assert.rejects(
    service.confirmProductionPlan(plan),
    (error: unknown) =>
      error instanceof DomainValidationError &&
      /dropped HARD ForbiddenChange/.test(error.message)
  );
});

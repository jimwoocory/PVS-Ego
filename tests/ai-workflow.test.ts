import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  StructuredAiRequest,
  StructuredAiRuntime
} from "../src/application/ports/structured-ai-runtime.js";
import { AiGenerationService } from "../src/application/services/ai-generation.js";
import {
  confirmProductTruthDraft,
  confirmScriptDraft
} from "../src/application/services/review-actions.js";
import { LocalProductInputStore } from "../src/adapters/store/local-product-input-store.js";
import type {
  ArtifactRepository,
  PendingArtifactInput
} from "../src/application/ports/artifact-repository.js";
import type {
  ArtifactRecord,
  AssetRef
} from "../src/domain/schemas.js";
import { makeProductTruth, ISO } from "./fixtures.js";

class QueueAiRuntime implements StructuredAiRuntime {
  readonly id = "fake-ai";
  readonly version = "1";
  readonly requests: StructuredAiRequest[] = [];
  constructor(private readonly outputs: unknown[]) {}
  async generateJson(request: StructuredAiRequest): Promise<unknown> {
    this.requests.push(request);
    if (!this.outputs.length) throw new Error("no queued AI output");
    return structuredClone(this.outputs.shift());
  }
}

class MetadataAiRuntime extends QueueAiRuntime {
  async generateJsonWithMetadata(request: StructuredAiRequest) {
    return {
      data: await this.generateJson(request),
      metadata: {
        executionId: "execution-test",
        providerId: "provider-test",
        modelId: "model-test",
        configVersion: 7
      }
    };
  }
}

class MemoryArtifactRepository implements ArtifactRepository {
  readonly data = new Map<string, ArtifactRecord>();

  async createPending(input: PendingArtifactInput): Promise<ArtifactRecord> {
    const record: ArtifactRecord = {
      id: input.id,
      projectId: input.projectId,
      kind: input.kind,
      relativePath: input.relativePath,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      integrityStatus: "PENDING",
      immutable: true,
      createdAt: ISO
    };
    this.data.set(record.id, record);
    return record;
  }

  async markReady(
    id: string,
    fields: { sha256: string; sizeBytes: number; mimeType?: string }
  ): Promise<ArtifactRecord> {
    const current = this.data.get(id);
    if (!current) throw new Error("missing");
    const next: ArtifactRecord = {
      ...current,
      sha256: fields.sha256,
      sizeBytes: fields.sizeBytes,
      ...(fields.mimeType ? { mimeType: fields.mimeType } : {}),
      integrityStatus: "READY"
    };
    this.data.set(id, next);
    return next;
  }

  async markMissing(id: string): Promise<ArtifactRecord> {
    const current = this.data.get(id);
    if (!current) throw new Error("missing");
    const next = { ...current, integrityStatus: "MISSING" as const };
    this.data.set(id, next);
    return next;
  }

  async markCorrupt(id: string): Promise<ArtifactRecord> {
    const current = this.data.get(id);
    if (!current) throw new Error("missing");
    const next = { ...current, integrityStatus: "CORRUPT" as const };
    this.data.set(id, next);
    return next;
  }

  async findById(id: string): Promise<ArtifactRecord | null> {
    return this.data.get(id) ?? null;
  }

  async listByProject(
    projectId: string,
    kind?: ArtifactRecord["kind"]
  ): Promise<ArtifactRecord[]> {
    return [...this.data.values()].filter(
      (item) => item.projectId === projectId && (!kind || item.kind === kind)
    );
  }

  async listPending(): Promise<ArtifactRecord[]> {
    return [...this.data.values()].filter(
      (item) => item.integrityStatus === "PENDING"
    );
  }
}

test("AI Product Truth stays DRAFT and unsupported claims stay uncertain", async () => {
  const runtime = new QueueAiRuntime([
    {
      standardColors: [],
      confirmedFeatures: [{ statement: "User stated feature" }],
      sellingPoints: [],
      uncertainClaims: [
        {
          statement: "Best in market",
          reason: "Not supported by user-provided facts"
        }
      ]
    }
  ]);
  const service = new AiGenerationService(runtime);
  const truth = await service.generateProductTruthDraft(
    {
      projectId: "p1",
      productName: "Widget",
      featureDescription: "User stated feature",
      referenceImageIds: ["asset-ref-1"],
      referenceImageArtifacts: [
        {
          id: "artifact-1",
          relativePath: "input/assets/one.png",
          sha256: "a".repeat(64),
          mimeType: "image/png"
        }
      ],
      forbiddenChanges: []
    },
    1
  );

  assert.equal(truth.status, "DRAFT");
  assert.equal(truth.confirmedFeatures[0]?.statement, "User stated feature");
  assert.equal(truth.uncertainClaims[0]?.status, "UNVERIFIED");
  assert.equal(
    truth.uncertainClaims[0]?.dispositionConfirmedByUser,
    false
  );
  assert.match(
    runtime.requests[0]!.instructions,
    /unsupported marketing statement must go to uncertainClaims/
  );
});

test("AI generated entity preserves actual provider/model execution metadata", async () => {
  const runtime = new MetadataAiRuntime([
    {
      standardColors: [],
      confirmedFeatures: [{ statement: "User stated feature" }],
      sellingPoints: [],
      uncertainClaims: []
    }
  ]);
  const service = new AiGenerationService(runtime);
  const truth = await service.generateProductTruthDraft(
    {
      projectId: "p-model-history",
      productName: "Widget",
      featureDescription: "User stated feature",
      referenceImageIds: ["asset-ref-1"],
      referenceImageArtifacts: [
        {
          id: "artifact-1",
          relativePath: "input/assets/one.png",
          sha256: "a".repeat(64),
          mimeType: "image/png"
        }
      ],
      forbiddenChanges: []
    },
    1
  );

  assert.deepEqual(truth.aiExecution, {
    executionId: "execution-test",
    providerId: "provider-test",
    modelId: "model-test",
    configVersion: 7
  });
});

test("Product Truth confirmation creates a new version and preserves UNVERIFIED isolation", () => {
  const confirmedFixture = makeProductTruth();
  const draft = {
    ...confirmedFixture,
    id: "draft-truth",
    version: 5,
    status: "DRAFT" as const,
    confirmedAt: undefined,
    uncertainClaims: confirmedFixture.uncertainClaims.map((claim) => ({
      ...claim,
      status: "UNVERIFIED" as const,
      dispositionConfirmedByUser: false
    }))
  };
  const result = confirmProductTruthDraft(
    draft,
    { "claim-1": "KEEP_UNVERIFIED" },
    new Date(ISO)
  );

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.version, 6);
  assert.notEqual(result.id, draft.id);
  assert.equal(result.uncertainClaims[0]?.status, "UNVERIFIED");
  assert.equal(result.uncertainClaims[0]?.dispositionConfirmedByUser, true);
  assert.equal(result.confirmedFeatures.some((fact) => fact.id === "claim-1"), false);
});

test("Product Truth reconfirmation preserves previously promoted claims while reviewing only new claims", () => {
  const confirmedFixture = makeProductTruth();
  const previousFactId = "fact-promoted-previous";
  const draft = {
    ...confirmedFixture,
    id: "draft-truth-research-refresh",
    version: 8,
    status: "DRAFT" as const,
    confirmedAt: undefined,
    confirmedFeatures: [
      ...confirmedFixture.confirmedFeatures,
      {
        id: previousFactId,
        statement: "Previously promoted fact",
        sourceType: "external" as const,
        evidenceRef: "research-evidence:previous",
        createdAt: ISO
      }
    ],
    uncertainClaims: [
      {
        id: "claim-promoted-previous",
        statement: "Previously promoted fact",
        reason: "Reviewed in an earlier version",
        sourceType: "research" as const,
        evidenceRefs: ["research-evidence:previous"],
        status: "PROMOTED" as const,
        dispositionConfirmedByUser: true,
        promotedFactId: previousFactId
      },
      {
        id: "claim-new-research",
        statement: "New research candidate",
        reason: "Needs current user review",
        sourceType: "research" as const,
        evidenceRefs: ["research-evidence:new"],
        status: "UNVERIFIED" as const,
        dispositionConfirmedByUser: false
      }
    ]
  };

  const result = confirmProductTruthDraft(
    draft,
    { "claim-new-research": "KEEP_UNVERIFIED" },
    new Date(ISO)
  );

  const previous = result.uncertainClaims.find(
    (claim) => claim.id === "claim-promoted-previous"
  );
  const current = result.uncertainClaims.find(
    (claim) => claim.id === "claim-new-research"
  );
  assert.equal(previous?.status, "PROMOTED");
  assert.equal(previous?.promotedFactId, previousFactId);
  assert.equal(previous?.dispositionConfirmedByUser, true);
  assert.equal(current?.status, "UNVERIFIED");
  assert.equal(current?.dispositionConfirmedByUser, true);
  assert.ok(result.confirmedFeatures.some((fact) => fact.id === previousFactId));
});

test("AI creative and script only use confirmed ProductFact ids", async () => {
  const truth = makeProductTruth();
  const runtime = new QueueAiRuntime([
    {
      concepts: Array.from({ length: 4 }, (_, index) => ({
        title: "Concept " + index,
        targetAudience: "buyers",
        painPoint: "need",
        hook: "hook",
        coreSellingPoint: "Feature one",
        narrativePattern: "problem-solution",
        expectedDurationMs: 60000,
        productShowcaseStrategy: "show product",
        generationRisk: "LOW",
        requiredFactIds: ["fact-1"]
      }))
    },
    {
      beats: [
        {
          purpose: "HOOK",
          text: "Hook",
          estimatedDurationMs: 5000,
          requiredFactIds: []
        },
        {
          purpose: "FEATURE",
          text: "Feature one",
          estimatedDurationMs: 45000,
          requiredFactIds: ["fact-1"]
        },
        {
          purpose: "CTA",
          text: "CTA",
          estimatedDurationMs: 10000,
          requiredFactIds: []
        }
      ]
    }
  ]);
  const service = new AiGenerationService(runtime);
  const batch = await service.generateCreativeBatch(truth, 1, 60000);
  const selected = batch.concepts[0]!.id;
  const script = await service.generateScriptDraft({
    truth,
    batch,
    selectedCreativeId: selected,
    version: 1,
    targetDurationMs: 60000
  });

  assert.equal(batch.concepts.length, 4);
  assert.equal(script.status, "DRAFT");
  assert.equal(script.beats[1]?.requiredFactIds[0], "fact-1");
  const confirmedScript = confirmScriptDraft(script, new Date(ISO));
  assert.equal(confirmedScript.status, "CONFIRMED");
  assert.equal(confirmedScript.version, 2);
});


test("Creative auto-corrects hallucinated ProductFact IDs exactly once", async () => {
  const truth = makeProductTruth();
  const badId = "df70c8f7-0000-0000-0000-000000000000";
  const concept = (requiredFactIds: string[]) => ({
    title: "Concept",
    targetAudience: "buyers",
    painPoint: "need",
    hook: "hook",
    coreSellingPoint: "Feature one",
    narrativePattern: "problem-solution",
    expectedDurationMs: 60000,
    productShowcaseStrategy: "show product",
    generationRisk: "LOW" as const,
    requiredFactIds
  });
  const runtime = new QueueAiRuntime([
    {
      concepts: Array.from({ length: 4 }, () => concept([badId]))
    },
    {
      concepts: Array.from({ length: 4 }, () => concept(["fact-1"]))
    }
  ]);
  const service = new AiGenerationService(runtime);

  const batch = await service.generateCreativeBatch(truth, 1, 60000);

  assert.equal(runtime.requests.length, 2);
  assert.equal(
    batch.concepts.every(
      (item) =>
        item.requiredFactIds.length === 1 &&
        item.requiredFactIds[0] === "fact-1"
    ),
    true
  );
  const firstInput = runtime.requests[0]?.input as {
    allowedFactIds?: string[];
  };
  assert.deepEqual(firstInput.allowedFactIds?.includes("fact-1"), true);
  const correctionInput = runtime.requests[1]?.input as {
    allowedFactIds?: string[];
    rejectedRequiredFactIds?: string[];
    previousInvalidOutput?: unknown;
  };
  assert.deepEqual(correctionInput.allowedFactIds?.includes("fact-1"), true);
  assert.deepEqual(
    correctionInput.rejectedRequiredFactIds?.includes(badId),
    true
  );
  assert.ok(correctionInput.previousInvalidOutput);
  assert.match(
    runtime.requests[1]?.instructions ?? "",
    /strict foreign-key field/
  );
});

test("Creative fails closed with readable message after a second hallucinated Fact ID", async () => {
  const truth = makeProductTruth();
  const badId = "df70c8f7-0000-0000-0000-000000000000";
  const invalid = {
    concepts: Array.from({ length: 4 }, (_, index) => ({
      title: "Invalid " + index,
      targetAudience: "buyers",
      painPoint: "need",
      hook: "hook",
      coreSellingPoint: "Feature one",
      narrativePattern: "problem-solution",
      expectedDurationMs: 60000,
      productShowcaseStrategy: "show product",
      generationRisk: "LOW",
      requiredFactIds: [badId]
    }))
  };
  const runtime = new QueueAiRuntime([invalid, invalid]);
  const service = new AiGenerationService(runtime);

  await assert.rejects(
    service.generateCreativeBatch(truth, 1, 60000),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /产品事实白名单之外/);
      assert.doesNotMatch(error.message, /Unknown ProductFact reference/);
      assert.doesNotMatch(error.message, new RegExp(badId));
      return true;
    }
  );
  assert.equal(runtime.requests.length, 2);
});

test("Valid Creative output stays single-call with exact Fact ID whitelist contract", async () => {
  const truth = makeProductTruth();
  const runtime = new QueueAiRuntime([
    {
      concepts: Array.from({ length: 4 }, (_, index) => ({
        title: "Valid " + index,
        targetAudience: "buyers",
        painPoint: "need",
        hook: "hook",
        coreSellingPoint: "Feature one",
        narrativePattern: "problem-solution",
        expectedDurationMs: 60000,
        productShowcaseStrategy: "show product",
        generationRisk: "LOW",
        requiredFactIds: ["fact-1"]
      }))
    }
  ]);
  const service = new AiGenerationService(runtime);

  await service.generateCreativeBatch(truth, 1, 60000);

  assert.equal(runtime.requests.length, 1);
  const outputContract = runtime.requests[0]?.outputContract as {
    concepts?: Array<{
      requiredFactIds?: {
        items?: { enum?: string[] };
      };
    }>;
  };
  assert.equal(
    outputContract.concepts?.[0]?.requiredFactIds?.items?.enum?.includes(
      "fact-1"
    ),
    true
  );
});

test("Script auto-corrects hallucinated ProductFact IDs with the same whitelist rule", async () => {
  const truth = makeProductTruth();
  const badId = "df70c8f7-0000-0000-0000-000000000000";
  const runtime = new QueueAiRuntime([
    {
      concepts: Array.from({ length: 4 }, (_, index) => ({
        title: "Concept " + index,
        targetAudience: "buyers",
        painPoint: "need",
        hook: "hook",
        coreSellingPoint: "Feature one",
        narrativePattern: "problem-solution",
        expectedDurationMs: 60000,
        productShowcaseStrategy: "show product",
        generationRisk: "LOW",
        requiredFactIds: ["fact-1"]
      }))
    },
    {
      beats: [
        {
          purpose: "HOOK",
          text: "Hook",
          estimatedDurationMs: 10000,
          requiredFactIds: []
        },
        {
          purpose: "FEATURE",
          text: "Feature one",
          estimatedDurationMs: 40000,
          requiredFactIds: [badId]
        },
        {
          purpose: "CTA",
          text: "CTA",
          estimatedDurationMs: 10000,
          requiredFactIds: []
        }
      ]
    },
    {
      beats: [
        {
          purpose: "HOOK",
          text: "Hook",
          estimatedDurationMs: 10000,
          requiredFactIds: []
        },
        {
          purpose: "FEATURE",
          text: "Feature one",
          estimatedDurationMs: 40000,
          requiredFactIds: ["fact-1"]
        },
        {
          purpose: "CTA",
          text: "CTA",
          estimatedDurationMs: 10000,
          requiredFactIds: []
        }
      ]
    }
  ]);
  const service = new AiGenerationService(runtime);
  const batch = await service.generateCreativeBatch(truth, 1, 60000);

  const script = await service.generateScriptDraft({
    truth,
    batch,
    selectedCreativeId: batch.concepts[0]!.id,
    version: 1,
    targetDurationMs: 60000
  });

  assert.equal(runtime.requests.length, 3);
  assert.equal(script.beats[1]?.requiredFactIds[0], "fact-1");
  const correctionInput = runtime.requests[2]?.input as {
    allowedFactIds?: string[];
    rejectedRequiredFactIds?: string[];
  };
  assert.equal(correctionInput.allowedFactIds?.includes("fact-1"), true);
  assert.equal(correctionInput.rejectedRequiredFactIds?.includes(badId), true);
});

test("AI creative and script honor a 10-second project target", async () => {
  const truth = makeProductTruth();
  const runtime = new QueueAiRuntime([
    {
      concepts: Array.from({ length: 4 }, (_, index) => ({
        title: "Short " + index,
        targetAudience: "buyers",
        painPoint: "need",
        hook: "fast hook",
        coreSellingPoint: "Feature one",
        narrativePattern: "quick-demo",
        expectedDurationMs: 60000,
        productShowcaseStrategy: "show product immediately",
        generationRisk: "LOW",
        requiredFactIds: ["fact-1"]
      }))
    },
    {
      beats: [
        {
          purpose: "HOOK",
          text: "Hook",
          estimatedDurationMs: 4000,
          requiredFactIds: []
        },
        {
          purpose: "FEATURE",
          text: "Feature one",
          estimatedDurationMs: 6000,
          requiredFactIds: ["fact-1"]
        }
      ]
    }
  ]);
  const service = new AiGenerationService(runtime);
  const batch = await service.generateCreativeBatch(truth, 2, 10000);
  assert.equal(batch.concepts.every((concept) => concept.expectedDurationMs === 10000), true);
  assert.match(runtime.requests[0]!.task, /10-second/);

  const script = await service.generateScriptDraft({
    truth,
    batch,
    selectedCreativeId: batch.concepts[0]!.id,
    version: 2,
    targetDurationMs: 10000
  });
  assert.equal(script.targetDurationMs, 10000);
  assert.equal(
    script.beats.reduce((total, beat) => total + beat.estimatedDurationMs, 0),
    10000
  );
  assert.match(runtime.requests[1]!.task, /10-second/);
});

test("Product Input snapshot persists immutable JSON and reloads after store recreation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-product-input-"));
  const repo = new MemoryArtifactRepository();
  const asset: AssetRef = {
    id: "asset-ref-1",
    artifactId: "raw-artifact-1",
    type: "image",
    source: "user_upload",
    originalFilename: "product.png",
    sha256: "b".repeat(64),
    mimeType: "image/png",
    sizeBytes: 10,
    createdAt: ISO
  };
  try {
    const firstStore = new LocalProductInputStore(root, repo);
    const saved = await firstStore.save({
      projectId: "p-input",
      productName: "Widget",
      featureDescription: "Feature",
      assets: [asset],
      forbiddenChanges: []
    });
    assert.equal(saved.version, 1);

    const secondStore = new LocalProductInputStore(root, repo);
    const reloaded = await secondStore.latest("p-input");
    assert.equal(reloaded?.productName, "Widget");
    assert.equal(reloaded?.contentHash, saved.contentHash);
    assert.equal(reloaded?.assets[0]?.id, "asset-ref-1");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

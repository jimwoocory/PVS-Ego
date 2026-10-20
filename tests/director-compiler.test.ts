import test from "node:test";
import assert from "node:assert/strict";
import type {
  CreativeBatch,
  ProductionPlan,
  ReferenceVideoProfile,
  ScriptDraft
} from "../src/domain/schemas.js";
import { ProductDirectorService } from "../src/application/services/product-director.js";
import type {
  ProductDirectorGenerator,
  ProductDirectorInput
} from "../src/application/ports/product-director-generator.js";
import { compileSeedancePrompt } from "../src/application/services/prompt-compiler.js";
import { DomainValidationError } from "../src/domain/validation.js";
import { hashValue } from "../src/domain/hashing.js";
import { H, ISO, makeProductTruth, makeValidClip } from "./fixtures.js";
import type { DirectorV3Plan } from "../src/domain/director-v3.js";

const truth = makeProductTruth();

function makeBatch(): CreativeBatch {
  return {
    id: "batch-director",
    projectId: truth.projectId,
    version: 1,
    status: "ACTIVE",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: truth.id,
      version: truth.version,
      hash: truth.contentHash
    },
    generatorVersion: "test-v1",
    concepts: Array.from({ length: 4 }, (_, index) => ({
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
    })),
    selectedCreativeId: "creative-1",
    contentHash: H.b,
    createdAt: ISO
  };
}

function makeScript(batch: CreativeBatch): ScriptDraft {
  return {
    id: "script-director",
    projectId: truth.projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: batch.productTruthRef,
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

function makeLongClip(index: number) {
  const clip = makeValidClip();
  clip.id = `clip-${index}`;
  clip.order = index;
  clip.durationMs = 15000;
  clip.contentHash = hashValue({ id: clip.id, durationMs: clip.durationMs });
  clip.requiredFactIds = ["fact-1"];
  clip.sourceBeatIds = ["beat-1"];
  clip.segments[0]!.id = `clip-${index}-seg-1`;
  clip.segments[0]!.endMs = 4000;
  clip.segments[0]!.requiredFactIds = ["fact-1"];
  clip.segments[0]!.sourceBeatIds = ["beat-1"];
  clip.segments[1]!.id = `clip-${index}-seg-2`;
  clip.segments[1]!.startMs = 4000;
  clip.segments[1]!.endMs = 15000;
  clip.segments[1]!.requiredFactIds = ["fact-1"];
  clip.segments[1]!.sourceBeatIds = ["beat-1"];
  return clip;
}

function makePlan(script: ScriptDraft): ProductionPlan {
  return {
    id: "plan-director",
    projectId: truth.projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: script.productTruthRef,
    scriptRef: {
      entityType: "ScriptDraft",
      entityId: script.id,
      version: script.version,
      hash: script.contentHash
    },
    selectedCreativeId: script.selectedCreativeId,
    visualDirection: "clean studio",
    soundDirection: "clear narration",
    productShowcaseRules: ["show real product"],
    continuityLock: {
      product: {
        stableAttributes: ["logo"],
        forbiddenChanges: structuredClone(truth.forbiddenChanges)
      },
      characters: [],
      environments: [{ sceneId: "scene-director", stableElements: ["studio"] }]
    },
    scenes: [
      {
        id: "scene-director",
        order: 1,
        purpose: "product reveal",
        location: "studio",
        visualState: "clean",
        sourceBeatIds: ["beat-1"],
        requiredFactIds: ["fact-1"],
        clips: [1, 2, 3, 4].map(makeLongClip)
      }
    ],
    contentHash: H.e,
    confirmedAt: ISO
  };
}

class FakeDirector implements ProductDirectorGenerator {
  id = "fake";
  version = "1";
  constructor(private readonly output: ProductionPlan) {}
  async generate(_input: ProductDirectorInput): Promise<ProductionPlan> {
    return structuredClone(this.output);
  }
}

function makeReferenceProfile(): ReferenceVideoProfile {
  return {
    id: "reference-director",
    projectId: truth.projectId,
    version: 1,
    status: "ACTIVE",
    sourceType: "UPLOAD",
    videoArtifactId: "reference-artifact",
    videoArtifactHash: H.a,
    media: {
      durationMs: 30000,
      hasAudio: true,
      sampledFrameCount: 10,
      sceneCutTimestampsMs: []
    },
    analysisConfidence: "HIGH",
    hook: {
      firstThreeSecondsPattern: "result first",
      structuralPurpose: "hook"
    },
    pacing: {
      overall: "fast",
      estimatedShotCount: 6,
      averageShotDurationMs: 5000
    },
    shotLanguage: {
      shotSizes: ["close"],
      cameraPositions: ["front"],
      cameraMovements: ["push"],
      compositionPatterns: ["center"]
    },
    productAppearance: {
      firstAppearanceMs: 500,
      visibilityPattern: "frequent",
      showcasePattern: "result then feature"
    },
    sellingPointPattern: ["problem-feature-result"],
    dialogueNarrationStructure: "short narration",
    audioBgMusicStructure: "rhythmic",
    ctaPattern: "single CTA",
    reusableStylePrinciples: ["show result early"],
    copyGuard: "STRUCTURE_AND_METHOD_ONLY",
    contentHash: H.d,
    createdAt: ISO
  };
}

test("Product Director validates generated plan before accepting it", async () => {
  const batch = makeBatch();
  const script = makeScript(batch);
  const plan = makePlan(script);
  const service = new ProductDirectorService(new FakeDirector(plan));
  const result = await service.generate({
    productTruth: truth,
    creativeBatch: batch,
    selectedCreativeId: "creative-1",
    script,
    projectTargetDurationMs: 60000
  });
  assert.equal(result.scenes[0]?.clips.length, 4);
});

test("Product Director rejects output that drops HARD product constraint", async () => {
  const batch = makeBatch();
  const script = makeScript(batch);
  const plan = makePlan(script);
  plan.continuityLock.product.forbiddenChanges = [];
  const service = new ProductDirectorService(new FakeDirector(plan));

  await assert.rejects(
    service.generate({
      productTruth: truth,
      creativeBatch: batch,
      selectedCreativeId: "creative-1",
      script,
      projectTargetDurationMs: 60000
    }),
    (error: unknown) =>
      error instanceof DomainValidationError &&
      /HARD ForbiddenChange/.test(error.message)
  );
});

test("Product Director binds the active ReferenceVideoProfile into the plan", async () => {
  const batch = makeBatch();
  const script = makeScript(batch);
  const profile = makeReferenceProfile();
  const plan = makePlan(script);
  plan.referenceVideoProfileRef = {
    entityType: "ReferenceVideoProfile",
    entityId: profile.id,
    version: profile.version,
    hash: profile.contentHash
  };
  const service = new ProductDirectorService(new FakeDirector(plan));
  const result = await service.generate({
    productTruth: truth,
    creativeBatch: batch,
    selectedCreativeId: "creative-1",
    script,
    referenceVideoProfile: profile,
    projectTargetDurationMs: 60000
  });
  assert.equal(
    result.referenceVideoProfileRef?.entityId,
    profile.id
  );
});

test("Product Director rejects output that drops the active ReferenceVideoProfile", async () => {
  const batch = makeBatch();
  const script = makeScript(batch);
  const profile = makeReferenceProfile();
  const plan = makePlan(script);
  const service = new ProductDirectorService(new FakeDirector(plan));
  await assert.rejects(
    service.generate({
      productTruth: truth,
      creativeBatch: batch,
      selectedCreativeId: "creative-1",
      script,
      referenceVideoProfile: profile,
      projectTargetDurationMs: 60000
    }),
    /ReferenceVideoProfile/
  );
});

test("Prompt Compiler is deterministic and excludes UNVERIFIED claims", () => {
  const batch = makeBatch();
  const script = makeScript(batch);
  const plan = makePlan(script);

  const first = compileSeedancePrompt({
    id: "prompt-1",
    version: 1,
    createdAt: ISO,
    productTruth: truth,
    creativeBatch: batch,
    script,
    productionPlan: plan,
    clipId: "clip-1",
    assets: []
  });

  const second = compileSeedancePrompt({
    id: "prompt-2",
    version: 2,
    createdAt: "2026-09-27T06:00:00.000Z",
    productTruth: structuredClone(truth),
    creativeBatch: structuredClone(batch),
    script: structuredClone(script),
    productionPlan: structuredClone(plan),
    clipId: "clip-1",
    assets: []
  });

  assert.equal(first.promptText, second.promptText);
  assert.equal(first.compiledPromptHash, second.compiledPromptHash);
  assert.match(first.promptText, /forbid-1 \[HARD\] \[logo\]: Do not change logo/);
  assert.match(first.promptText, /fact-1: Feature one/);
  assert.doesNotMatch(first.promptText, /Unverified claim/);
  assert.equal(first.factMapping[0]?.factId, "fact-1");
  assert.equal(first.constraintMapping[0]?.forbiddenChangeId, "forbid-1");
});

test("Director V3 compiler uses the concise prompt, requests native audio and binds no-BGM policy", () => {
  const batch = makeBatch();
  const script = makeScript(batch);
  const plan = makePlan(script);
  const directorV3Plan: DirectorV3Plan = {
    version: "director-v3-1",
    projectId: truth.projectId,
    scriptRef: {
      entityType: "ScriptDraft",
      entityId: script.id,
      version: script.version,
      hash: script.contentHash
    },
    targetDurationMs: 60000,
    clipContracts: plan.scenes[0]!.clips.map(
      (clip, index) => ({
        id: "contract-" + (index + 1),
        order: index + 1,
        sourceBeatIds: ["beat-1"],
        purpose: "展示当前产品并完成一个清晰动作",
        location: "studio",
        durationMs: clip.durationMs,
        openingState: "产品准备展示",
        closingState: "产品完成展示",
        actions: [
          {
            order: 1,
            startMs: 0,
            endMs: clip.durationMs,
            description: "自然展示当前产品",
            productState: "完整产品"
          }
        ],
        camera: {
          shotSize: "中近景",
          position: "稳定机位",
          angle: "轻俯视",
          movement: "固定机位"
        },
        referenceAssetIds: [],
        productStateChanges: [],
        audio: {
          mode: "NATIVE",
          dialogueOrOs: [],
          ambience: ["自然室内环境声"],
          sfx: ["产品接触声"],
          bgm: false
        },
        globalConstraints: {
          preserveProductIdentity: true,
          noReadableText: true,
          noBgm: true,
          extra: []
        }
      })
    ),
    createdAt: ISO,
    contentHash: H.f
  };
  const compiled = compileSeedancePrompt({
    id: "prompt-v3",
    version: 1,
    createdAt: ISO,
    productTruth: truth,
    creativeBatch: batch,
    script,
    productionPlan: plan,
    directorV3Plan,
    clipId: "clip-1",
    assets: []
  });
  assert.equal(
    compiled.compilerTemplateVersion,
    "seedance-prompt-v3-1"
  );
  assert.equal(
    compiled.audioPolicy,
    "V3_NATIVE_NO_BGM"
  );
  assert.equal(
    compiled.generationParams.generateAudio,
    true
  );
  assert.match(compiled.promptText, /【本段视频目标】/);
  assert.match(compiled.promptText, /【声音】/);
  assert.match(compiled.promptText, /不生成背景音乐/);
  assert.match(compiled.promptText, /自然室内环境声/);
  assert.equal(
    (compiled.promptText.match(/【全局约束】/g) ?? [])
      .length,
    1
  );
  assert.doesNotMatch(
    compiled.promptText,
    /不请求模型原生音轨|声音由后期统一处理/
  );
});

test("Prompt Compiler fails closed when required reference asset is missing", () => {
  const batch = makeBatch();
  const script = makeScript(batch);
  const plan = makePlan(script);
  plan.scenes[0]!.clips[0]!.referenceAssets = [
    {
      assetId: "asset-required",
      role: "PRIMARY_PRODUCT",
      priority: 0,
      required: true
    }
  ];

  assert.throws(
    () =>
      compileSeedancePrompt({
        id: "prompt-required",
        version: 1,
        createdAt: ISO,
        productTruth: truth,
        creativeBatch: batch,
        script,
        productionPlan: plan,
        clipId: "clip-1",
        assets: []
      }),
    (error: unknown) =>
      error instanceof DomainValidationError &&
      /Required reference asset missing/.test(error.message)
  );
});

test("Prompt Compiler accepts a confirmed production asset with SCENE_REFERENCE role without treating it as research", () => {
  const batch = makeBatch();
  const script = makeScript(batch);
  const plan = makePlan(script);
  const assetId = "production-asset:set-1:SET_OFFICE";
  plan.scenes[0]!.clips[0]!.referenceAssets = [
    {
      assetId,
      role: "SCENE_REFERENCE",
      priority: 0,
      required: true
    }
  ];
  const compiled = compileSeedancePrompt({
    id: "prompt-production-set",
    version: 1,
    createdAt: ISO,
    productTruth: truth,
    creativeBatch: batch,
    script,
    productionPlan: plan,
    clipId: "clip-1",
    assets: [
      {
        id: assetId,
        artifactId: "artifact-production-set",
        type: "image",
        source: "generated",
        originalFilename: "办公室.jpg",
        sha256: H.a,
        mimeType: "image/jpeg",
        sizeBytes: 1024,
        provenance: "ProductionAssetSet set-1 / SET_OFFICE",
        createdAt: ISO
      }
    ]
  });
  assert.ok(compiled.inputAssetManifest.some(item => item.assetId === assetId));
});

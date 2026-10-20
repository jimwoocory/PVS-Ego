import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import type { StructuredAiRequest, StructuredAiRuntime } from "../src/application/ports/structured-ai-runtime.js";
import type { GenerationRepository } from "../src/application/ports/generation-repository.js";
import type { WorkflowRepository } from "../src/application/ports/workflow-repository.js";
import type { VideoProvider } from "../src/application/ports/video-provider.js";
import { HermesProductDirectorGenerator } from "../src/adapters/ai/hermes-product-director-generator.js";
import { ProductDirectorService } from "../src/application/services/product-director.js";
import { GenerationPreflightService } from "../src/application/services/generation-preflight.js";
import { compileSeedancePrompt } from "../src/application/services/prompt-compiler.js";
import { confirmProductionPlanDraft } from "../src/application/services/review-actions.js";
import { resolveGenerationProfile } from "../src/application/services/dreamina-agent-capability.js";
import { assertDirectorPlanTarget, planModelAwareClipDurations, resolveDirectorGenerationTarget } from "../src/application/services/director-generation-target.js";
import { renderDirectorGenerationControls } from "../src/web/director-generation-ui.js";
import { renderProjectPage } from "../src/web/workbench-ui.js";
import { H, ISO } from "./fixtures.js";
import { directorCase, modelRegistry } from "./model-aware-fixtures.js";
import {
  productionAssetSetSchema,
  productionAssetSetRef
} from "../src/domain/production-strategy.js";

async function generate(c: ReturnType<typeof directorCase>) {
  const requests: StructuredAiRequest[] = [];
  const runtime: StructuredAiRuntime = {
    id: "model-aware-test", version: "1",
    async generateJson(request) { requests.push(request); return structuredClone(c.proposal); }
  };
  const service = new ProductDirectorService(new HermesProductDirectorGenerator(runtime));
  const plan = await service.generate(c.input);
  return { plan, requests };
}

for (const maximum of [10, 15]) {
  for (const totalSeconds of [15, 30, 60]) {
    test(`model-aware director splits ${totalSeconds}s with live ${maximum}s limit, exact duration and traceability`, async () => {
      const c = directorCase(totalSeconds * 1000, maximum);
      const original = structuredClone(c.proposal);
      const { plan, requests } = await generate(c);
      const clips = plan.scenes.flatMap(scene => scene.clips);
      assert.equal(clips.reduce((sum, clip) => sum + clip.durationMs, 0), totalSeconds * 1000);
      assert.ok(clips.every(clip => clip.durationMs >= 4000 && clip.durationMs <= maximum * 1000));
      assert.ok(clips.every(clip => clip.durationMs % 1000 === 0 && clip.requiredFactIds.includes("fact-1")));
      for (let i = 1; i < clips.length; i++) assert.deepEqual(clips[i - 1]!.closingState, clips[i]!.openingState);
      assert.deepEqual(plan.generationTarget, c.target);
      assert.deepEqual(c.proposal, original, "AI source proposal must not be mutated");
      assert.deepEqual((requests[0]!.input as { generationTarget: unknown }).generationTarget, c.target);
      assert.ok(requests[0]!.instructions.includes(`4-${maximum} whole seconds`));
      assert.deepEqual(plan.continuityLock.product.forbiddenChanges, c.input.productTruth.forbiddenChanges);
    });
  }
}

test("balanced slot planner preserves every feasible 10-120 second total and refuses impossible totals", () => {
  for (const max of [5, 10, 15]) {
    const c = directorCase(15000, max);
    for (let seconds = 10; seconds <= 120; seconds++) {
      if (Math.ceil(seconds / max) * 4 > seconds) {
        assert.throws(() => planModelAwareClipDurations(seconds * 1000, c.target), /无法.*拆镜/);
        continue;
      }
      const durations = planModelAwareClipDurations(seconds * 1000, c.target);
      assert.equal(durations.reduce((a, b) => a + b, 0), seconds * 1000);
      assert.ok(durations.every(ms => ms >= 4000 && ms <= max * 1000 && ms % 1000 === 0));
    }
  }
});

test("long-clip splitting preserves complete narration exactly once", async () => {
  const c = directorCase(30000, 10);
  const clip = c.proposal.scenes[0]!.clips[0]!;
  const segment = clip.segments[0]!;
  clip.segments = [
    { ...segment, endMs: 4000, dialogueOrNarration: { kind: "NARRATION", text: "完整台词只出现一次", estimatedDurationMs: 3500, estimatorVersion: "test" } },
    { ...segment, id: "silent-tail", startMs: 4000, endMs: 30000 }
  ];
  const { plan } = await generate(c);
  const speech = plan.scenes.flatMap(s => s.clips.flatMap(item => item.segments)).filter(item => item.dialogueOrNarration.kind !== "NONE");
  assert.equal(speech.length, 1);
  assert.equal(speech[0]!.dialogueOrNarration.kind, "NARRATION");
  assert.ok(speech[0]!.endMs - speech[0]!.startMs >= 3500);
});

test("director fills missing narration timing metadata deterministically instead of failing the smart run", async () => {
  const c = directorCase(15000, 15);
  c.proposal.scenes[0]!.clips[0]!.segments[0]!.dialogueOrNarration = {
    kind: "NARRATION",
    text: "用真实产品细节自然推进剧情。"
  } as any;
  const { plan, requests } = await generate(c);
  const speech = plan.scenes[0]!.clips[0]!.segments[0]!.dialogueOrNarration;
  assert.equal(speech.kind, "NARRATION");
  assert.ok(speech.estimatedDurationMs > 0);
  assert.equal(speech.estimatorVersion, "director-text-estimator-v1");
  assert.match(requests[0]!.instructions, /estimatedDurationMs and estimatorVersion/);
  assert.deepEqual(
    (requests[0]!.outputContract as any).scenes[0].clips[0].segments[0].dialogueOrNarration,
    {
      kind: "NARRATION|DIALOGUE|NONE",
      text: "required when kind is NARRATION or DIALOGUE",
      estimatedDurationMs: 1800,
      estimatorVersion: "director-text-estimator-v1"
    }
  );
});

test("long speech cannot be silently truncated, duplicated or treated as a safe split", async () => {
  const c = directorCase(15000, 10);
  c.proposal.scenes[0]!.clips[0]!.segments[0]!.dialogueOrNarration = {
    kind: "NARRATION", text: "整段长台词必须先重新编排", estimatedDurationMs: 15000, estimatorVersion: "test"
  };
  await assert.rejects(generate(c), /无损拆镜/);
});

test("automatic splitting rejects preexisting timeline gaps instead of hiding them", async () => {
  const c = directorCase(30000, 10);
  c.proposal.scenes[0]!.clips[0]!.segments[0]!.startMs = 1;
  await assert.rejects(generate(c), /间隙|重叠|连续性/);
});

test("director keeps exact visible copy in post-production cues and rejects burned-in text directives", async () => {
  const c = directorCase();
  const segment = c.proposal.scenes[0]!.clips[0]!.segments[0]!;
  segment.postProductionText = [{
    kind: "LABEL",
    text: "Tonemay Q8",
    startMs: segment.startMs,
    endMs: segment.endMs,
    position: "CENTER",
    fontScale: 1.2,
    sourceBeatIds: ["beat-1"],
    requiredFactIds: ["fact-1"]
  }];
  const { plan, requests } = await generate(c);
  assert.equal(plan.scenes[0]!.clips[0]!.segments[0]!.postProductionText[0]!.text, "Tonemay Q8");
  assert.match(requests[0]!.instructions, /Never ask the video model to render readable words/);

  const bad = directorCase();
  bad.proposal.scenes[0]!.clips[0]!.segments[0]!.subjectAction = "屏幕文字打出“Tonemay Q8”";
  await assert.rejects(generate(bad), /burn readable copy/);
});

test("director refuses unknown duration capabilities, unsupported native audio, AUTO and unavailable models", () => {
  const c = directorCase();
  const settings = { requestedModelVersion: c.target.requestedModelVersion, aspectRatio: "16:9", videoResolution: "720p", nativeAudioOutputRequested: false };
  assert.throws(() => resolveDirectorGenerationTarget(c.registry, { ...settings, requestedModelVersion: "AUTO" }), /明确选择/);
  assert.throws(() => resolveDirectorGenerationTarget(c.registry, { ...settings, requestedModelVersion: "missing-model" }), /无法验证/);
  assert.throws(() => resolveDirectorGenerationTarget(c.registry, { ...settings, nativeAudioOutputRequested: true }), /原生音轨|声音输出/);
  delete c.registry.operations[0]!.models[0]!.durationMaxSeconds;
  assert.throws(() => resolveDirectorGenerationTarget(c.registry, settings), /无法验证/);
});

test("model-bound plan rejects excess product references and mismatched targets", async () => {
  const c = directorCase();
  const { plan } = await generate(c);
  plan.scenes[0]!.clips[0]!.referenceAssets = Array.from({ length: 10 }, (_, index) => ({ assetId: `asset-${index}`, role: "PRIMARY_PRODUCT", priority: index, required: true }));
  assert.throws(() => assertDirectorPlanTarget(plan), /超过所选模型限制/);
  const wrong = structuredClone(c.target); wrong.requestedModelVersion = "seedance2.0";
  assert.throws(() => assertDirectorPlanTarget(plan, wrong), /GenerationTarget/);
});

async function compilerCase() {
  const c = directorCase();
  const { plan: draft } = await generate(c);
  const plan = confirmProductionPlanDraft(draft);
  const clip = plan.scenes[0]!.clips[0]!;
  const profile = resolveGenerationProfile(c.registry, {
    operation: "text2video", requestedModelVersion: c.target.requestedModelVersion,
    aspectRatio: c.target.aspectRatio, videoResolution: c.target.videoResolution,
    nativeAudioOutputRequested: false, durationMs: clip.durationMs, referenceAudioInputCount: 0
  });
  const input = {
    id: "compiled-model", version: 1, createdAt: ISO, productTruth: c.input.productTruth,
    creativeBatch: c.input.creativeBatch, script: c.input.script, productionPlan: plan,
    clipId: clip.id, generationProfile: profile, assets: []
  };
  return { c, input, plan };
}

test("compiled prompt consistently binds actual model, 16:9, resolution, audio policy, capabilities and facts", async () => {
  const { input } = await compilerCase();
  const prompt = compileSeedancePrompt(input);
  assert.equal(prompt.model, "seedance2.0mini");
  assert.equal(prompt.generationParams.aspectRatio, "16:9");
  assert.equal(prompt.generationParams.generateAudio, false);
  assert.match(prompt.promptText, /aspect_ratio=16:9/);
  assert.doesNotMatch(prompt.promptText, /aspect_ratio=9:16/);
  assert.match(prompt.promptText, /video_resolution=720p/);
  assert.match(prompt.promptText, /background_music_policy=FORBIDDEN_IN_MODEL_OUTPUT/);
  assert.match(prompt.promptText, /Do NOT generate background music/);
  assert.match(prompt.promptText, /No BGM, no music, no musical score, no soundtrack/);
  assert.match(prompt.promptText, /POST_PRODUCTION_AUDIO_CUES/);
  assert.match(prompt.promptText, /Do not change logo/);
  assert.match(prompt.promptText, /fact-1: Feature one/);
  assert.match(prompt.compilerTemplateVersion, /seedance2.0mini-text2video/);
  assert.deepEqual(prompt.generationProfile, input.generationProfile);
  assert.equal(compileSeedancePrompt(input).compiledPromptHash, prompt.compiledPromptHash);
});

test("V2 compiled prompt sends a clean director prompt while retaining internal audit mappings", async () => {
  const c = directorCase();
  const productionSetBase = {
    id: "production-set-v2",
    projectId: c.input.productTruth.projectId,
    version: 1,
    strategyRef: {
      entityType: "ProductionStrategy",
      entityId: "strategy-v2",
      version: 1,
      hash: H.f
    },
    selectedCreativeId: "creative-1",
    status: "READY" as const,
    entries: [
      {
        key: "PRODUCT_MAIN",
        referenceAssetId: "asset-1",
        kind: "PRODUCT" as const,
        label: "当前产品",
        description: "严格使用产品主参考图",
        purpose: "保持产品身份",
        required: true,
        reuseScope: "RUN" as const,
        source: "PRODUCT_INPUT" as const,
        status: "READY" as const,
        artifactIds: ["artifact-product"],
        sourceReferenceAssetIds: ["asset-1"],
        identityLock: ["保持产品形状、颜色和图案"],
        confidence: "HIGH" as const,
        reviewSummary: "产品主图已确认"
      },
      {
        key: "CHARACTER_A",
        referenceAssetId: "production-asset:character-a",
        kind: "CHARACTER" as const,
        label: "女主",
        description: "年轻成年女性，深色短发，灰色家居服",
        purpose: "跨镜头保持同一女主身份",
        required: true,
        reuseScope: "MULTI_CLIP" as const,
        source: "DREAMINA_GENERATED" as const,
        status: "READY" as const,
        artifactIds: ["production-asset:character-a"],
        sourceReferenceAssetIds: [],
        identityLock: ["深色短发", "灰色家居服", "同一成年女性面部身份"],
        confidence: "HIGH" as const,
        reviewSummary: "身份参考清晰"
      }
    ],
    createdAt: ISO,
    updatedAt: ISO
  };
  const productionAssetSet = productionAssetSetSchema.parse({
    ...productionSetBase,
    contentHash: H.f
  });
  const script = {
    ...structuredClone(c.input.script),
    productionAssetSetRef: productionAssetSetRef(productionAssetSet),
    contentHash: H.one
  };
  const proposal = structuredClone(c.proposal);
  proposal.scenes[0]!.clips[0]!.referenceAssets = [
    {
      assetId: "asset-1",
      role: "PRIMARY_PRODUCT",
      priority: 0,
      required: true
    },
    {
      assetId: "production-asset:character-a",
      role: "CHARACTER",
      priority: 1,
      required: true
    }
  ];
  const generator = new HermesProductDirectorGenerator({
    id: "v2-prompt-fixture",
    version: "1",
    generateJson: async () => proposal
  });
  const draft = await generator.generate({
    ...c.input,
    script,
    productionAssetSet
  });
  const plan = confirmProductionPlanDraft(draft);
  const clip = plan.scenes[0]!.clips[0]!;
  const profile = resolveGenerationProfile(c.registry, {
    operation: "multimodal2video",
    requestedModelVersion: c.target.requestedModelVersion,
    aspectRatio: c.target.aspectRatio,
    videoResolution: c.target.videoResolution,
    nativeAudioOutputRequested: false,
    durationMs: clip.durationMs,
    referenceAudioInputCount: 0
  });
  const prompt = compileSeedancePrompt({
    id: "compiled-v2",
    version: 1,
    createdAt: ISO,
    productTruth: c.input.productTruth,
    creativeBatch: c.input.creativeBatch,
    script,
    productionPlan: plan,
    productionAssetSet,
    clipId: clip.id,
    generationProfile: profile,
    assets: [
      {
        id: "asset-1",
        artifactId: "artifact-product",
        type: "image",
        source: "user_upload",
        sha256: H.a,
        mimeType: "image/png",
        sizeBytes: 1000,
        createdAt: ISO
      },
      {
        id: "production-asset:character-a",
        artifactId: "production-asset:character-a",
        type: "image",
        source: "generated",
        sha256: H.b,
        mimeType: "image/jpeg",
        sizeBytes: 1000,
        createdAt: ISO
      }
    ]
  });
  assert.equal(prompt.compilerTemplateVersion, "seedance-model-prompt-v2-1");
  assert.ok(prompt.auditContractHash);
  assert.deepEqual(
    prompt.productionAssetSetRef,
    productionAssetSetRef(productionAssetSet)
  );
  assert.match(prompt.promptText, /【镜头目标】/);
  assert.match(prompt.promptText, /【固定身份参考】/);
  assert.match(prompt.promptText, /女主/);
  assert.match(prompt.promptText, /不要生成背景音乐/);
  assert.doesNotMatch(prompt.promptText, /compiler_template/i);
  assert.doesNotMatch(prompt.promptText, /capability_fingerprint/i);
  assert.doesNotMatch(prompt.promptText, /command_help_sha256/i);
  assert.doesNotMatch(prompt.promptText, /fact-1/);
  assert.doesNotMatch(prompt.promptText, /seg-1/);
  assert.doesNotMatch(
    prompt.promptText,
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
  );
  assert.ok(prompt.factMapping.some(item => item.factId === "fact-1"));
});

test("model-aware compiler never sends exact overlay copy to Dreamina pixels", async () => {
  const { input } = await compilerCase();
  input.productTruth.productName = "Tonemay Q8";
  input.productTruth.brand = "Tonemay";
  input.productTruth.confirmedFeatures[0]!.statement = "产品名称 Tonemay Q8，品牌 Tonemay";
  input.productTruth.usageRules = [{
    id: "usage-model-label",
    category: "PRECAUTION",
    polarity: "MUST",
    statement: "Q8 Pro 功能效果必须标注为官方页面主张。",
    sourceType: "research",
    evidenceRefs: ["research-evidence:fixture"],
    confidence: "HIGH",
    status: "CONFIRMED",
    dispositionConfirmedByUser: true
  }];
  const segment = input.productionPlan.scenes[0]!.clips[0]!.segments[0]!;
  segment.postProductionText = [{
    kind: "LABEL",
    text: "EXACT-BRAND-COPY-DO-NOT-SEND",
    startMs: segment.startMs,
    endMs: segment.endMs,
    position: "CENTER",
    fontScale: 1.2,
    sourceBeatIds: [],
    requiredFactIds: []
  }];
  const prompt = compileSeedancePrompt(input);
  assert.match(prompt.promptText, /readable_text_policy=POST_PRODUCTION_ONLY/);
  assert.match(prompt.promptText, /post_production_text_cues=1/);
  assert.match(prompt.compilerTemplateVersion, /v3-posttext-identity-mask/);
  assert.doesNotMatch(prompt.promptText, /EXACT-BRAND-COPY-DO-NOT-SEND/);
  assert.doesNotMatch(prompt.promptText, /Tonemay/i);
  assert.doesNotMatch(prompt.promptText, /\bQ8\b/i);
  assert.doesNotMatch(prompt.promptText, /Q8\s+Pro/i);
  assert.match(prompt.promptText, /identity_source=PRIMARY_PRODUCT_REFERENCE/);
  assert.match(prompt.promptText, /name_label=POST_PRODUCTION_ONLY/);
  assert.match(prompt.promptText, /CURRENT_PRODUCT|CURRENT_MODEL/);

  const bad = structuredClone(input);
  bad.productionPlan.scenes[0]!.clips[0]!.segments[0]!.subjectAction = "型号文字 Tonemay Q8";
  assert.throws(() => compileSeedancePrompt(bad), /may not request readable copy/);
});

test("compiler rejects model switch, ratio override, duration tampering, capability drift and missing profile", async () => {
  const { input } = await compilerCase();
  assert.throws(() => compileSeedancePrompt({ ...input, model: "seedance2.0" }), /参数与已验证/);
  assert.throws(() => compileSeedancePrompt({ ...input, aspectRatio: "9:16" }), /参数与已验证/);
  assert.throws(() => compileSeedancePrompt({ ...input, generateAudio: true }), /参数与已验证/);
  assert.throws(() => compileSeedancePrompt({ ...input, generationProfile: { ...input.generationProfile, durationMs: 8000 } }), /参数与已验证/);
  assert.throws(() => compileSeedancePrompt({ ...input, generationProfile: { ...input.generationProfile, registryFingerprint: H.f } }), /能力表已变化/);
  const { generationProfile: _profile, ...withoutProfile } = input;
  assert.throws(() => compileSeedancePrompt(withoutProfile), /GenerationProfile/);
});

test("preflight refuses changed director settings before mutating any request or approval", async () => {
  const { input, c } = await compilerCase();
  let touched = 0;
  const generation = { async markSubmissionChainStale() { touched++; } } as unknown as GenerationRepository;
  const workflow = { async listGenerationAttempts() { touched++; return []; } } as unknown as WorkflowRepository;
  const provider = { async probe() { touched++; throw new Error("must not reach provider"); } } as unknown as VideoProvider;
  const service = new GenerationPreflightService(generation, workflow, provider, async () => 1);
  await assert.rejects(service.run({ ...input, projectId: c.input.productTruth.projectId,
    generationSettings: { requestedModelVersion: "seedance2.0", aspectRatio: "16:9", videoResolution: "720p", nativeAudioOutputRequested: false }
  }), /生成参数与导演目标不一致/);
  assert.equal(touched, 0);
});

test("complete script and director pages contain valid inline JavaScript including the structured editor", async () => {
  const c = directorCase();
  const { plan } = await generate(c);
  const workspace = {
    project: {
      id: c.input.productTruth.projectId, name: "模型感知测试", status: "DIRECTOR_REVIEW" as const,
      targetPlatform: "douyin" as const, targetDurationMs: 15000, aspectRatio: "16:9",
      selectedCreativeId: "creative-1", createdAt: ISO, updatedAt: ISO
    },
    productTruth: c.input.productTruth, creativeBatch: c.input.creativeBatch,
    script: { ...c.input.script, status: "DRAFT" as const }, productionPlan: plan
  };
  for (const kind of ["script", "director"] as const) {
    const html = renderProjectPage({ kind, workspace, blockers: [], attempts: [], generationRequests: [],
      preflights: [], approvals: [], compiledPrompts: [], artifacts: [], reviewDecisions: [], commandAttempts: [] });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 1);
    scripts.forEach((script, index) => new Script(script[1]!, { filename: `${kind}-inline-${index}.js` }));
  }
});

test("director UI exposes dynamic model-before-plan controls and JavaScript parses safely", () => {
  const html = renderDirectorGenerationControls({ projectId: 'test-</script><script>bad()</script>', targetDurationMs: 60000, canGenerate: true, hasPlan: false });
  assert.match(html, /先选择视频模型/);
  assert.match(html, /\/api\/dreamina\/capabilities/);
  assert.match(html, /generationSettings/);
  assert.match(html, /重新审核|不会提交即梦付费/);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  new Script(scripts[0]![1]!);
});

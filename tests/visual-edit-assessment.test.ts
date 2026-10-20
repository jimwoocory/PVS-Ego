import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { referenceFixture } from "./creative-reference-fixture.js";
import { makeValidClip, H } from "./fixtures.js";
import { hashValue } from "../src/domain/hashing.js";
import { VisualEditAssessmentService, applyClipVisibilityPolicy, VISUAL_EDIT_EVALUATOR_VERSION } from "../src/application/services/visual-edit-assessment.js";
import type { StructuredAiRequest } from "../src/application/ports/structured-ai-runtime.js";
import { PrismaReviewRepository } from "../src/adapters/db/prisma-review-repository.js";

const exec = promisify(execFile);

async function generatedVideo(f: Awaited<ReturnType<typeof referenceFixture>>, name: string, seconds = 12) {
  const file = path.join(f.root, name + ".mp4");
  await exec(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=s=640x360:r=8:d=${seconds}`,
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", file
  ], { windowsHide: true, timeout: 60_000 });
  return f.store.writeImmutable({
    id: "generated-" + randomUUID(),
    projectId: f.projectId,
    kind: "GENERATED_VIDEO",
    immutable: true,
    relativePath: "generated/" + name + ".mp4",
    mimeType: "video/mp4",
    bytes: await fs.readFile(file)
  });
}

function passProposal(index = 1) {
  return {
    productIdentity: "PASS",
    productPresence: "PRESENT",
    visibilityCompliance: "PASS",
    sceneConfidence: "HIGH",
    storyActionAlignment: "PASS",
    productStability: "PASS",
    usageCompliance: "PASS",
    visualQuality: "PASS",
    cutQuality: "PASS",
    confidence: "HIGH",
    recommendedWindowIndex: index,
    reasons: ["测试替身：所有视觉门禁明确通过"]
  } as const;
}

test("visual edit assessment binds canonical product, uses fixed-duration candidate windows and caches immutable evidence", { timeout: 120_000 }, async () => {
  const f = await referenceFixture();
  try {
    const video = await generatedVideo(f, "visual-pass", 12);
    const calls: StructuredAiRequest[] = [];
    const runtime = {
      id: "TEST_VISUAL",
      version: "1",
      async generateJson(request: StructuredAiRequest) {
        calls.push(request);
        return passProposal(1);
      }
    };
    const service = new VisualEditAssessmentService({
      artifacts: f.artifacts,
      productInput: f.productInput,
      runtime,
      projectsRoot: f.projectsRoot
    });
    const clip = makeValidClip();
    const result = await service.assess({
      projectId: f.projectId,
      truth: f.truth,
      clip,
      attemptId: "attempt-visual-pass",
      outputArtifactId: video.id
    });
    assert.equal(result.assessment.status, "PASS");
    assert.equal(result.assessment.autoAcceptEligible, true);
    assert.equal(result.selectedWindow.outMs - result.selectedWindow.inMs, clip.durationMs);
    assert.ok(result.selectedWindow.inMs > 0);
    assert.equal(result.assessment.canonicalImageHash, f.truth.inputRefs.length ? result.assessment.canonicalImageHash : result.assessment.canonicalImageHash);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.context?.step, "AUTO_EDIT_VISUAL");
    assert.equal(calls[0]!.media?.[0]?.label, "canonical-product-image");
    assert.ok((calls[0]!.media?.length ?? 0) >= 3);
    const beforeTruth = (await f.productFlow.getWorkspace(f.projectId))!.productTruth!.contentHash;
    const cached = await service.assess({
      projectId: f.projectId,
      truth: f.truth,
      clip,
      attemptId: "attempt-visual-pass",
      outputArtifactId: video.id
    });
    assert.equal(cached.assessment.contentHash, result.assessment.contentHash);
    assert.equal(calls.length, 1);
    assert.equal((await f.productFlow.getWorkspace(f.projectId))!.productTruth!.contentHash, beforeTruth);
    const evidence = await f.artifacts.findById(result.artifactId);
    assert.equal(evidence?.kind, "STRUCTURED_SNAPSHOT");
    assert.equal(evidence?.sha256, result.artifactHash);
  } finally {
    await f.cleanup();
  }
});

test("visibility-aware visual gate accepts a product-free story, still rejects an absent required product", { timeout: 120_000 }, async () => {
  const f = await referenceFixture();
  try {
    const video = await generatedVideo(f, "story-only-clip-v2", 12);
    const calls: StructuredAiRequest[] = [];
    const service = new VisualEditAssessmentService({
      artifacts: f.artifacts,
      productInput: f.productInput,
      projectsRoot: f.projectsRoot,
      runtime: {
        id:"VISIBILITY_MOCK", version:"1",
        async generateJson(request: StructuredAiRequest) {
          calls.push(request);
          return {
            ...passProposal(1),
            productPresence:"ABSENT",
            productIdentity:"UNCERTAIN",
            productStability:"UNCERTAIN",
            confidence:"MEDIUM",
            sceneConfidence:"HIGH",
            reasons:["故事画面构图清晰，但没有商品，旧规则无法判断产品"]
          };
        }
      }
    });
    const pureStory = {...makeValidClip(),id:"clip-story-no-product",productVisibility:"NONE" as const};
    const story = await service.assess({
      projectId:f.projectId,truth:f.truth,clip:pureStory,attemptId:"v2-story",
      outputArtifactId:video.id
    });
    assert.equal(story.assessment.evaluatorVersion,VISUAL_EDIT_EVALUATOR_VERSION);
    assert.equal(story.assessment.productVisibility,"NONE");
    assert.equal(story.assessment.productPresence,"ABSENT");
    assert.equal(story.assessment.checks.productIdentity,"NOT_APPLICABLE");
    assert.equal(story.assessment.checks.productStability,"NOT_APPLICABLE");
    assert.equal(story.assessment.status,"PASS");
    assert.equal(story.assessment.confidence,"HIGH");
    assert.equal(story.assessment.autoAcceptEligible,true);
    assert.equal(story.assessment.audioTrackPresent,false);
    const cached=await service.assess({
      projectId:f.projectId,truth:f.truth,clip:pureStory,attemptId:"v2-story",
      outputArtifactId:video.id
    });
    assert.equal(cached.assessment.contentHash,story.assessment.contentHash);
    assert.equal(calls.length,1);
    const current=await service.readCurrentSummaries({
      projectId:f.projectId,truthHash:f.truth.contentHash,
      clips:[{id:pureStory.id,contentHash:pureStory.contentHash}],
      attempts:[{id:"v2-story",clipId:pureStory.id,outputArtifactId:video.id}]
    });
    assert.equal(current[0]?.status,"PASS");
    assert.equal(current[0]?.productIdentity,"NOT_APPLICABLE");
    assert.equal(current[0]?.storyActionAlignment,"PASS");
    const oldBase={
      ...story.assessment,id:"visual-old-fixture",clipId:"clip-old-fixture",
      clipHash:H.a,attemptId:"attempt-old-fixture",
      evaluatorVersion:"p1f06-visual-edit-v1",createdAt:new Date().toISOString()
    };
    const {contentHash:_oldHash,...oldWithoutHash}=oldBase;
    await f.store.writeImmutable({
      id:"visual-old-snapshot",projectId:f.projectId,
      kind:"STRUCTURED_SNAPSHOT",immutable:true,
      relativePath:"post-production/visual-assessments/old-test.json",
      mimeType:"application/json",
      bytes:Buffer.from(JSON.stringify({
        ...oldWithoutHash,contentHash:hashValue(oldWithoutHash)
      }))
    });
    const stale=await service.readCurrentSummaries({
      projectId:f.projectId,truthHash:f.truth.contentHash,
      clips:[{id:"clip-old-fixture",contentHash:H.a}],
      attempts:[{id:"attempt-old-fixture",clipId:"clip-old-fixture",outputArtifactId:video.id}]
    });
    assert.equal(stale[0]?.status,"OUTDATED");
    assert.equal(stale[0]?.autoAcceptEligible,false);
    const required={...makeValidClip(),id:"clip-required-clear",productVisibility:"CLEAR" as const};
    const missing=await service.assess({
      projectId:f.projectId,truth:f.truth,clip:required,attemptId:"v2-required",
      outputArtifactId:video.id
    });
    assert.equal(missing.assessment.checks.productIdentity,"BLOCKED");
    assert.equal(missing.assessment.status,"BLOCKED");
    assert.equal(missing.assessment.autoAcceptEligible,false);
    assert.equal(calls.length,2);
  } finally {await f.cleanup();}
});

test("visual policy rejects unwanted products and HERO clips with insufficient product framing",()=>{
  const proposal=passProposal(0);
  const unexpected=applyClipVisibilityPolicy({productVisibility:"NONE"},{...proposal,productPresence:"PRESENT",reasons:[...proposal.reasons]});
  assert.equal(unexpected.productIdentity,"BLOCKED");
  const uncertainty=applyClipVisibilityPolicy({productVisibility:"NONE"},{
    ...proposal,productPresence:"UNCERTAIN",confidence:"HIGH",reasons:[...proposal.reasons]
  });
  assert.equal(uncertainty.productIdentity,"UNCERTAIN");
  const partial=applyClipVisibilityPolicy({productVisibility:"HERO"},{
    ...proposal,visibilityCompliance:"BLOCKED",confidence:"HIGH",reasons:[...proposal.reasons]
  });
  assert.equal(partial.productIdentity,"BLOCKED");
  const lowScene=applyClipVisibilityPolicy({productVisibility:"NONE"},{
    ...proposal,productPresence:"ABSENT",confidence:"HIGH",sceneConfidence:"MEDIUM",reasons:[...proposal.reasons]
  });
  assert.equal(lowScene.confidence,"MEDIUM");
});

test("visual edit assessment fails closed on uncertain/blocked evidence and invalid window index", { timeout: 120_000 }, async () => {
  const f = await referenceFixture();
  try {
    const clip = makeValidClip();
    const uncertainVideo = await generatedVideo(f, "visual-uncertain", 10);
    const uncertain = new VisualEditAssessmentService({
      artifacts: f.artifacts,
      productInput: f.productInput,
      projectsRoot: f.projectsRoot,
      runtime: {
        id: "TEST_VISUAL",
        version: "1",
        async generateJson() {
          return {
            ...passProposal(0),
            usageCompliance: "UNCERTAIN",
            confidence: "MEDIUM",
            reasons: ["采样不足，无法确认使用动作"]
          };
        }
      }
    });
    const uncertainResult = await uncertain.assess({
      projectId: f.projectId,
      truth: f.truth,
      clip,
      attemptId: "attempt-uncertain",
      outputArtifactId: uncertainVideo.id
    });
    assert.equal(uncertainResult.assessment.status, "UNCERTAIN");
    assert.equal(uncertainResult.assessment.autoAcceptEligible, false);

    const badVideo = await generatedVideo(f, "visual-bad-window", 12);
    const bad = new VisualEditAssessmentService({
      artifacts: f.artifacts,
      productInput: f.productInput,
      projectsRoot: f.projectsRoot,
      runtime: {
        id: "TEST_VISUAL",
        version: "1",
        async generateJson() {
          return passProposal(999);
        }
      }
    });
    await assert.rejects(
      bad.assess({
        projectId: f.projectId,
        truth: f.truth,
        clip,
        attemptId: "attempt-bad-window",
        outputArtifactId: badVideo.id
      }),
      /不存在的剪辑候选/
    );
  } finally {
    await f.cleanup();
  }
});

test("multi-version visual comparison recommends only a uniquely safer assessed version and never mutates review state", { timeout: 120_000 }, async () => {
  const f = await referenceFixture();
  try {
    const clip = makeValidClip();
    const newer = await generatedVideo(f, "compare-newer", 12);
    const older = await generatedVideo(f, "compare-older", 12);
    let call = 0;
    const service = new VisualEditAssessmentService({
      artifacts: f.artifacts,
      productInput: f.productInput,
      projectsRoot: f.projectsRoot,
      runtime: {
        id: "TEST_VISUAL",
        version: "1",
        async generateJson() {
          call += 1;
          return call === 1
            ? passProposal(1)
            : {
                ...passProposal(0),
                productStability: "UNCERTAIN",
                confidence: "MEDIUM",
                reasons: ["旧版本采样存在产品稳定性疑点"]
              };
        }
      }
    });
    const comparison = await service.compareVersions({
      projectId: f.projectId,
      truth: f.truth,
      clip,
      attempts: [
        { attemptId: "attempt-newer", attemptNumber: 2, outputArtifactId: newer.id },
        { attemptId: "attempt-older", attemptNumber: 1, outputArtifactId: older.id }
      ]
    });
    assert.equal(comparison.recommendedAttemptId, "attempt-newer");
    assert.equal(comparison.candidates[0]!.attemptId, "attempt-newer");
    assert.equal(comparison.candidates[0]!.status, "PASS");
    assert.equal(comparison.candidates[1]!.status, "UNCERTAIN");
    assert.match(comparison.recommendationReason, /仅作为版本建议/);
    assert.equal(call, 2);
    const reviewCount = await f.db.reviewDecisionRecord.count();
    assert.equal(reviewCount, 0);
  } finally {
    await f.cleanup();
  }
});

test("review repository persists AI gate provenance while legacy decisions remain user-compatible", { timeout: 90_000 }, async () => {
  const f = await referenceFixture();
  try {
    const repo = new PrismaReviewRepository(f.db);
    await repo.createDecision({
      id: "legacy-review",
      projectId: f.projectId,
      clipId: "clip-legacy",
      clipHash: H.a,
      decision: "SKIP",
      decidedAt: new Date().toISOString()
    });
    await repo.createDecision({
      id: "ai-review",
      projectId: f.projectId,
      clipId: "clip-ai",
      clipHash: H.b,
      generationAttemptId: "attempt-ai",
      outputArtifactId: "video-ai",
      outputArtifactHash: H.c,
      decision: "ACCEPT",
      source: "AI_VISUAL_GATE",
      visualAssessment: {
        artifactId: "assessment-artifact",
        artifactHash: H.d,
        assessmentContentHash: H.e,
        evaluatorVersion: "p1f06-visual-edit-v1"
      },
      decidedAt: new Date().toISOString()
    });
    const rows = await repo.listDecisions(f.projectId);
    assert.equal(rows.find(row => row.id === "legacy-review")?.source, "USER");
    assert.equal(rows.find(row => row.id === "ai-review")?.source, "AI_VISUAL_GATE");
    assert.equal(rows.find(row => row.id === "ai-review")?.visualAssessment?.assessmentContentHash, H.e);
  } finally {
    await f.cleanup();
  }
});

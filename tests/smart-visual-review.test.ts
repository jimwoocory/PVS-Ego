import test from "node:test";
import assert from "node:assert/strict";
import { ApplicationSmartProduction } from "../src/application/services/smart-production-adapter.js";
import { SmartFlowPause } from "../src/application/ports/smart-production.js";
import type { SmartGenerationRun } from "../src/domain/smart-generation.js";
import { makeProductTruth, makeValidClip, H, ISO } from "./fixtures.js";

function harness(input: { enabled: boolean; eligible: boolean; clipCount?: number; ineligibleClipIndices?: number[] }) {
  const projectId = "project-smart-visual";
  const clip = { ...makeValidClip(), id: "clip-smart-visual" };
  const clips = Array.from({length:input.clipCount??1},(_,index)=>({
    ...structuredClone(clip),id:index===0?clip.id:"clip-smart-visual-"+(index+1),
    order:index+1
  }));
  const truth = { ...makeProductTruth(), projectId };
  const project = {
    id: projectId,
    name: "smart visual fixture",
    status: "GENERATION_REVIEW",
    targetPlatform: "douyin",
    targetDurationMs: 8000,
    aspectRatio: "9:16",
    createdAt: ISO,
    updatedAt: ISO
  };
  const plan = {
    id: "plan-smart-visual",
    projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: { entityType: "ProductTruth", entityId: truth.id, version: truth.version, hash: truth.contentHash },
    scriptRef: { entityType: "ScriptDraft", entityId: "script", version: 1, hash: H.a },
    selectedCreativeId: "creative",
    visualDirection: "fixture",
    soundDirection: "fixture",
    productShowcaseRules: [],
    continuityLock: { product: { forbiddenChanges: truth.forbiddenChanges }, characters: [], environments: [] },
    scenes: [{ id: "scene", order: 1, purpose: "fixture", location: "studio", visualState: "stable", stableElements: [], sourceBeatIds: [], requiredFactIds: [], clips }],
    contentHash: H.b,
    confirmedAt: ISO
  };
  const workspace = { project, productTruth: truth, productionPlan: plan };
  const attempt = {
    id: "attempt-smart-visual",
    projectId,
    clipId: clip.id,
    attemptNumber: 1,
    status: "SUCCEEDED",
    outputArtifactId: "video-smart-visual"
  };
  const attempts = clips.map((c,index)=>({
    ...attempt,id:index===0?attempt.id:"attempt-smart-visual-"+(index+1),
    clipId:c.id,attemptNumber:1
  }));
  const decisions: any[] = [];
  let visualCalls = 0;
  const service = new ApplicationSmartProduction({
    productFlow: {
      async getWorkspace() { return workspace; }
    },
    review: {
      async listDecisions() { return decisions; }
    },
    workflow: {
      async listGenerationAttempts() { return attempts; }
    },
    visualReview: {
      async assess({clip:c}:{clip:{id:string}}) {
        const index=clips.findIndex(x=>x.id===c.id);
        const eligible=input.eligible && !(input.ineligibleClipIndices??[]).includes(index);
        visualCalls++;
        return {
          artifactId: "visual-artifact",
          artifactHash: H.c,
          selectedWindow: { index: 0, inMs: 0, outMs: clip.durationMs },
          assessment: {
            contentHash: H.d,
            evaluatorVersion: "p1f06-visual-edit-v1",
            autoAcceptEligible: eligible,
            status: eligible ? "PASS" : "UNCERTAIN",
            confidence: eligible ? "HIGH" : "MEDIUM",
            reasons: [eligible ? "all gates pass" : "identity uncertain"]
          }
        };
      }
    },
    reviewService: {
      async decide(value: any) {
        decisions.push({
          id: "review-ai",
          projectId,
          clipId: value.clipId,
          clipHash: clips.find(c=>c.id===value.clipId)!.contentHash,
          generationAttemptId: value.generationAttemptId,
          outputArtifactId: attempt.outputArtifactId,
          outputArtifactHash: H.e,
          decision: value.decision,
          source: value.source,
          visualAssessment: value.visualAssessment,
          decidedAt: ISO
        });
        if(decisions.length>=clips.length)project.status="READY_TO_ASSEMBLE";
        return { decision: decisions.at(-1), projectStatus: project.status };
      }
    }
  } as any);
  const run = {
    id: "run-smart-visual",
    projectId,
    attemptIds: attempts.map(a=>a.id),
    options: {
      autoSelectLowRiskClips: input.enabled
    }
  } as unknown as SmartGenerationRun;
  return { service, run, decisions, getVisualCalls: () => visualCalls };
}

test("smart run only auto-accepts after explicit opt-in and a high-confidence visual gate", async () => {
  const h = harness({ enabled: true, eligible: true });
  await h.service.reviewClips(h.run);
  assert.equal(h.getVisualCalls(), 1);
  assert.equal(h.decisions.length, 1);
  assert.equal(h.decisions[0]!.source, "AI_VISUAL_GATE");
  assert.equal(h.decisions[0]!.decision, "ACCEPT");
  assert.equal(h.decisions[0]!.visualAssessment.evaluatorVersion, "p1f06-visual-edit-v1");
});

test("smart run falls back to human review when visual evidence is uncertain", async () => {
  const h = harness({ enabled: true, eligible: false });
  await assert.rejects(
    h.service.reviewClips(h.run),
    (error: unknown) =>
      error instanceof SmartFlowPause &&
      error.code === "VISUAL_REVIEW_REQUIRED" &&
      error.status === "WAITING_FOR_CLIP_REVIEW"
  );
  assert.equal(h.getVisualCalls(), 1);
  assert.equal(h.decisions.length, 0);
});

test("checks all six shots before a single AI acceptance and pinpoints every failing shot", async()=>{
  const h=harness({enabled:true,eligible:true,clipCount:6,ineligibleClipIndices:[0,4]});
  await assert.rejects(h.service.reviewClips(h.run),(error:unknown)=>{
    assert.ok(error instanceof SmartFlowPause);
    const e=error as SmartFlowPause;
    assert.equal(e.code,"VISUAL_REVIEW_REQUIRED");
    assert.match(e.message,/视频 1/);
    assert.match(e.message,/视频 5/);
    assert.doesNotMatch(e.message,/UNCERTAIN\/MEDIUM/);
    return true;
  });
  assert.equal(h.getVisualCalls(),6);
  assert.equal(h.decisions.length,0,"No AI acceptance may precede the last shot's review");
});

test("six independently high-confidence shots are adopted only after their full set passes", async()=>{
  const h=harness({enabled:true,eligible:true,clipCount:6});
  await h.service.reviewClips(h.run);
  assert.equal(h.getVisualCalls(),6);
  assert.equal(h.decisions.length,6);
  assert.ok(h.decisions.every(d=>d.source==="AI_VISUAL_GATE"&&d.decision==="ACCEPT"));
});

test("smart run never invokes visual auto-review unless the user explicitly enabled it", async () => {
  const h = harness({ enabled: false, eligible: true });
  await assert.rejects(
    h.service.reviewClips(h.run),
    (error: unknown) =>
      error instanceof SmartFlowPause &&
      error.code === "OUTPUT_REVIEW_REQUIRED"
  );
  assert.equal(h.getVisualCalls(), 0);
  assert.equal(h.decisions.length, 0);
});

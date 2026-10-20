import test from "node:test";
import assert from "node:assert/strict";
import type { CompiledPrompt } from "../src/domain/schemas.js";
import { H, ISO } from "./fixtures.js";
import { compileReviewedContinuityInput, type SourceBinding } from "../src/application/services/continuity-request-compiler.js";

const ref=(entityType:"ProductTruth"|"CreativeBatch"|"ScriptDraft"|"ProductionPlan")=>({
  entityType,entityId:"fixture-"+entityType,version:1,hash:H.a
});
const compiled:CompiledPrompt={
  id:"prompt-source-test",projectId:"project-1",clipId:"clip-2",version:1,
  status:"CURRENT",provider:"domestic-jimeng-cli",model:"seedance-2.0",
  productTruthRef:ref("ProductTruth"),creativeBatchRef:ref("CreativeBatch"),
  selectedCreativeId:"creative-1",scriptRef:ref("ScriptDraft"),
  productionPlanRef:ref("ProductionPlan"),clipHash:H.a,
  segmentHashes:{},compilerTemplateVersion:"v8-compiled-snapshot",
  promptText:"演员走进房间，镜头与上段动作衔接。保持原生台词及环境音，不生成背景音乐。",
  inputAssetManifest:[],factMapping:[],segmentMapping:[],constraintMapping:[],
  generationParams:{durationMs:8000,aspectRatio:"9:16",generateAudio:true},
  compiledPromptHash:H.b,createdAt:ISO
};
const source:SourceBinding={
  version:"continuity-source-binding-1",sourceClipId:"clip-1",sourceAttemptId:"attempt-1",
  sourceVideoArtifactId:"video-1",sourceVideoSha256:H.a,
  tailFrameArtifactId:"tail-1",tailFrameSha256:H.b,
  reviewDecisionId:"accepted-1",reviewDecisionHash:H.c,
  reviewedEvidenceArtifactId:"evidence-1",reviewedEvidenceHash:H.d,
  contractHash:H.e,relationship:"HARD_CONTINUITY"
};
test("reviewed tail compiles into a genuinely dedicated first-frame input and a new consent-bound hash",()=>{
  const result=compileReviewedContinuityInput({compiled,source});
  assert.equal(result.continuitySource?.tailFrameArtifactId,"tail-1");
  assert.equal(result.inputAssetManifest[0]?.assetId,"tail-1");
  assert.equal(result.inputAssetManifest[0]?.artifactHash,H.b);
  assert.equal(result.imageBindings?.[0]?.providerSlot,"FIRST_FRAME");
  assert.equal(result.imageBindings?.[0]?.artifactHash,H.b);
  assert.match(result.promptText,/尾帧@图片1/);
  assert.notEqual(result.compiledPromptHash,compiled.compiledPromptHash);
  assert.ok(result.promptText.startsWith(compiled.promptText));
});
test("hard first-frame refuses to silently discard existing independent character and scene references",()=>{
  const conflicted:CompiledPrompt={...compiled,inputAssetManifest:[{
    assetId:"actor-1",artifactHash:H.c,role:"CHARACTER",priority:1,required:true,inputType:"image"
  }]};
  assert.throws(()=>compileReviewedContinuityInput({compiled:conflicted,source}),/无法同时输入/);
  const cameraCut=compileReviewedContinuityInput({compiled:conflicted,source:{...source,relationship:"SAME_SCENE_CUT"}});
  assert.equal(cameraCut.promptText,compiled.promptText);
  assert.equal(cameraCut.inputAssetManifest[0]?.assetId,"actor-1");
});

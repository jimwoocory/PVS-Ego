import test from "node:test";
import assert from "node:assert/strict";
import type { ClipTransitionContract, ActualClipObservation } from "../src/application/services/clip-continuity-engine.js";
import { chooseContinuityGenerationInput } from "../src/application/services/continuity-generation-choice.js";

const H=(x:string)=>x.repeat(64);
const contract:ClipTransitionContract={
  version:"clip-continuity-contract-1",sourceClipId:"A",targetClipId:"B",
  sourceSceneId:"court",targetSceneId:"court",
  relationship:"HARD_CONTINUITY",plannedSourceEndStateHash:H("a"),
  plannedTargetStartStateHash:H("a"),approvedProductionPlanHash:H("d"),
  reason:"卷宗同一动作",actorAnchors:[],propAnchors:[],
  requiresSourceGeneration:true,requiresHardFirstFrame:true,contentHash:H("e")
};
const observation:ActualClipObservation={
  version:"actual-clip-observation-1",clipId:"A",generationAttemptId:"attempt-A",
  mediaSha256:H("f"),tailFrameArtifactId:"tail-A",tailFrameSha256:H("b"),
  tailFrameTimestampMs:9900,analysisStatus:"REVIEWED",
  actorObservations:[],propObservations:[]
};
const capabilities={
  image2video:{available:true,allowsExplicitRatio:true,nativeAudio:true},
  frames2video:{available:true,allowsExplicitRatio:true,nativeAudio:false},
  multimodal2video:{available:true,allowsExplicitRatio:true,nativeAudio:true}
};
const base={contract,observation,aspectRatio:"9:16",nativeAudioRequested:true,
  additionalReferenceImages:0,capability:capabilities};
test("hard continuity must wait for approved actual last frame",()=>{
  assert.equal(chooseContinuityGenerationInput({...base,observation:undefined}).status,"WAIT_SOURCE");
  assert.equal(chooseContinuityGenerationInput({...base,observation:{...observation,analysisStatus:"PENDING"}}).status,"WAIT_SOURCE");
  assert.equal(chooseContinuityGenerationInput({...base,observation:{...observation,analysisStatus:"REJECTED"}}).status,"NEEDS_REVIEW");
});
test("dedicated first input uses exact frame ID/hash; never silently adds a reference-image group",()=>{
  const decision=chooseContinuityGenerationInput(base);
  assert.equal(decision.status,"READY");
  assert.equal(decision.operation,"image2video");
  assert.deepEqual(decision.firstFrame,{artifactId:"tail-A",sha256:H("b"),providerSlot:"FIRST_FRAME"});
  assert.equal(decision.mustConfirmNewPaidScope,true);
  assert.equal(chooseContinuityGenerationInput({...base,additionalReferenceImages:2}).status,"UNSUPPORTED");
});
test("unsupported audio/ratio/operation blocks before paid submission",()=>{
  assert.equal(chooseContinuityGenerationInput({...base,aspectRatio:"AUTO"}).status,"UNSUPPORTED");
  assert.equal(chooseContinuityGenerationInput({...base,specifiedEndFrame:{artifactId:"end",sha256:H("c")}}).status,
    "UNSUPPORTED");
  assert.equal(chooseContinuityGenerationInput({...base,capability:{
    ...capabilities,image2video:{...capabilities.image2video,allowsExplicitRatio:false}
  }}).status,"UNSUPPORTED");
});
test("same scene camera cut does not need identical last/first pixel",()=>{
  const normal:ClipTransitionContract={...contract,relationship:"SAME_SCENE_CUT",
    requiresHardFirstFrame:false};
  const decision=chooseContinuityGenerationInput({...base,contract:normal});
  assert.equal(decision.status,"READY");
  assert.equal(decision.operation,"multimodal2video");
  assert.equal(decision.firstFrame,undefined);
});

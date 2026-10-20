import test from "node:test";
import assert from "node:assert/strict";
import { planNextContinuityWave } from "../src/application/services/continuity-wave-planner.js";
import type { V8PromptRecord } from "../src/domain/v8-production.js";
const hex=(c:string)=>c.repeat(64);
const pkg=(clipId:string,sourceClipId?:string,relationship?:"HARD_CONTINUITY"|"SAME_SCENE_CUT"|"SCENE_OR_TIME_JUMP"|"REVIEW_REQUIRED")=>({
  clipId,
  ...(sourceClipId&&relationship ? {incomingContinuity:{sourceClipId,relationship,
    plannedSourceEndStateHash:hex("a"),plannedTargetStartStateHash:hex("a"),
    contractHash:hex("b"),requiresHardFirstFrame:relationship==="HARD_CONTINUITY"}} : {})
}) as Pick<V8PromptRecord["packages"][number],"clipId"|"incomingContinuity">;
const packages=[pkg("a"),pkg("b","a","HARD_CONTINUITY"),pkg("c","b","SAME_SCENE_CUT"),pkg("d","c","SCENE_OR_TIME_JUMP")];
test("continuity waves isolate first paid batch and require human review before dependent batches",()=>{
  const first=planNextContinuityWave({packages,attemptedClipIds:new Set(),acceptedClipIds:new Set()});
  assert.equal(first.status,"READY");
  assert.deepEqual(first.clipIds,["a","d"]);
  const waiting=planNextContinuityWave({packages,attemptedClipIds:new Set(["a","d"]),acceptedClipIds:new Set(["a"])});
  assert.equal(waiting.status,"WAITING_FOR_REVIEW");
  const second=planNextContinuityWave({packages,attemptedClipIds:new Set(["a","d"]),acceptedClipIds:new Set(["a","d"])});
  assert.deepEqual(second.clipIds,["b"]);
  assert.deepEqual(second.sourceClipIds,["a"]);
  const third=planNextContinuityWave({packages,attemptedClipIds:new Set(["a","b","d"]),acceptedClipIds:new Set(["a","b","d"])});
  assert.deepEqual(third.clipIds,["c"]);
  const end=planNextContinuityWave({packages,attemptedClipIds:new Set(["a","b","c","d"]),acceptedClipIds:new Set(["a","b","c","d"])});
  assert.equal(end.status,"COMPLETE");
});
test("rejects unresolved transitions, duplicate IDs and backwards dependencies",()=>{
  assert.throws(()=>planNextContinuityWave({packages:[pkg("a"),pkg("b","a","REVIEW_REQUIRED")],
    attemptedClipIds:new Set(["a"]),acceptedClipIds:new Set(["a"])}),/未明确审核/);
  assert.throws(()=>planNextContinuityWave({packages:[pkg("a"),pkg("a")],
    attemptedClipIds:new Set(),acceptedClipIds:new Set()}),/重复/);
  assert.throws(()=>planNextContinuityWave({packages:[pkg("a","b","HARD_CONTINUITY"),pkg("b")],
    attemptedClipIds:new Set(),acceptedClipIds:new Set()}),/来源必须属于/);
});

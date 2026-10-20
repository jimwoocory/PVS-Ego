import test from "node:test";
import assert from "node:assert/strict";
import type { ProductionPlan } from "../src/domain/schemas.js";
import { makeValidClip, H } from "./fixtures.js";
import {
  buildClipContinuityGraph, checkTransitionReady, firstSourceIndependentClipIds,
  affectedContinuationClipIds, reviewAcceptedActualClipObservation,
  type ContinuityDecision, type ActualClipObservation
} from "../src/application/services/clip-continuity-engine.js";

const state = (stateHash: string, description: string) => ({
  stateHash, description, productState: "卷宗", environmentState: "县衙",
  characterState: description
});
function clip(id: string, sceneId: string, open: string, close: string) {
  return { ...makeValidClip(), id, sceneId,
    openingState: state(open, "人物站在公堂"),
    closingState: state(close, "县令握卷宗"),
    segments: [],
    referenceAssets: []
  };
}
const plan = (scenes: {id:string;clips:ReturnType<typeof clip>[]}[]): Pick<ProductionPlan, "contentHash" | "scenes"> => {
  return { contentHash: H.a, scenes: scenes.map(s => ({ id:s.id, clips:s.clips })) } as unknown as Pick<ProductionPlan, "contentHash" | "scenes">;
};
const reference = () => plan([{ id: "court", clips: [
  clip("clip-a", "court", H.b, H.c),
  clip("clip-b", "court", H.c, H.d)
]}]);

test("initial paid scope chooses independent clips and excludes dependent continuations",()=>{
  const chosen=firstSourceIndependentClipIds([
    {clipId:"A"},
    {clipId:"B",incomingContinuity:{relationship:"HARD_CONTINUITY"}},
    {clipId:"C",incomingContinuity:{relationship:"SCENE_OR_TIME_JUMP"}},
    {clipId:"D",incomingContinuity:{relationship:"SAME_SCENE_CUT"}}
  ]);
  assert.deepEqual(chosen,["A","C"]);
  assert.throws(()=>firstSourceIndependentClipIds([{clipId:"A"},{clipId:"A"}]),/重复视频编号/);
});
test("redo dependency traversal invalidates only until a real scene jump",()=>{
  const p=plan([
    {id:"court",clips:[
      clip("A","court",H.a,H.b),
      clip("B","court",H.b,H.c),
      clip("C","court",H.c,H.d)
    ]},
    {id:"street",clips:[
      clip("D","street",H.e,H.a),
      clip("E","street",H.a,H.b)
    ]}
  ]);
  const graph=buildClipContinuityGraph(p);
  assert.deepEqual(affectedContinuationClipIds(graph,"A"),["B","C"]);
  assert.deepEqual(affectedContinuationClipIds(graph,"D"),["E"]);
  assert.deepEqual(affectedContinuationClipIds(graph,"E"),[]);
});
test("matching in-scene states produce HARD continuity with a dependency", () => {
  const graph = buildClipContinuityGraph(reference());
  assert.equal(graph.unresolved.length, 0);
  const contract = graph.transitions[0]!;
  assert.equal(contract.relationship, "HARD_CONTINUITY");
  assert.equal(contract.requiresHardFirstFrame, true);
  assert.equal(checkTransitionReady(contract, undefined).status, "WAIT_SOURCE");
});

test("inconsistent states do not silently become a harmless camera cut", () => {
  const p=plan([{id:"court",clips:[
    clip("clip-a","court",H.a,H.b),clip("clip-b","court",H.d,H.e)
  ]}]);
  const graph = buildClipContinuityGraph(p);
  assert.deepEqual(graph.unresolved, ["clip-a→clip-b"]);
  assert.equal(checkTransitionReady(graph.transitions[0]!,undefined).status,"NEEDS_REVIEW");
  const decision:ContinuityDecision = {sourceClipId:"clip-a",targetClipId:"clip-b",
    relationship:"SAME_SCENE_CUT",approvedPlanHash:H.a,reason:"正常反打，卷宗留在县令手中",
    actorAnchors:[{actorKey:"县令",wardrobe:"红官袍"}],
    propAnchors:[{propKey:"卷宗",ownerActorKey:"县令"}]};
  const reviewed=buildClipContinuityGraph(p,[decision]);
  assert.equal(reviewed.transitions[0]?.relationship,"SAME_SCENE_CUT");
  assert.equal(reviewed.transitions[0]?.requiresHardFirstFrame,false);
  assert.throws(()=>buildClipContinuityGraph(p,[{...decision,actorAnchors:[],propAnchors:[] }]),
    /至少一条人物或道具/);
  assert.throws(()=>buildClipContinuityGraph(p,[{...decision,relationship:"HARD_CONTINUITY"}]),
    /结束和下一段开始/);
});

test("a planned scene change does not force equal frames", () => {
  const p=plan([
    {id:"court",clips:[clip("clip-a","court",H.a,H.b)]},
    {id:"street",clips:[clip("clip-b","street",H.d,H.e)]}
  ]);
  const graph=buildClipContinuityGraph(p);
  assert.equal(graph.transitions[0]?.relationship,"SCENE_OR_TIME_JUMP");
  assert.equal(checkTransitionReady(graph.transitions[0]!,undefined).status,"READY");
  assert.throws(()=>buildClipContinuityGraph(p,[{
    sourceClipId:"clip-a",targetClipId:"clip-b",relationship:"HARD_CONTINUITY",
    approvedPlanHash:H.a,reason:"impossible",actorAnchors:[],propAnchors:[]
  }]),/场景划分不一致/);
});

test("actual final-frame SHA gates a strong-dependent successor", () => {
  const contract=buildClipContinuityGraph(reference()).transitions[0]!;
  const actual: ActualClipObservation={version:"actual-clip-observation-1",
    clipId:"clip-a",generationAttemptId:"attempt-a",mediaSha256:H.a,
    tailFrameArtifactId:"last-frame-a",tailFrameSha256:H.d,
    tailFrameTimestampMs:9950,analysisStatus:"REVIEWED",
    actorObservations:[],propObservations:[]};
  assert.equal(checkTransitionReady(contract,{...actual,analysisStatus:"PENDING"}).status,"WAIT_SOURCE");
  assert.equal(checkTransitionReady(contract,{...actual,analysisStatus:"REJECTED"}).status,"NEEDS_REVIEW");
  const ready=checkTransitionReady(contract,actual);
  assert.equal(ready.status,"READY");
  assert.equal(ready.firstFrameArtifactId,"last-frame-a");
  assert.equal(ready.firstFrameSha256,H.d);
});

test("only exact current user-adopted actual output may promote tail evidence",()=>{
  const obs:ActualClipObservation={version:"actual-clip-observation-1",
    clipId:"clip-a",generationAttemptId:"attempt-a",
    mediaSha256:H.a,tailFrameArtifactId:"tail-a",tailFrameSha256:H.c,
    tailFrameTimestampMs:9800,analysisStatus:"PENDING",
    actorObservations:[],propObservations:[]};
  const sourceAttempt={id:"attempt-a",clipId:"clip-a",outputArtifactId:"media-a",status:"SUCCEEDED"};
  const sourceArtifact={id:"media-a",sha256:H.a,integrityStatus:"READY"};
  const adoption={clipId:"clip-a",clipHash:H.d,generationAttemptId:"attempt-a",
    outputArtifactId:"media-a",outputArtifactHash:H.a,decision:"ACCEPT",decidedAt:"2026-10-10T20:00:00Z"};
  const data={observation:obs,sourceAttempt,sourceArtifact,
    currentLatestSuccessfulAttemptId:"attempt-a",expectedClipHash:H.d,
    decisions:[adoption]};
  assert.equal(reviewAcceptedActualClipObservation(data).analysisStatus,"REVIEWED");
  assert.throws(()=>reviewAcceptedActualClipObservation({...data,currentLatestSuccessfulAttemptId:"new-attempt"}),/最新成功/);
  assert.throws(()=>reviewAcceptedActualClipObservation({...data,decisions:[]}),/未经用户准确采用/);
  assert.throws(()=>reviewAcceptedActualClipObservation({...data,decisions:[
    adoption,{...adoption,decision:"REDO",decidedAt:"2026-10-10T20:05:00Z"}
  ]}),/决定重做/);
});
test("stale or non-adjacent manual director decisions are rejected", () => {
  const dec:ContinuityDecision={sourceClipId:"clip-a",targetClipId:"clip-b",
    relationship:"SAME_SCENE_CUT",approvedPlanHash:H.d,reason:"切机位",
    actorAnchors:[{actorKey:"县令"}],propAnchors:[]};
  assert.throws(()=>buildClipContinuityGraph(reference(),[dec]),/旧分镜版本/);
  assert.throws(()=>buildClipContinuityGraph(reference(),[{
    ...dec,approvedPlanHash:H.a,targetClipId:"unknown"
  }]),/非相邻/);
});

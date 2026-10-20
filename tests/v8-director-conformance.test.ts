import test from "node:test";
import assert from "node:assert/strict";
import { hashValue } from "../src/domain/hashing.js";
import { makeValidClip, makeProductTruth, H } from "./fixtures.js";
import { compileV8AuthoritativePrompts } from "../src/application/services/v8-authoritative-prompt.js";
import type { ScriptDraft } from "../src/domain/schemas.js";
import type { ProductionAssetSet } from "../src/domain/production-strategy.js";
import type { V8DirectorDecision } from "../src/application/services/v8-director-decision.js";
import type { ProductionPlan } from "../src/domain/schemas.js";
import {
  reviewV8DirectorConformance,assertV8DirectorConformance
} from "../src/application/services/v8-director-conformance.js";

function fixture(){
  const clip=makeValidClip();
  clip.sourceBeatIds=["beat-one"];
  const expected: V8DirectorDecision = {
    version:"v8-director-decision-1" as const,
    sourceScriptHash:H.a,screenplayHash:H.b,targetDurationMs:8000,
    modelDurationCapability:{minSeconds:4,maxSeconds:15},
    clips:[{
      clipId:"v8:clip:1",order:1,durationMs:8000,location:"卧室",
      sourceBeatIds:["beat-one"],
      openingState:"产品在桌上",closingState:"主人公已开口",
      sourceAfterReveal:["观众知道产品是什么"],
      shots:[{
        shotId:"shot-1",sourceBeatId:"beat-one",startMs:0,endMs:4000,
        shotFunction:"ESTABLISH" as const,visibleAction:"建立卧室内的人物空间关系",
        cameraDecisionsPending:true as const,blockingDecisionsPending:true as const
      },{
        shotId:"shot-2",sourceBeatId:"beat-one",startMs:4000,endMs:8000,
        shotFunction:"SPEECH" as const,visibleAction:"主人公开口解释，室友听着",
        cameraDecisionsPending:true as const,blockingDecisionsPending:true as const,
        spoken:{
          speaker:"主人公",mode:"ONSCREEN" as const,exactText:"这是我的产品。",
          tone:"平静",delivery:"慢速、完整尾音",voiceAssetStatus:"NEEDS_BINDING" as const,
          speechEstimatedMs:1900
        },
        audienceKnowledgeChange:"观众知道产品是什么"
      }]
    }],
    traceability:{totalLines:1,coveredLines:1,sourceBeats:1,coveredBeats:1},
    status:"DRAFT_NEEDS_VISUAL_DIRECTING" as const,contentHash:H.c
  };
  for(const [index,segment] of clip.segments.entries()){
    const shot=expected.clips[0]!.shots[index]!;
    segment.sourceBeatIds=["beat-one"];
    segment.v8={
      sourceShotId:shot.shotId,sourceBeatId:shot.sourceBeatId,
      sourceActionHash:hashValue(shot.visibleAction),
      shotFunction:shot.shotFunction,
      ...(shot.spoken?{spoken:{
        speaker:shot.spoken.speaker,mode:shot.spoken.mode,
        exactText:shot.spoken.exactText,tone:shot.spoken.tone,
        delivery:shot.spoken.delivery
      }}:{}),
      ...(shot.audienceKnowledgeChange?{audienceKnowledgeChange:shot.audienceKnowledgeChange}:{})
    };
    segment.dialogueOrNarration=index===0?{kind:"NONE"}:{
      kind:"DIALOGUE",text:"主人公：“这是我的产品。”",
      estimatedDurationMs:1900,estimatorVersion:"test"
    };
  }
  const plan={
    scriptRef:{entityType:"ScriptDraft",entityId:"script",version:1,hash:H.a},
    visualDirection:"写实，人物眼神与道具必须清晰",
    contentHash:H.d,
    generationTarget:{requestedModelVersion:"seedance2.0mini",aspectRatio:"9:16",videoResolution:"720p"},
    scenes:[{location:"卧室",timeOfDay:"DAY",clips:[clip]}]
  } as unknown as ProductionPlan;
  return {expected,plan};
}

test("V8 authoritative compiler preserves locked Shot/director audio and separates post-production text",()=>{
  const {expected,plan}=fixture();
  const clip=plan.scenes[0]!.clips[0]!;
  clip.referenceAssets=[{assetId:"asset-a",role:"CHARACTER",priority:0,required:true}];
  const truth=makeProductTruth();
  const script={
    id:"script",version:1,projectId:truth.projectId,
    targetDurationMs:8000,contentHash:H.a,
    beats:[{
      id:"beat-one",order:1,purpose:"PRODUCT",
      text:"主人公介绍产品",estimatedDurationMs:8000,
      requiredFactIds:[],
      videoIntent:{
        location:"卧室",storyAction:"主人公开口解释，室友听着",
        productRole:"作为对话目标",stateIn:"准备介绍",stateOut:"已经介绍",
        dialogue:"主人公：“这是我的产品。”",
        audioIntent:{ambience:[],sfx:[],bgm:false},
        postProductionText:["后期标识"]
      }
    }]
  } as unknown as ScriptDraft;
  clip.segments[1]!.postProductionText=[{
    kind:"LABEL",text:"后期标识",startMs:5100,endMs:7800,
    position:"BOTTOM",fontScale:1,
    sourceBeatIds:["beat-one"],requiredFactIds:[]
  }];
  const assets={
    entries:[{kind:"CHARACTER",key:"CHARACTER_A",
      status:"READY",label:"主人公",referenceAssetId:"asset-a"}]
  } as ProductionAssetSet;
  const packageList=compileV8AuthoritativePrompts({
    script,truth,decision:expected,plan,assets,
    speakerBindings:{主人公:{actorAssetKey:"CHARACTER_A",voiceType:"固定清晰声音"}}
  });
  assert.equal(packageList.length,1);
  const item=packageList[0]!;
  assert.match(item.promptText,/【镜头 02】/);
  assert.match(item.promptText,/配音指令：主人公\|固定清晰声音\|平静\|慢速、完整尾音/);
  assert.match(item.promptText,/主人公：“这是我的产品。”/);
  assert.equal((item.promptText.match(/禁止生成背景音乐/g)||[]).length,1);
  assert.doesNotMatch(item.promptText,/后期标识/);
  assert.deepEqual(item.postProductionText.map(x=>x.exactText),["后期标识"]);
  assert.equal(item.audioManifest[0]?.voiceType,"固定清晰声音");
});
test("V8 authoritative compiler rejects missing voice identity and cannot use a drifting director plan",()=>{
  const {expected,plan}=fixture();
  const truth=makeProductTruth();
  const script={id:"script",version:1,contentHash:H.a,targetDurationMs:8000,beats:[]} as unknown as ScriptDraft;
  const assets={entries:[]} as unknown as ProductionAssetSet;
  plan.scenes[0]!.clips[0]!.segments[1]!.v8=undefined;
  assert.throws(()=>compileV8AuthoritativePrompts({
    script,truth,decision:expected,plan,assets,speakerBindings:{}
  }),/不一致/);
});

test("V8 ProductDirector Gate allows visual variation without altering story",()=>{
  const {expected,plan}=fixture();
  const report=reviewV8DirectorConformance(expected,plan);
  assert.equal(report.passed,true,JSON.stringify(report.issues));
  assert.equal(report.lockedShots,2);
  assert.doesNotThrow(()=>assertV8DirectorConformance(expected,plan));
  plan.scenes[0]!.clips[0]!.segments[1]!.composition="更有层次的构图但保留演员台词与焦点";
  assert.equal(reviewV8DirectorConformance(expected,plan).passed,true);
});
test("V8 ProductDirector Gate blocks wrong transcript and speaker metadata",()=>{
  const {expected,plan}=fixture();
  plan.scenes[0]!.clips[0]!.segments[1]!.dialogueOrNarration={
    kind:"DIALOGUE",text:"主人公：“这是另一件产品。”",
    estimatedDurationMs:1700,estimatorVersion:"test"
  };
  assert.equal(reviewV8DirectorConformance(expected,plan).passed,false);
  assert.throws(()=>assertV8DirectorConformance(expected,plan),/不一致/);
});
test("V8 ProductDirector Gate rejects shot timing, source action and reveal tampering",()=>{
  const {expected,plan}=fixture();
  const shot=plan.scenes[0]!.clips[0]!.segments[1]!;
  shot.endMs=7400;
  shot.v8!.sourceActionHash=H.f;
  shot.v8!.audienceKnowledgeChange="提前暴露";
  const codes=reviewV8DirectorConformance(expected,plan).issues.map(issue=>issue.code);
  assert.ok(codes.includes("SHOT_TIME_DRIFT"));
  assert.ok(codes.includes("SHOT_SOURCE_DRIFT"));
  assert.ok(codes.includes("REVEAL_TIMING_DRIFT"));
});
test("V8 ProductDirector Gate fails closed without structured shot metadata",()=>{
  const {expected,plan}=fixture();
  plan.scenes[0]!.clips[0]!.segments.forEach(segment=>{delete segment.v8;});
  const report=reviewV8DirectorConformance(expected,plan);
  assert.equal(report.passed,false);
  assert.equal(report.issues.filter(issue=>issue.code==="SHOT_METADATA_MISSING").length,2);
});

test("V8 ProductDirector Gate locks the original full utterance and semantic part ordering",()=>{
  const {expected,plan}=fixture();
  const source=expected.clips[0]!.shots[1]!.spoken!;
  source.sourceLineText="这是我的产品。";
  source.sourcePartIndex=1;
  source.sourcePartCount=2;
  const actual=plan.scenes[0]!.clips[0]!.segments[1]!.v8!.spoken!;
  // An older visual director that drops the new lineage is not allowed through.
  assert.ok(reviewV8DirectorConformance(expected,plan).issues
    .some(issue=>issue.code==="SPEAKER_OR_VOICE_DRIFT"));
  actual.sourceLineText=source.sourceLineText;
  actual.sourcePartIndex=source.sourcePartIndex;
  actual.sourcePartCount=source.sourcePartCount;
  assert.equal(reviewV8DirectorConformance(expected,plan).passed,true);
  actual.sourcePartIndex=2;
  assert.ok(reviewV8DirectorConformance(expected,plan).issues
    .some(issue=>issue.code==="SPEAKER_OR_VOICE_DRIFT"));
});

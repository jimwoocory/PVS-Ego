import test from "node:test";
import assert from "node:assert/strict";
import { buildV8ScreenplayShadow } from "../src/application/services/v8-screenplay-shadow.js";
import type { ScriptDraft } from "../src/domain/schemas.js";
import { H } from "./fixtures.js";

function sample(): ScriptDraft {
  return {
    id:"script-screenplay-test", projectId:"project-1", version:3,
    status:"CONFIRMED", productTruthRef: {entityType:"ProductTruth",entityId:"truth",version:1,hash:H.a},
    creativeBatchRef: {entityType:"CreativeBatch",entityId:"batch",version:1,hash:H.b},
    selectedCreativeId:"creative",targetDurationMs:20000,contentHash:H.c,
    beats:[{
      id:"beat-1",order:1,purpose:"HOOK",text:"人物发现一件未说明来源的物品。",
      estimatedDurationMs:10000,requiredFactIds:[],
      videoIntent:{
        location:"卧室",storyAction:"室友发现异常并提问",
        productRole:"暂不出现",stateIn:"两人站在卧室",stateOut:"问题提出",
        dialogue:"室友：“这是什么？”主人公：“你猜猜。”",
        audioIntent:{ambience:["卧室"],sfx:[],bgm:false},
        postProductionText:[]
      }
    },{
      id:"beat-2",order:2,purpose:"PRODUCT",text:"主人公展示产品，解开谜底。",
      estimatedDurationMs:10000,requiredFactIds:["fact-1"],
      videoIntent:{
        location:"卧室",storyAction:"主人公展示产品",
        productRole:"作为谜底出现",stateIn:"产品被遮挡",stateOut:"产品可见",
        dialogue:"主人公：“答案就是这件产品。”",
        audioIntent:{ambience:["卧室"],sfx:[],bgm:false},
        postProductionText:[]
      }
    }]
  } as ScriptDraft;
}
test("V8 screenplay shadows source Beats and exact dialogue into one scene without inventing details",()=>{
  const current=sample();
  const source=structuredClone(current);
  const result=buildV8ScreenplayShadow(current);
  assert.equal(result.originalBeatCount,2);
  assert.equal(result.transcribedBeatCount,2);
  assert.equal(result.scenes.length,1);
  assert.equal(result.scenes[0]!.plannedDurationMs,20000);
  assert.equal(result.dialogueLineCount,3);
  assert.deepEqual(result.scenes[0]!.beats.flatMap(b=>b.lines.map(x=>x.exactText)),
    ["这是什么？","你猜猜。","答案就是这件产品。"]);
  assert.equal(result.scenes[0]!.interiorExterior,"UNSPECIFIED");
  assert.equal(result.scenes[0]!.timeOfDay,"UNSPECIFIED");
  assert.equal(result.scenes[0]!.beats[0]!.actorMotivation,undefined);
  assert.equal(result.scenes[0]!.beats[1]!.audienceReveal,undefined);
  assert.ok(result.issues.some(x=>x.code==="REVEAL_TIMING_NOT_EXPLICIT"));
  assert.deepEqual(current,source);
});
test("V8 screenplay does not manufacture an absent speech speaker",()=>{
  const current=sample();
  current.beats[0]!.videoIntent!.dialogue="说话者身份不清的一句台词";
  const result=buildV8ScreenplayShadow(current);
  assert.equal(result.status,"BLOCKED");
  assert.ok(result.issues.some(x=>x.code==="DIALOGUE_UNPARSEABLE"));
  assert.equal(result.scenes[0]!.beats[0]!.lines.length,0);
});
test("V8 screenplay keeps source scene boundaries, refuses to fabricate unknown location",()=>{
  const current=sample();
  current.beats[1]!.videoIntent!.location="客厅";
  const preview=buildV8ScreenplayShadow(current);
  assert.equal(preview.scenes.length,2);
  assert.deepEqual(preview.scenes.map(x=>x.location),["卧室","客厅"]);
  current.beats[1]!.videoIntent=undefined;
  const absent=buildV8ScreenplayShadow(current);
  assert.equal(absent.scenes[1]!.location,"位置待确认");
  assert.equal(absent.status,"BLOCKED");
});

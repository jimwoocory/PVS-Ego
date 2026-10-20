import test from "node:test";
import assert from "node:assert/strict";
import type { StructuredAiRuntime, StructuredAiRequest } from "../src/application/ports/structured-ai-runtime.js";
import { V8DetailedScreenplayService, reviseV8DetailedProposal } from "../src/application/services/v8-detailed-screenplay-service.js";
import type { CreativeBatch } from "../src/domain/schemas.js";
import { makeProductTruth, H, ISO } from "./fixtures.js";

const truth = makeProductTruth();
function batch(): CreativeBatch {
  return {
    id: "batch-v8", projectId:truth.projectId, version:1,status:"ACTIVE",
    productTruthRef:{entityType:"ProductTruth",entityId:truth.id,version:truth.version,hash:truth.contentHash},
    generatorVersion:"test@1",contentHash:H.b,createdAt:ISO,
    concepts:Array.from({length:4},(_,i)=>({
      id:"concept-"+i,title:"短剧创意"+i,targetAudience:"居家观众",
      painPoint:"日常场景的认识偏差",hook:"发现新事物",
      coreSellingPoint:"经确认的产品特征",narrativePattern:"误会-揭晓",
      expectedDurationMs:10000,productShowcaseStrategy:"自然露出",
      generationRisk:"LOW" as const,requiredFactIds:[]
    }))
  };
}
function output() {
  return {
    title:"卧室里的新发现",premise:"室友误以为床边出现陌生物品。",
    storyConflict:"室友想知道原因，主人公暂时不解释。",
    finalOutcome:"主人公展示产品，室友理解误会。",
    scenes:[{
      location:"卧室",interiorExterior:"INT",timeOfDay:"DAY",
      situation:"两位成年人正在谈话。",
      dramaticPurpose:"从疑问推进到展示产品。",
      actorObjectives:[
        {speaker:"室友",wants:"弄清物品来源",obstacle:"不知道答案"},
        {speaker:"主人公",wants:"解释实际情况",obstacle:"室友误解"}
      ],
      beats:[{
        purpose:"HOOK",action:"室友发现床边产品并提出疑问",
        actorAction:"室友看向床边并问主人公",
        stateIn:"室友未发现",stateOut:"室友开始发问",
        productRole:"引发疑问",estimatedDurationMs:5000,requiredFactIds:[],
        audienceKnowledgeChange:"观众知道室友正在询问。",
        dialogue:[{speaker:"室友",mode:"ONSCREEN",text:"这是什么？",tone:"困惑",delivery:"轻声、正常语速"}],
        postProductionText:[],ambience:["卧室环境声"],sfx:[]
      },{
        purpose:"PRODUCT",action:"主人公指向床边产品并回答",
        actorAction:"主人公指向枕头，给室友解释",
        stateIn:"室友正在询问",stateOut:"室友知道产品名称",
        productRole:"产品正式揭晓",estimatedDurationMs:5000,
        requiredFactIds:["fact-1"],audienceKnowledgeChange:"观众知道谜底是产品",
        dialogue:[{speaker:"主人公",mode:"ONSCREEN",text:"这是我们的产品。",tone:"平静",
          delivery:"语速正常、尾音完整"}],
        postProductionText:["产品名称"],ambience:["卧室环境声"],sfx:[]
      }]
    }]
  };
}
function fixture(data:unknown) {
  const calls:StructuredAiRequest[] = [];
  const runtime:StructuredAiRuntime = {
    id:"fixture-v8",version:"1",generateJson:async request=>{
      calls.push(request);return data;
    }
  };
  return { service:new V8DetailedScreenplayService(runtime),calls };
}
const input = {
  truth,batch:batch(),selectedCreativeId:"concept-0",
  userBrief:"想拍一段有趣的产品短剧。",targetDurationMs:10000,version:1
};

test("Detailed V8 screenplay expands a vague brief with explicit scenes, roles and exact dialogue", async()=>{
  const mock=fixture(output());
  const result=await mock.service.propose(input);
  assert.equal(mock.calls.length,1);
  assert.equal(mock.calls[0]!.context?.step,"SCRIPT");
  assert.equal(result.screenplay.scenes.length,1);
  assert.equal(result.screenplay.scenes[0]!.actorObjectives.length,2);
  assert.equal(result.legacyScriptDraft.beats.length,2);
  assert.equal(result.legacyScriptDraft.beats[0]!.videoIntent?.dialogue,"室友：“这是什么？”");
  assert.equal(result.legacyScriptDraft.beats[1]!.videoIntent?.dialogue,"主人公：“这是我们的产品。”");
  assert.equal(result.legacyScriptDraft.beats[1]!.requiredFactIds[0],"fact-1");
  assert.equal(result.legacyScriptDraft.beats.reduce((s,b)=>s+b.estimatedDurationMs,0),10000);
  assert.equal(result.legacyScriptDraft.status,"DRAFT");
  assert.equal(result.sourceBrief,input.userBrief);
});

test("Detailed V8 screenplay refuses unconfirmed or invented factual references",async()=>{
  const changed=output();
  changed.scenes[0]!.beats[1]!.requiredFactIds=["invented-fact"];
  const mock=fixture(changed);
  await assert.rejects(()=>mock.service.propose(input),/Fact ID|事实库/);
  const invalid=fixture(output());
  await assert.rejects(()=>invalid.service.propose({
    ...input,truth:{...truth,status:"DRAFT"}
  }),/先确认产品事实/);
  assert.equal(invalid.calls.length,0);
});
test("Detailed V8 screenplay refuses wrong duration and unbound line speaker",async()=>{
  const wrong=output();
  wrong.scenes[0]!.beats[0]!.estimatedDurationMs=4000;
  await assert.rejects(()=>fixture(wrong).service.propose(input),/总时长/);
  const speaker=output();
  speaker.scenes[0]!.beats[1]!.dialogue[0]!.speaker="未出场的人";
  await assert.rejects(()=>fixture(speaker).service.propose(input),/出场人物/);
});

test("V8 detailed script manual revision keeps each Beat identity and checks all original constraints",async()=>{
  const initial=await fixture(output()).service.propose(input);
  const original=initial.legacyScriptDraft;
  const revisedProposal=structuredClone(initial.screenplay);
  revisedProposal.scenes[0]!.beats[0]!.dialogue[0]!.text="你能解释一下这是什么吗？";
  revisedProposal.scenes[0]!.beats[0]!.actorAction="室友先看向床边，再把问题说清楚";
  revisedProposal.scenes[0]!.beats[0]!.postProductionText=["场次标题"];
  const revise=(screenplay:unknown)=>reviseV8DetailedProposal({
    screenplay,
    existingScript:original,
    truth,
    batch:input.batch,
    selectedCreativeId:input.selectedCreativeId,
    targetDurationMs:input.targetDurationMs
  });
  const result=revise(revisedProposal);
  assert.equal(result.version,original.version+1);
  assert.deepEqual(result.beats.map(beat=>beat.id),original.beats.map(beat=>beat.id));
  assert.notEqual(result.contentHash,original.contentHash);
  assert.equal(result.beats[0]!.videoIntent?.dialogue,"室友：“你能解释一下这是什么吗？”");
  assert.equal(result.beats[0]!.videoIntent?.storyAction,"室友先看向床边，再把问题说清楚");
  assert.deepEqual(result.beats[0]!.videoIntent?.postProductionText,["场次标题"]);
  assert.equal(result.beats.reduce((s,b)=>s+b.estimatedDurationMs,0),10000);
  const overDuration=structuredClone(revisedProposal);
  overDuration.scenes[0]!.beats[0]!.estimatedDurationMs+=500;
  assert.throws(()=>revise(overDuration),/总时长/);
  const invented=structuredClone(revisedProposal);
  invented.scenes[0]!.beats[0]!.requiredFactIds=["invented-fact"];
  assert.throws(()=>revise(invented),/Fact ID/);
  const additional=structuredClone(revisedProposal);
  additional.scenes[0]!.beats.push(structuredClone(additional.scenes[0]!.beats[0]!));
  assert.throws(()=>revise(additional),/增删节拍/);
});

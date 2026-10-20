import assert from "node:assert/strict";
import test from "node:test";
import { SmartGenerationService } from "../src/application/services/smart-generation-service.js";
import { ScriptFeasibilityService } from "../src/application/services/script-feasibility-service.js";
import { MemorySmartRuns, FixtureProduction, smartOptions } from "./smart-test-support.js";
import { runnableSmartStatuses, type SmartGenerationRun } from "../src/domain/smart-generation.js";
import type { SmartProduction } from "../src/application/ports/smart-production.js";
import { H, ISO, makeProductTruth } from "./fixtures.js";
import { renderSmartGenerationPage } from "../src/web/smart-generation-ui.js";

const offlineQA = new ScriptFeasibilityService({ id:"mock",version:"1",generateJson:async()=>{throw Error("no model calls");} });
async function preparePaidGate() {
  const repo = new MemorySmartRuns(), production=new FixtureProduction();
  const service = new SmartGenerationService(repo, production);
  let run=await service.create("project-1","script-rhythm-case",smartOptions,2);
  for(let i=0;i<30&&runnableSmartStatuses.includes(run.status);i++)
    run=await service.advance(run.projectId,run.id);
  assert.equal(run.status,"WAITING_FOR_CREATIVE_REVIEW");
  run=await service.review(run.projectId,run.id,{
    action:"SELECT_CREATIVE",expectedRevision:run.revision,creativeId:"creative-1"
  });
  for(let i=0;i<40&&runnableSmartStatuses.includes(run.status);i++)
    run=await service.advance(run.projectId,run.id);
  assert.equal(run.status,"READY_FOR_PAID_CONFIRM");
  assert.ok(run.script && run.paidScope);
  const template=run.script.beats[0]!;
  const beats=Array.from({length:4},(_,i)=>({
    ...structuredClone(template),
    id:"rhythm-uniform-"+i,order:i+1,
    text:"县令坐在公堂前，师爷站在旁边，县令问今夜为什么还有公务，师爷提醒先把休息时间留给自己，案卷慢慢被合起。",
    estimatedDurationMs:3750,
    videoIntent:{
      location:"公堂",storyAction:"县令看向师爷，听到劝告后放下案卷",
      productRole:"产品不出现",stateIn:"县令仍在工作",stateOut:"县令准备停止公务",
      audioIntent:{ambience:["公堂自然环境音"],sfx:["轻放案卷声"],bgm:false as const},postProductionText:[]
    }
  }));
  const old={
    ...run,options:{...run.options,directorVersion:3 as const},
    script:{...run.script,beats,targetDurationMs:15000,contentHash:H.e}
  };
  repo.runs.set(run.id,structuredClone(old));
  return {repo,production,service,run:old};
}

test("historically PASS but mechanically uniform V3 script cannot acquire new paid approval",async()=>{
  const {production,service,run}=await preparePaidGate();
  const consent={scopeHash:run.paidScope!.hash,confirmPaidGeneration:true,acceptedUnknownCostRisk:true};
  await assert.rejects(service.confirmPaid(run.projectId,run.id,consent),/当前剧本节奏|重新编排/);
  assert.equal((await service.get(run.projectId,run.id))?.consent,undefined);
  assert.equal(production.counts.approvals,0);
  assert.equal(production.counts.generate,0);
});

test("explicit revision-bound V3 repair leaves the historical paid scope unusable and waits for script review",async()=>{
  const {repo,production,service,run}=await preparePaidGate();
  let repairCalls=0;
  const prepared=production as FixtureProduction & { repairNarrativeScriptV3: NonNullable<SmartProduction["repairNarrativeScriptV3"]> };
  prepared.repairNarrativeScriptV3=async old=>{
    repairCalls++;
    const script=old.script!;
    const varied=[3500,5000,6500];
    const revised={
      ...script,id:"script-reworked-rhythm",version:script.version+1,
      status:"DRAFT" as const,confirmedAt:undefined,contentHash:H.f,
      beats:script.beats.slice(0,3).map((beat,index)=>({
        ...beat,id:"beat-unique-"+index,estimatedDurationMs:varied[index]!,
        text:[
          "县令在古装公堂上质问为何晚间仍有公务，师爷指着案卷说明忙碌缘由，县令听后露出倦意。",
          "师爷告诉县令明日同样能审理，县令看了看桌上的最后一卷公文，慢慢改变今夜继续的念头。",
          "县令把案卷合上递给师爷，叮嘱明早再来办理；师爷接过卷宗离开，休息的决定终于落定。"
        ][index]!
      }))
    };
    const feasibility=offlineQA.review(revised);
    assert.equal(feasibility.status,"PASS",JSON.stringify(feasibility.issues));
    return {script:revised,feasibility};
  };
  await assert.rejects(service.repairScriptV3(run.projectId,run.id,{
    expectedRevision:run.revision,confirmScriptRepair:false
  }),/必须确认/);
  assert.equal(repairCalls,0);
  await assert.rejects(service.repairScriptV3(run.projectId,run.id,{
    expectedRevision:run.revision+1,confirmScriptRepair:true
  }),/已更新|版本/);
  assert.equal(repairCalls,0);
  const updated=await service.repairScriptV3(run.projectId,run.id,{
    expectedRevision:run.revision,confirmScriptRepair:true
  });
  assert.equal(repairCalls,1);
  assert.equal(updated.status,"WAITING_FOR_SCRIPT_REVIEW");
  assert.equal(updated.stage,"SCRIPT");
  assert.equal(updated.pendingInstall,undefined);
  assert.equal(updated.script?.version,run.script!.version+1);
  assert.equal(updated.scriptFeasibility?.status,"PASS");
  assert.ok(updated.script?.beats.some(beat=>beat.estimatedDurationMs!==3750));
  assert.equal(updated.paidScope,undefined);
  assert.equal(updated.consent,undefined);
  assert.equal(updated.productionPlan,undefined);
  assert.equal(updated.directorV3Plan,undefined);
  assert.equal(updated.seedancePromptDrafts,undefined);
  assert.deepEqual(updated.attemptIds,[]);
  assert.equal(production.counts.generate,0);
  assert.ok(repo.history.some(item=>item.id===run.id&&item.paidScope?.hash===run.paidScope?.hash));
  await assert.rejects(service.confirmPaid(run.projectId,run.id,{
    scopeHash:run.paidScope!.hash,confirmPaidGeneration:true,acceptedUnknownCostRisk:true
  }),/旧页面|当前镜头与费用/);
});

test("unqualified legacy V3 script visibly hides the stale paid-submit button", async()=>{
  const {run}=await preparePaidGate();
  const workspace={
    project:{id:run.projectId,name:"本机测试未付款短剧",status:"READY_TO_GENERATE" as const,
      targetPlatform:"douyin" as const,targetDurationMs:15000,aspectRatio:"9:16" as const,
      createdAt:ISO,updatedAt:ISO},
    productTruth:makeProductTruth()
  };
  const html=renderSmartGenerationPage(workspace,[run],{
    productInput:{assets:[{type:"image"}]} as never
  });
  assert.match(html,/费用确认已暂停：请先修订剧本/);
  assert.match(html,/按剧情重新编排/);
  assert.match(html,/data-action="repair-script-v3"/);
  assert.doesNotMatch(html,/data-action="paid"/);
  assert.doesNotMatch(html,/class="confirm-paid"/);
});


import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Project } from "../src/domain/schemas.js";
import type { SmartGenerationRun, SmartRunStatus, SmartStage } from "../src/domain/smart-generation.js";
import { resolveWorkflowReadModel } from "../src/application/services/workflow-read-model.js";
import { resolveWorkflowNavigation } from "../src/application/services/workflow-navigation.js";
import { renderProjectsPage, layout } from "../src/web/workbench-ui.js";
import { handleSmartGenerationHttp } from "../src/web/smart-generation-http.js";

const pid="ux-r1-project";
const project=(status:Project["status"] = "READY_TO_GENERATE", id=pid)=>({
  id,status,name:"UX R1 实际状态测试",updatedAt:"2026-10-09T01:00:00Z"
} as Project);
const run=(id:string,status:SmartRunStatus,updatedAt:string,stage:SmartStage="CLIP_REVIEW",projectId=pid)=>({
  id,projectId,status,stage,updatedAt,createdAt:"2026-10-08T04:00:00.000Z"
} as SmartGenerationRun);
const current = run("run-old","WAITING_FOR_CLIP_REVIEW","2026-10-08T09:00:00Z");
const newer = run("run-new","READY_FOR_ASSET_PAID_CONFIRM","2026-10-09T00:00:00Z","ASSET_PREP");
const input=(runs:SmartGenerationRun[],status:Project["status"]="READY_TO_GENERATE",selectedRunId?:string)=>({
  project:project(status),productInputPresent:true,productImagePresent:true,
  productTruthConfirmed:true,runs,...(selectedRunId?{selectedRunId}:{})
});

test("confirmed product truth is DONE even when the new task is still verifying sources",()=>{
  const source=run("new-sources","PLANNING","2026-10-10T02:35:51Z","SOURCES");
  const view=resolveWorkflowReadModel(input([source],"CREATIVE_REVIEW"));
  assert.equal(view.source,"SMART_RUN");
  assert.equal(view.stageLabel,"检查产品资料与参考");
  assert.equal(view.phase,"CREATIVE");
  assert.equal(view.phases.find(p=>p.key==="PRODUCT")?.status,"DONE");
  assert.equal(view.phases.find(p=>p.key==="CREATIVE")?.status,"CURRENT");
  assert.match(view.phaseNote??"",/产品事实已确认/);
  assert.match(view.phaseNote??"",/尚未产出创意/);
  const withoutTruth=resolveWorkflowReadModel({
    ...input([source],"PRODUCT_TRUTH_REVIEW"),productTruthConfirmed:false
  });
  assert.equal(withoutTruth.phase,"PRODUCT");
  assert.equal(withoutTruth.phases.find(p=>p.key==="PRODUCT")?.status,"CURRENT");
});

test("UX-R1 refuses to silently choose the most recently updated of two active tasks",()=>{
  const view=resolveWorkflowReadModel(input([current,newer,run("other","GENERATING","2026-10-10T00:00:00Z","GENERATION","other-project")],"PUBLISHED"));
  assert.equal(view.source,"TASK_SELECTION");
  assert.equal(view.taskSelectionRequired,true);
  assert.equal(view.activeTaskCount,2);
  assert.equal(view.runId,undefined);
  assert.equal(view.action.href,`/projects/${pid}/smart#choose-task`);
  assert.equal(view.taskOptions.length,2);
  assert.deepEqual(view.taskOptions.map(t=>t.runId),["run-new","run-old"]);
  assert.equal(view.publication.projectMarkedPublished,true);
  assert.equal(view.publication.receiptVerification,"NOT_CHECKED");
  assert.match(view.publication.explanation,/不代表本轮新任务已完成/);
  assert.equal(view.action.requiresExplicitConsent,false);
});

test("UX-R1 explicitly selected run remains selected even when another run is newer",()=>{
  const view=resolveWorkflowReadModel(input([current,newer],"PUBLISHED","run-old"));
  assert.equal(view.source,"SMART_RUN");
  assert.equal(view.runId,"run-old");
  assert.equal(view.selectedRunId,"run-old");
  assert.equal(view.taskSelectionRequired,false);
  assert.equal(view.stageLabel,"镜头审片");
  assert.equal(view.phase,"VIDEO");
  assert.equal(view.action.href,`/projects/${pid}/generate?fromSmartRun=run-old`);
  assert.equal(view.returnHref,`/projects/${pid}/smart?activeRun=run-old#smart-run-run-old`);
  const creative=resolveWorkflowReadModel(input([
    run("old-creative","WAITING_FOR_CREATIVE_REVIEW","2026-10-08T07:00:00Z","CREATIVE"),
    newer
  ],"READY_TO_GENERATE","old-creative"));
  assert.equal(creative.action.href,`/projects/${pid}/smart?activeRun=old-creative#smart-run-old-creative`);
  assert.equal(creative.returnHref,creative.action.href);
  assert.ok(view.phases.find(s=>s.key==="VIDEO"&&s.status==="CURRENT"));
  assert.ok(view.phases.find(s=>s.key==="PUBLISH"&&s.status==="OPTIONAL"));
});

test("UX-R1 disallows foreign or closed run selection and leaves the original project untouched",()=>{
  const bad=resolveWorkflowReadModel(input([current,newer],"READY_TO_GENERATE","foreign-run"));
  assert.equal(bad.source,"TASK_SELECTION");
  assert.match(bad.explanation,/不属于该项目/);
  assert.equal(bad.taskOptions.length,2);
  assert.equal(bad.taskOptions.some(t=>t.runId==="foreign-run"),false);
  const closed=resolveWorkflowReadModel(input([run("closed-run","COMPLETED","2026-10-09T00:00:00Z"),current],"PUBLISHED","closed-run"));
  assert.equal(closed.source,"TASK_SELECTION");
  assert.equal(closed.activeTaskCount,1);
  const noActive=resolveWorkflowReadModel(input([], "READY_TO_ASSEMBLE","missing-run"));
  assert.equal(noActive.source,"PROJECT");
  assert.equal(noActive.taskSelectionRequired,false);
  assert.equal(noActive.action.href,`/projects/${pid}/timeline`);
});

test("UX-R1 legacy project adapter produces the same next action used by page navigation",()=>{
  const view=resolveWorkflowReadModel(input([],"CREATIVE_REVIEW"));
  assert.equal(view.source,"PROJECT");
  assert.equal(view.phase,"CREATIVE");
  assert.equal(view.action.href,`/projects/${pid}/creative`);
  const staleTruth = resolveWorkflowReadModel(input([],"PRODUCT_TRUTH_REVIEW"));
  assert.notEqual(staleTruth.action.href,`/projects/${pid}/truth`);
  const waitingFinal = resolveWorkflowReadModel(input([],"FINAL_REVIEW"));
  assert.equal(waitingFinal.phase,"ASSEMBLY");
  const nav=resolveWorkflowNavigation({project:project("CREATIVE_REVIEW"),currentPage:"product",workflow:view});
  assert.equal(nav.globalResumeHref,view.action.href);
  assert.equal(nav.globalResumeText,view.action.label);
  const html=layout("产品输入","<h2>产品原始资料</h2>",project("CREATIVE_REVIEW"),[],nav);
  assert.match(html,/id="workflow-read-model"/);
  assert.match(html,/当前任务下一步/);
  assert.match(html,/选择创意方案/);
});

test("UX-R1 project cards separate historical published marker from an unfinished run",()=>{
  const view=resolveWorkflowReadModel(input([current],"PUBLISHED"));
  const html=renderProjectsPage([project("PUBLISHED")],new Map(),new Map([[pid,view]]));
  assert.match(html,/历史项目状态标记：已发布/);
  assert.match(html,/当前制作任务仍未结束/);
  assert.match(html,/镜头审片/);
  assert.match(html, new RegExp(`/projects/${pid}/smart\\?activeRun=run-old#smart-run-run-old`));
  const choose=resolveWorkflowReadModel(input([current,newer],"PUBLISHED"));
  const chooserPage=renderProjectsPage([project("PUBLISHED")],new Map(),new Map([[pid,choose]]));
  assert.match(chooserPage,/选择当前任务/);
  assert.match(chooserPage,new RegExp(`/projects/${pid}/smart#choose-task`));
});

test("UX-R1 real Timeline and FinalAssembly override stale legacy status only for matching plan",()=>{
  const legacy=input([],"GENERATION_REVIEW");
  const confirmed=resolveWorkflowReadModel({
    ...legacy,timelineStatus:"CONFIRMED",timelinePlanHash:"plan-A",projectPlanHash:"plan-A"
  });
  assert.equal(confirmed.action.href,`/projects/${pid}/final`);
  assert.equal(confirmed.action.label,"渲染并确认最终成片");
  assert.equal(confirmed.phase,"ASSEMBLY");
  const accepted=resolveWorkflowReadModel({
    ...legacy,timelineStatus:"CONFIRMED",timelinePlanHash:"plan-A",
    finalAssemblyStatus:"ACCEPTED",finalAssemblyPlanHash:"plan-A",projectPlanHash:"plan-A"
  });
  assert.equal(accepted.action.label,"查看已确认成片与发布状态");
  assert.equal(accepted.phase,"PUBLISH");
  const draft=resolveWorkflowReadModel({
    ...legacy,timelineStatus:"DRAFT",timelinePlanHash:"plan-A",projectPlanHash:"plan-A"
  });
  assert.equal(draft.action.href,`/projects/${pid}/timeline`);
  assert.equal(draft.phase,"ASSEMBLY");
  const fromOtherPlan=resolveWorkflowReadModel({
    ...legacy,timelineStatus:"CONFIRMED",timelinePlanHash:"old-plan",projectPlanHash:"plan-A"
  });
  assert.notEqual(fromOtherPlan.action.href,`/projects/${pid}/final`);
  const active=resolveWorkflowReadModel({
    ...input([current],"GENERATION_REVIEW"),timelineStatus:"CONFIRMED",timelinePlanHash:"plan-A",projectPlanHash:"plan-A"
  });
  assert.equal(active.source,"SMART_RUN");
  assert.equal(active.action.href,`/projects/${pid}/generate?fromSmartRun=run-old`);
});

test("UX-R1 GET workflow projection is read-only, task choice is explicit and POST forbidden",async()=>{
  const calls={list:0,workspace:0,input:0,paid:0};
  const deps={
    smartGeneration:{
      list:async ()=>{calls.list++;return [current,newer];},
      confirmPaid:async ()=>{calls.paid++;throw Error("must not run");}
    },
    productFlow:{getWorkspace:async (id:string)=>{calls.workspace++;return id===pid?{
      project:project("PUBLISHED"),productTruth:{status:"CONFIRMED"}
    }:null;}},
    productInput:{latest:async ()=>{calls.input++;return {assets:[{type:"image"}]};}}
  } as unknown as Parameters<typeof handleSmartGenerationHttp>[3];
  const server=http.createServer((req,res)=>{void (async()=>{
    const matched=await handleSmartGenerationHttp(req,res,new URL(req.url??"/","http://127.0.0.1"),deps);
    if(!matched){res.writeHead(404);res.end();}
  })().catch(error=>{res.writeHead(500);res.end(String(error));});});
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try{
    const all=await fetch(base+`/api/projects/${pid}/workflow`);
    assert.equal(all.status,200);
    const first=await all.json() as {workflow:ReturnType<typeof resolveWorkflowReadModel>};
    assert.equal(first.workflow.taskSelectionRequired,true);
    const selected=await fetch(base+`/api/projects/${pid}/workflow?activeRun=run-old`);
    assert.equal(selected.status,200);
    const second=await selected.json() as {workflow:ReturnType<typeof resolveWorkflowReadModel>};
    assert.equal(second.workflow.runId,"run-old");
    assert.equal(second.workflow.publication.projectMarkedPublished,true);
    assert.equal((await fetch(base+`/api/projects/${pid}/workflow`,{method:"POST"})).status,405);
    assert.equal((await fetch(base+"/api/projects/absent/workflow")).status,404);
    assert.equal(calls.paid,0);
    assert.equal(calls.list,3);
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

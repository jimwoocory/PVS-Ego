import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  canWorkerAdvanceRun,
  resolveSmartWorkerPolicy,
  startSmartGenerationWorker
} from "../src/application/services/smart-generation-worker.js";
import type { SmartGenerationService } from "../src/application/services/smart-generation-service.js";
import { renderSmartGenerationPage } from "../src/web/smart-generation-ui.js";
import { MemorySmartRuns, FixtureProduction, smartOptions } from "./smart-test-support.js";
import { SmartGenerationService as RealSmartGenerationService } from "../src/application/services/smart-generation-service.js";
import { ISO, makeProductTruth, makeValidClip } from "./fixtures.js";

test("safe worker policy requires an explicit exact scope when global worker is disabled", () => {
  assert.deepEqual(resolveSmartWorkerPolicy({ PVS_SMART_WORKER_DISABLED: "1" }), { mode: "DISABLED" });
  assert.deepEqual(resolveSmartWorkerPolicy({
    PVS_SMART_WORKER_DISABLED: "1", PVS_SMART_WORKER_SCOPED_ENABLED: "1",
    PVS_SMART_WORKER_SCOPE_PROJECT_ID: "project-1"
  }), { mode: "DISABLED" });
  const policy = resolveSmartWorkerPolicy({
    PVS_SMART_WORKER_DISABLED: "1", PVS_SMART_WORKER_SCOPED_ENABLED: "1",
    PVS_SMART_WORKER_SCOPE_PROJECT_ID: "project-1", PVS_SMART_WORKER_SCOPE_RUN_ID: "run-1"
  });
  assert.deepEqual(policy, { mode: "SCOPED", scope: { projectId: "project-1", runId: "run-1" } });
  assert.equal(canWorkerAdvanceRun(policy, "project-1", "run-1"), true);
  assert.equal(canWorkerAdvanceRun(policy, "project-1", "run-other"), false);
  assert.equal(canWorkerAdvanceRun(policy, "project-other", "run-1"), false);
  assert.deepEqual(resolveSmartWorkerPolicy({ PVS_SMART_WORKER_DISABLED: "0" }), { mode: "ALL" });
});

test("managed mode grants new tasks only, preserving the exact old scope", () => {
  const policy = resolveSmartWorkerPolicy({
    PVS_SMART_WORKER_DISABLED: "1", PVS_SMART_WORKER_MANAGED_NEW_RUNS: "1",
    PVS_SMART_WORKER_SCOPED_ENABLED: "1",
    PVS_SMART_WORKER_SCOPE_PROJECT_ID: "old-project",
    PVS_SMART_WORKER_SCOPE_RUN_ID: "old-run"
  });
  assert.equal(policy.mode, "MANAGED");
  assert.equal(canWorkerAdvanceRun(policy, "old-project", "old-run"), true);
  assert.equal(canWorkerAdvanceRun(policy, "new-project", "new-run"), false);
  assert.equal(canWorkerAdvanceRun(policy, "new-project", "new-run",
    { projectId: "new-project", runId: "new-run" }), true);
  assert.equal(canWorkerAdvanceRun(policy, "old-project", "old-other",
    { projectId: "new-project", runId: "new-run" }), false);
  assert.equal(canWorkerAdvanceRun({mode:"DISABLED"}, "new-project", "new-run",
    { projectId: "new-project", runId: "new-run" }), false);
});

test("managed worker never advances or releases an ungranted historical task", async () => {
  const changes:string[] = [], recovered:string[] = [];
  const old = { id:"historical",projectId:"old-project",status:"PLANNING",stage:"SOURCES" };
  const fresh = { id:"fresh",projectId:"fresh-project",status:"PLANNING",stage:"SOURCES",
    autoAdvanceGrant:{projectId:"fresh-project",runId:"fresh",authorizedAt:ISO,source:"USER_CREATED"} };
  const fakeService = {
    list:async()=>[old,fresh],
    get:async()=>{throw Error("managed mode must not run random get");},
    recoverAbandoned:async()=>{throw Error("global recovery must never run");},
    recoverAbandonedScoped:async(projectId:string,id:string)=>{recovered.push(projectId+":"+id);return false;},
    advance:async(projectId:string,id:string)=>{changes.push(projectId+":"+id);fresh.status="WAITING_FOR_CREATIVE_REVIEW";return fresh;}
  } as unknown as SmartGenerationService;
  const failures:string[]=[];
  const stop=startSmartGenerationWorker(fakeService,{
    policy:{mode:"MANAGED"},intervalMs:1500,
    onError:error=>failures.push(String(error))
  });
  try {await delay(100);} finally {stop();}
  assert.deepEqual(failures,[]);
  assert.deepEqual(changes,["fresh-project:fresh"]);
  assert.deepEqual(recovered,["fresh-project:fresh"]);
});

test("existing paused new run requires explicit, revision-bound authorization and never inherits payment", async () => {
  const prev=process.env.PVS_SMART_WORKER_MANAGED_NEW_RUNS;
  try {
    delete process.env.PVS_SMART_WORKER_MANAGED_NEW_RUNS;
    const repository=new MemorySmartRuns(),production=new FixtureProduction();
    const service=new RealSmartGenerationService(repository,production);
    const existing=await service.create("project-1","old-paused",smartOptions,2);
    assert.equal(existing.autoAdvanceGrant,undefined);
    process.env.PVS_SMART_WORKER_MANAGED_NEW_RUNS="1";
    await assert.rejects(service.authorizeAutoAdvance(existing.projectId,existing.id,{
      expectedRevision:existing.revision,confirmCurrentTask:false
    }),/明确授权/);
    await assert.rejects(service.authorizeAutoAdvance(existing.projectId,existing.id,{
      expectedRevision:existing.revision+1,confirmCurrentTask:true
    }),/版本已改变/);
    const resumed=await service.authorizeAutoAdvance(existing.projectId,existing.id,{
      expectedRevision:existing.revision,confirmCurrentTask:true
    });
    assert.equal(resumed.autoAdvanceGrant?.runId,existing.id);
    assert.equal(resumed.autoAdvanceGrant?.source,"USER_RESUMED");
    assert.equal(resumed.revision,existing.revision+1);
    assert.equal(resumed.consent,undefined);
    assert.equal(resumed.assetConsent,undefined);
    assert.deepEqual(resumed.attemptIds,[]);
    await assert.rejects(service.authorizeAutoAdvance(existing.projectId,existing.id,{
      expectedRevision:existing.revision,confirmCurrentTask:true
    }),/版本已改变/);
    const created=await service.create("project-2","new-managed",smartOptions,2);
    assert.equal(created.autoAdvanceGrant?.source,"USER_CREATED");
    assert.equal(created.autoAdvanceGrant?.projectId,created.projectId);
    assert.equal(created.autoAdvanceGrant?.runId,created.id);
    assert.equal(created.consent,undefined);
  } finally {
    if(prev===undefined)delete process.env.PVS_SMART_WORKER_MANAGED_NEW_RUNS;
    else process.env.PVS_SMART_WORKER_MANAGED_NEW_RUNS=prev;
  }
});

test("scoped worker advances only its exact run; never lists or recovers other runs", async () => {
  const touched: string[] = [];
  const recovered: string[] = [];
  const other = { id: "historical", projectId: "project-old", status: "PLANNING" };
  const target = { id: "run-1", projectId: "project-1", status: "PLANNING" };
  const fakeService = {
    get: async (projectId: string, id: string) => {
      assert.equal(projectId, target.projectId);
      assert.equal(id, target.id);
      return target;
    },
    list: async () => { throw new Error("scoped worker must not list all runs"); },
    recoverAbandoned: async () => { throw new Error("scoped worker must not touch old leases"); },
    recoverAbandonedScoped: async (projectId: string, id: string) => {
      recovered.push(projectId + ":" + id);
      return true;
    },
    advance: async (projectId: string, id: string) => {
      touched.push(projectId + ":" + id);
      target.status = "WAITING_FOR_CREATIVE_REVIEW";
      return target;
    }
  } as unknown as SmartGenerationService;
  const failures: string[] = [];
  const stop = startSmartGenerationWorker(fakeService, {
    scope: { projectId: target.projectId, runId: target.id },
    onError: error => failures.push(String(error))
  });
  try {
    await delay(100);
  } finally {
    stop();
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(recovered, ["project-1:run-1"]);
  assert.deepEqual(touched, ["project-1:run-1"]);
  assert.equal(other.status, "PLANNING");
});

test("scoped dead-lease recovery releases only the selected task and preserves live owners", async () => {
  const repo = new MemorySmartRuns();
  const service = new RealSmartGenerationService(repo, new FixtureProduction());
  const target = await service.create("project-1", "target", smartOptions, 2);
  const other = await service.create("project-2", "other", smartOptions, 2);
  const deadPid = 999999; // a definitely absent OS process on our test host
  repo.locks.set(target.id, { owner: "dead-target", pid: deadPid });
  repo.locks.set(other.id, { owner: "dead-other", pid: deadPid });
  assert.equal(await service.recoverAbandonedScoped(target.projectId, target.id), true);
  assert.equal(await repo.lease(target.projectId, target.id), null);
  assert.deepEqual(await repo.lease(other.projectId, other.id), { owner: "dead-other", pid: deadPid });

  // A live executor is never displaced, even if it has held a lease for a long time.
  repo.locks.set(target.id, { owner: "live-target", pid: process.pid });
  assert.equal(await service.recoverAbandonedScoped(target.projectId, target.id), false);
  assert.deepEqual(await repo.lease(target.projectId, target.id), { owner: "live-target", pid: process.pid });
  assert.equal(await service.recoverAbandonedScoped("project-1", other.id), false);
  assert.deepEqual(await repo.lease(other.projectId, other.id), { owner: "dead-other", pid: deadPid });
});

test("workbench sidebar distinguishes confirmed product facts from newly created source checks",async()=>{
  const repo=new MemorySmartRuns();
  const service=new RealSmartGenerationService(repo,new FixtureProduction());
  const run=await service.create("project-1","left-progress",smartOptions,2);
  const html=renderSmartGenerationPage({
    project:{id:"project-1",name:"事实已确认项目",status:"CREATIVE_REVIEW",
      targetPlatform:"douyin",targetDurationMs:15000,aspectRatio:"9:16",
      createdAt:ISO,updatedAt:ISO},
    productTruth:makeProductTruth()
  },[run],{
    workerPolicy:{mode:"MANAGED"},
    productInput:{assets:[{type:"image"}]} as never
  });
  assert.match(html,/产品与事实 · 已确认/);
  assert.match(html,/研究与创意 · 当前/);
  assert.match(html,/产品事实已确认；本轮仍在检查资料关联，尚未产出创意或剧本/);
  assert.match(html,/data-action="authorize-worker"/);
  assert.match(html,/恢复本条任务的自动规划/);
  assert.match(html,/工作流 · 检查产品资料与参考/);
});

test("visual QC uses generic footer above Stop and dynamic clip counts for any project", async()=>{
  const repo=new MemorySmartRuns(),service=new RealSmartGenerationService(repo,new FixtureProduction());
  const template=await service.create("project-1","generic-visual-review",smartOptions,2);
  const workspace={
    project:{id:"project-1",name:"自动视频测试项目",status:"READY_TO_GENERATE" as const,
      targetPlatform:"douyin" as const,targetDurationMs:15000,aspectRatio:"9:16" as const,
      createdAt:ISO,updatedAt:ISO}
  };
  for(const count of [2,5,9]){
    const clips=Array.from({length:count},(_,i)=>({...makeValidClip(),id:"clip-"+i,order:i+1}));
    const run={...template,status:"WAITING_FOR_CLIP_REVIEW" as const,stage:"CLIP_REVIEW" as const,
      blocker:{code:"VISUAL_REVIEW_REQUIRED",retryable:true,
        message:"视频 1：产品身份无法核对，因为开场没有出现产品"},
      productionPlan:{scenes:[{clips}]}
    } as unknown as typeof template;
    const html=renderSmartGenerationPage(workspace,[run]);
    assert.match(html, new RegExp('本轮 '+count+' 条镜头'));
    assert.match(html, new RegExp('逐镜审片 · 查看 '+count+' 条镜头'));
    assert.match(html, new RegExp('id="visual-qc-'+run.id+'"'));
    assert.match(html,/查看生成视频与审核结果/);
    assert.equal((html.match(/data-visual-recheck="1"/g)??[]).length,1);
    assert.ok(html.indexOf('id="visual-qc-'+run.id+'"')>html.indexOf('id="review-panel-'+run.id+'"'));
    assert.ok(html.indexOf('data-visual-recheck="1"')<html.indexOf('data-action="cancel"'));
    assert.match(html,/重新进行视觉质检/);
    assert.doesNotMatch(html,/按新版规则重新检查六条视频|六条均达到/);
    assert.doesNotMatch(html,/视觉 AI 未达到自动采用门槛（UNCERTAIN\/MEDIUM）/);
  }
});

test("web UI shows paused state for excluded runs instead of fake ongoing progress", async () => {
  const repo = new MemorySmartRuns();
  const service = new RealSmartGenerationService(repo, new FixtureProduction());
  const run = await service.create("project-1", "paused-ui", smartOptions, 2);
  const workspace = {
    project: {
      id: "project-1", name: "测试产品", status: "DRAFT" as const,
      targetPlatform: "douyin" as const, targetDurationMs: 15000,
      aspectRatio: "9:16", createdAt: ISO, updatedAt: ISO
    }
  };
  const disabled = renderSmartGenerationPage(workspace, [run], { workerPolicy: { mode: "DISABLED" } });
  assert.match(disabled, /后台自动编排已暂停/);
  assert.match(disabled, /等待当前任务执行器恢复/);
  assert.doesNotMatch(disabled, /程序正在推进已允许的非付费规划步骤/);
  const scoped = renderSmartGenerationPage(workspace, [run], {
    workerPolicy: { mode: "SCOPED", scope: { projectId: run.projectId, runId: run.id } }
  });
  assert.doesNotMatch(scoped, /后台自动编排已暂停/);
  const otherScope = renderSmartGenerationPage(workspace, [run], {
    workerPolicy: { mode: "SCOPED", scope: { projectId: "project-2", runId: "other" } }
  });
  assert.match(otherScope, /后台自动编排已暂停/);
  const managed=renderSmartGenerationPage(workspace,[run],{
    workerPolicy:{mode:"MANAGED"}
  });
  assert.match(managed,/后台编排已暂停/);
  assert.match(managed,/恢复本任务自动规划/);
  assert.match(managed,/data-action="authorize-worker"/);
  const authorized=renderSmartGenerationPage(workspace,[{
    ...run,
    autoAdvanceGrant:{projectId:run.projectId,runId:run.id,authorizedAt:ISO,source:"USER_RESUMED"}
  }],{workerPolicy:{mode:"MANAGED"}});
  assert.doesNotMatch(authorized,/后台编排已暂停/);
  assert.doesNotMatch(authorized,/data-action="authorize-worker"/);
});

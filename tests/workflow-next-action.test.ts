import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { smartRunStatusSchema, type SmartGenerationRun, type SmartRunStatus } from "../src/domain/smart-generation.js";
import type { Project } from "../src/domain/schemas.js";
import { resolveProductionNextAction } from "../src/application/services/workflow-next-action.js";
import { handleSmartGenerationHttp } from "../src/web/smart-generation-http.js";

const PROJECT_ID = "project-workflow-a";
const ISO = "2026-10-08T06:00:00.000Z";
const project = (status: Project["status"] = "READY_TO_GENERATE", id = PROJECT_ID) =>
  ({ id, status } as Project);
const run = (status: SmartRunStatus, options: { id?: string; stage?: SmartGenerationRun["stage"];
  projectId?: string; updatedAt?: string; blocker?: {code: string; message: string; retryable: boolean} } = {}) => ({
  id: options.id ?? "run-123456",
  projectId: options.projectId ?? PROJECT_ID,
  status,
  stage: options.stage ?? "CLIP_REVIEW",
  updatedAt: options.updatedAt ?? ISO,
  createdAt: ISO,
  ...(options.blocker ? { blocker: options.blocker } : {})
} as SmartGenerationRun);
const input = (runs: SmartGenerationRun[], status: Project["status"] = "READY_TO_GENERATE") => ({
  project: project(status), productInputPresent: true, productImagePresent: true,
  productTruthConfirmed: true, runs
});

test("workflow W1 resolves all known smart run statuses into one same-project action", () => {
  const closed = new Set(["CANCELLED","COMPLETED"]);
  for (const status of smartRunStatusSchema.options) {
    const result = resolveProductionNextAction(input([run(status)]));
    assert.match(result.action.href, /^\/projects\/project-workflow-a\//);
    assert.doesNotMatch(result.action.href, /^https?:/);
    assert.equal(result.action.requiresExplicitConsent,
      status === "READY_FOR_ASSET_PAID_CONFIRM" || status === "READY_FOR_PAID_CONFIRM");
    assert.ok(result.action.label.trim());
    assert.ok(result.explanation.trim());
    if (closed.has(status)) {
      assert.equal(result.source, "PROJECT");
    } else {
      assert.equal(result.source, "SMART_RUN");
      assert.equal(result.runId, "run-123456");
      assert.equal(result.returnHref, "/projects/project-workflow-a/smart#smart-run-run-123456");
    }
  }
});

test("workflow prioritizes waiting Smart Run over stale published project status and excludes foreign runs", () => {
  const latest = run("WAITING_FOR_CLIP_REVIEW", {id:"run-latest",stage:"CLIP_REVIEW",updatedAt:"2026-10-08T08:00:00.000Z"});
  const state = resolveProductionNextAction(input([
    run("COMPLETED",{id:"run-old"}), latest,
    run("WAITING_FOR_TRUTH_REVIEW",{id:"run-foreign",projectId:"other-project",updatedAt:"2026-10-09T06:00:00.000Z"})
  ],"PUBLISHED"));
  assert.equal(state.runId,"run-latest");
  assert.equal(state.status,"USER_ACTION");
  assert.equal(state.action.href,"/projects/project-workflow-a/generate?fromSmartRun=run-latest");
  assert.equal(state.returnHref,"/projects/project-workflow-a/smart#smart-run-run-latest");
  assert.equal(state.action.requiresExplicitConsent,false);
});

test("workflow connects factual and creative-reference review to exact matching project", () => {
  const cases = [
    {status:"WAITING_FOR_TRUTH_REVIEW",page:"truth"},
    {status:"WAITING_FOR_REFERENCE_REVIEW",page:"creative-references"},
    {status:"REVIEW_READY",page:"final"}
  ] as const;
  for(const {status,page} of cases) {
    const next = resolveProductionNextAction(input([run(status,{stage:"SOURCES"})]));
    assert.equal(next.action.href,`/projects/${PROJECT_ID}/${page}?fromSmartRun=run-123456`);
    assert.equal(next.status,"USER_ACTION");
  }
});

test("workflow without active run sends users only to real prerequisites and preserves completed output", () => {
  assert.equal(resolveProductionNextAction({
    ...input([],"DRAFT"),productInputPresent:false,productImagePresent:false,
    productTruthConfirmed:false
  }).action.href,`/projects/${PROJECT_ID}/product`);
  assert.equal(resolveProductionNextAction({
    ...input([],"DRAFT"),productTruthConfirmed:false
  }).action.href,`/projects/${PROJECT_ID}/truth`);
  assert.equal(resolveProductionNextAction(input([],"READY_TO_ASSEMBLE")).action.href,`/projects/${PROJECT_ID}/timeline`);
  assert.equal(resolveProductionNextAction(input([],"PUBLISHED")).action.href,`/projects/${PROJECT_ID}/final`);
  assert.equal(resolveProductionNextAction(input([run("COMPLETED")],"READY_TO_GENERATE")).action.href,`/projects/${PROJECT_ID}/final`);
  assert.equal(resolveProductionNextAction(input([run("CANCELLED")],"READY_TO_GENERATE")).action.href,`/projects/${PROJECT_ID}/smart`);
});

test("blocked smart run never returns a submission URL or implies new paid authorization", () => {
  const next = resolveProductionNextAction(input([
    run("BLOCKED",{stage:"PREFLIGHT",blocker:{code:"PRODUCTION_ASSET_MISSING",message:"需要补全资产",retryable:true}})
  ]));
  assert.equal(next.status,"BLOCKED");
  assert.equal(next.action.kind,"OPEN");
  assert.equal(next.action.requiresExplicitConsent,false);
  assert.equal(next.action.href,"/projects/project-workflow-a/smart#smart-run-run-123456");
});

test("GET workflow endpoint reads saved state; POST is forbidden and no paid operation is called", async () => {
  const calls={workspace:0,models:0,list:0,writes:0};
  const deps = {
    smartGeneration: { list: async () => {calls.list++;return [run("WAITING_FOR_CLIP_REVIEW")];} },
    productFlow: { getWorkspace: async (id:string) => {calls.workspace++;return id===PROJECT_ID?
      {project:project("GENERATION_REVIEW"),productTruth:{status:"CONFIRMED"}}:null;} },
    productInput: { latest: async () => {calls.models++;return {assets:[{type:"image"}]};} },
    batchGeneration:{submit:async()=>{calls.writes++;throw Error("should not submit")}}
  } as unknown as Parameters<typeof handleSmartGenerationHttp>[3];
  const server=http.createServer((req,res)=>{
    void (async()=>{
      const matched = await handleSmartGenerationHttp(req,res,new URL(req.url??"/","http://127.0.0.1"),deps);
      if(!matched){res.writeHead(404);res.end();}
    })().catch(error=>{res.writeHead(500);res.end(String(error));});
  });
  await new Promise<void>(ok=>server.listen(0,"127.0.0.1",ok));
  try{
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res=await fetch(base+`/api/projects/${PROJECT_ID}/workflow`);
    assert.equal(res.status,200);
    const data=await res.json() as {workflow:ReturnType<typeof resolveProductionNextAction>};
    assert.equal(data.workflow.action.href,`/projects/${PROJECT_ID}/generate?fromSmartRun=run-123456`);
    const blocked=await fetch(base+`/api/projects/${PROJECT_ID}/workflow`,{method:"POST"});
    assert.equal(blocked.status,405);
    const missing=await fetch(base+"/api/projects/not-found/workflow");
    assert.equal(missing.status,404);
    assert.equal(calls.writes,0);
    assert.equal(calls.list,2);
  }finally{
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  }
});

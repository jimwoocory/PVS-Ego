import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {randomUUID} from "node:crypto";
import {savedReviewSyncBrowserScript} from "../src/web/saved-review-sync.js";
import {SmartGenerationService} from "../src/application/services/smart-generation-service.js";
import {MemorySmartRuns,FixtureProduction,smartOptions} from "./smart-test-support.js";

type Followup={id:string;runId:string;mode:string;expectedRevision:number};
type Queue={remember(run:string,mode:string,revision:number):Followup;retry(id:string):Promise<void>;pending():Followup[]};
function factory(){const window={} as {createPvsSavedReviewSync:(deps:unknown)=>Queue};vm.runInNewContext(savedReviewSyncBrowserScript,{window,crypto:{randomUUID}});return window.createPvsSavedReviewSync;}
test("a saved review with a failed sync survives reload and retries only the exact original run",async()=>{
  const values=new Map<string,string>();let failed=true;
  const calls:Array<{url:string;body:unknown}>=[];
  const deps={project:"project-1",storage:{getItem:(key:string)=>values.get(key),setItem:(key:string,value:string)=>values.set(key,value)},onPending:()=>{},
    post:async(url:string,body:unknown)=>{calls.push({url,body});if(failed)throw new Error("lost response");}};
  const create=factory();const first=create(deps);
  const action=first.remember("original/run","resume",7);
  assert.equal(first.remember("original/run","resume",7).id,action.id);
  await assert.rejects(()=>first.retry(action.id),/lost response/);
  assert.equal(first.pending().length,1);
  const reloaded=create(deps);assert.equal(reloaded.pending()[0]?.id,action.id);
  failed=false;await reloaded.retry(action.id);await reloaded.retry(action.id);
  assert.equal(reloaded.pending().length,0);
  assert.equal(calls.length,2);
  for(const call of calls){assert.equal(call.url,"/api/projects/project-1/smart-runs/original%2Frun/resume");assert.deepEqual(JSON.parse(JSON.stringify(call.body)),{expectedRevision:7});}
  assert.ok(!calls.some(c=>/generate|review|confirm-paid/.test(c.url)));
});
test("other projects cannot consume the queue and storage failure remains visibly pending",async()=>{
  const records=new Map<string,string>();const notices:Array<{count:number;durable:boolean}>=[];
  const create=factory();const storage={getItem:(k:string)=>records.get(k),setItem:(k:string,v:string)=>records.set(k,v)};
  const queue=create({project:"one",storage,post:async()=>{},onPending:()=>{}});
  queue.remember("run","final-confirmed",9);
  assert.equal(create({project:"two",storage,post:async()=>{},onPending:()=>{}}).pending().length,0);
  const broken=create({project:"one",storage:{getItem:()=>null,setItem:()=>{throw new Error("quota");}},post:async()=>{throw new Error("offline");},onPending:(rows:unknown[],durable:boolean)=>notices.push({count:rows.length,durable})});
  const action=broken.remember("run","resume",2);
  await assert.rejects(()=>broken.retry(action.id),/offline/);
  assert.deepEqual(notices.at(-1),{count:1,durable:false});
  assert.throws(()=>broken.remember("run","generate",2),/原任务版本/);
});

test("lost resume response can retry its saved revision without modifying a newer checkpoint or generating",async()=>{
  const repo=new MemorySmartRuns(),production=new FixtureProduction(),service=new SmartGenerationService(repo,production);
  const run=await service.create("project-1","saved-review",smartOptions);
  const first=await service.resume(run.projectId,run.id,run.revision);
  assert.ok(first.revision>run.revision);
  const replay=await service.resume(run.projectId,run.id,run.revision);
  assert.equal(replay.revision,first.revision);
  assert.equal(production.counts.generate,0);assert.equal(production.counts.approvals,0);
  await assert.rejects(()=>service.resume("other-project",run.id,run.revision));
});

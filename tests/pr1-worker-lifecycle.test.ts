// Deterministic timer/service fixtures under the unchanged isolation guard.
import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { startSmartGenerationWorker } from "../src/application/services/smart-generation-worker.js";
import type { SmartGenerationService } from "../src/application/services/smart-generation-service.js";

const flush = async () => { for (let i=0;i<12;i++) await immediate(); };
function deferred() { let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r;}); return {promise,resolve}; }
const run={id:"run",projectId:"project",status:"GENERATING",autoAdvanceGrant:{projectId:"project",runId:"run"}};
function service(overrides: Record<string,unknown>={}) {
  const calls:string[]=[];
  const exact=(p:string,id:string)=>{assert.equal(p,run.projectId);assert.equal(id,run.id);};
  const api={
    async get(p:string,id:string){exact(p,id);calls.push("get");return structuredClone(run);},
    async list(){calls.push("list");return [structuredClone(run)];},
    async recoverAbandoned(){calls.push("global-recover");},
    async recoverAbandonedScoped(p:string,id:string){exact(p,id);calls.push("recover");return false;},
    async advance(p:string,id:string){exact(p,id);calls.push("advance");return structuredClone(run);},
    ...overrides
  } as unknown as SmartGenerationService;
  return {api,calls};
}

test("scoped startup recovery blocks timer advancement and never overlaps",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});const gate=deferred();let recoveries=0;
  const {api,calls}=service({async recoverAbandonedScoped(p:string,id:string){assert.equal(p,"project");assert.equal(id,"run");recoveries++;await gate.promise;return false;}});
  const stop=startSmartGenerationWorker(api,{scope:{projectId:"project",runId:"run"},intervalMs:1000});t.after(stop);
  t.mock.timers.tick(3000);await flush();assert.equal(recoveries,1);assert.deepEqual(calls,[]);
  gate.resolve();await flush();assert.deepEqual(calls,["get","advance"]);
});
test("failed scoped recovery retries before any later advancement",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});let recoveries=0;const errors:unknown[]=[];
  const {api,calls}=service({async recoverAbandonedScoped(){if(++recoveries===1)throw Error("fixture-recovery-fault");return true;}});
  const stop=startSmartGenerationWorker(api,{scope:{projectId:"project",runId:"run"},intervalMs:1000,onError:e=>errors.push(e)});t.after(stop);
  await flush();assert.equal(errors.length,1);assert.deepEqual(calls,[]);
  t.mock.timers.tick(1000);await flush();assert.equal(recoveries,2);assert.deepEqual(calls,["get","advance"]);
});
test("a lease abandoned after startup is recovered only for the exact scoped run",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});const {api,calls}=service();
  const stop=startSmartGenerationWorker(api,{scope:{projectId:"project",runId:"run"},intervalMs:1000});t.after(stop);
  await flush();t.mock.timers.tick(1000);await flush();t.mock.timers.tick(1000);await flush();
  assert.deepEqual(calls,["recover","get","advance","recover","get","advance","recover","get","advance"]);
});
test("global startup recovery blocks intervals, retries failure and runs once after success",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});const gate=deferred();let recoveries=0;const errors:unknown[]=[];
  const {api,calls}=service({async recoverAbandoned(){if(++recoveries===1){await gate.promise;throw Error("fixture-startup-fault");}}});
  const stop=startSmartGenerationWorker(api,{policy:{mode:"ALL"},intervalMs:1000,onError:e=>errors.push(e)});t.after(stop);
  t.mock.timers.tick(2000);await flush();assert.equal(recoveries,1);assert.deepEqual(calls,[]);
  gate.resolve();await flush();assert.equal(errors.length,1);assert.deepEqual(calls,[]);
  t.mock.timers.tick(1000);await flush();t.mock.timers.tick(1000);await flush();
  assert.equal(recoveries,2);assert.deepEqual(calls,["list","recover","advance","list","recover","advance"]);
});
test("stop during scoped recovery prevents task reads and advancement",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});const gate=deferred();const {api,calls}=service({async recoverAbandonedScoped(){await gate.promise;return true;}});
  const stop=startSmartGenerationWorker(api,{scope:{projectId:"project",runId:"run"},intervalMs:1000});stop();gate.resolve();await flush();
  t.mock.timers.tick(5000);await flush();assert.deepEqual(calls,[]);
});
test("stop during managed listing prevents lease recovery and advancement",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});const gate=deferred();const {api,calls}=service({async list(){await gate.promise;return [structuredClone(run)];}});
  const stop=startSmartGenerationWorker(api,{policy:{mode:"MANAGED"},intervalMs:1000});stop();gate.resolve();await flush();assert.deepEqual(calls,[]);
});
test("disabled worker never reads, recovers or advances even after many ticks",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});const {api,calls}=service();const stop=startSmartGenerationWorker(api,{policy:{mode:"DISABLED"},intervalMs:1000});t.after(stop);
  await flush();t.mock.timers.tick(60000);await flush();assert.deepEqual(calls,[]);
});
test("in-flight advancement stays single-flight and stop prevents subsequent stages",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});const gate=deferred();let advances=0;
  const {api,calls}=service({async advance(){advances++;await gate.promise;return {...run,status:"PLANNING"};}});
  const stop=startSmartGenerationWorker(api,{scope:{projectId:"project",runId:"run"},intervalMs:1000});await flush();t.mock.timers.tick(10000);await flush();
  assert.equal(advances,1);assert.deepEqual(calls,["recover","get"]);stop();gate.resolve();await flush();assert.equal(advances,1);
});
test("managed worker skips historical ungranted tasks and preserves scoped recovery",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});const {api,calls}=service({async list(){return [{id:"old",projectId:"foreign",status:"GENERATING"},structuredClone(run)];}});
  const stop=startSmartGenerationWorker(api,{policy:{mode:"MANAGED"},intervalMs:1000});t.after(stop);await flush();assert.deepEqual(calls,["recover","advance"]);
});

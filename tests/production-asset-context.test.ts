import test from "node:test";
import assert from "node:assert/strict";
import type { ProductionAssetSet } from "../src/domain/production-strategy.js";
import type { SmartGenerationRun } from "../src/domain/smart-generation.js";
import { assertProductionAssetBinding, findProductionRunForPlan, findProductionSetForRequest } from "../src/application/services/production-asset-context.js";
import { H, ISO } from "./fixtures.js";

const projectId="asset-bind-project";
const setId="asset-set-123";
const referenceId=`production-asset:${setId}:CHARACTER_A`;
const set={
 id:setId,projectId,status:"READY",contentHash:H.b,entries:[
  {key:"CHARACTER_A",kind:"CHARACTER",referenceAssetId:referenceId,source:"DREAMINA_GENERATED",
   status:"READY",artifactIds:["art-ready-a"],humanConfirmedAt:ISO}
 ]
} as unknown as ProductionAssetSet;
const run=(overrides:Partial<SmartGenerationRun>={}):SmartGenerationRun=>({
 id:"smart-run-ok",projectId,updatedAt:ISO,
 productionPlan:{id:"plan-current",contentHash:H.a},
 productionAssetSet:set,...overrides
} as SmartGenerationRun);

test("preflight picks exact plan/run and rejects foreign, stale or unconfirmed asset bindings",()=>{
 const other=run({id:"other-run",projectId:"another-project",updatedAt:"2026-10-09T00:00:00.000Z"});
 const older=run({id:"older-run",productionPlan:{id:"plan-old",contentHash:H.c} as SmartGenerationRun["productionPlan"]});
 const found=findProductionRunForPlan(projectId,{id:"plan-current",contentHash:H.a},[other,older,run()]);
 assert.equal(found?.id,"smart-run-ok");
 assert.equal(findProductionRunForPlan(projectId,{id:"plan-old",contentHash:H.a},[run()]),null);
 assert.equal(findProductionRunForPlan("another-project",{id:"plan-current",contentHash:H.a},[run()]),null);
 assert.doesNotThrow(()=>assertProductionAssetBinding(projectId,set,[referenceId]));
 assert.throws(()=>assertProductionAssetBinding(projectId,undefined,[referenceId]),/资产未准备好/);
 assert.throws(()=>assertProductionAssetBinding(projectId,{...set,projectId:"other"} as ProductionAssetSet,[referenceId]),/资产未准备好/);
 assert.throws(()=>assertProductionAssetBinding(projectId,{...set,status:"NEEDS_REVIEW"} as ProductionAssetSet,[referenceId]),/资产未准备好/);
 assert.throws(()=>assertProductionAssetBinding(projectId,{
  ...set,entries:[{...set.entries[0],humanConfirmedAt:undefined}]
 } as ProductionAssetSet,[referenceId]),/尚未得到人工确认/);
 assert.throws(()=>assertProductionAssetBinding(projectId,set,[referenceId+"-wrong"]),/缺少已准备好的/);
 assert.doesNotThrow(()=>assertProductionAssetBinding(projectId,undefined,["ordinary-user-asset"]));
});

test("video submission resolves generated media only from the exact immutable asset set version",()=>{
 assert.equal(findProductionSetForRequest(projectId,{entityId:setId,hash:H.b},[run()])?.id,setId);
 assert.equal(findProductionSetForRequest(projectId,{entityId:setId,hash:H.c},[run()]),null);
 assert.equal(findProductionSetForRequest(projectId,{entityId:"wrong-set",hash:H.b},[run()]),null);
 assert.equal(findProductionSetForRequest(projectId,undefined,[run()]),null);
 assert.equal(findProductionSetForRequest(projectId,{entityId:setId,hash:H.b},[run({projectId:"other"})]),null);
});

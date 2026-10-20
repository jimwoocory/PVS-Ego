import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectWorkspace } from "../src/application/services/product-flow.js";
import type { SmartGenerationRun } from "../src/domain/smart-generation.js";
import {renderNativeReview,renderNativeTools} from "../src/web/workflow-inline-panels.js";

const project={id:"ux-r4-project",name:"审核安全项目",status:"GENERATION_REVIEW"} as ProjectWorkspace["project"];
const input=(status:SmartGenerationRun["status"],workspace:Partial<ProjectWorkspace>={})=>({
  workspace:{project,...workspace} as ProjectWorkspace,
  run:{id:"ux-r4-run",projectId:project.id,status,stage:"CLIP_REVIEW"} as SmartGenerationRun
});

test("R4 empty Product Truth is a safe review blocker, not implicit approval",()=>{
  const html=renderNativeReview(input("WAITING_FOR_TRUTH_REVIEW"));
  assert.match(html,/id="ux-truth-review"/);
  assert.match(html,/尚无产品事实草稿/);
  assert.match(html,/高级：打开完整事实审核页/);
  assert.doesNotMatch(html,/data-inline-action="truth-confirm"/);
  assert.doesNotMatch(html,/<iframe/);
});

test("R4 one clip candidate is isolated, explicit and never auto-accepted or paid",()=>{
  const workspace={productionPlan:{scenes:[{clips:[{id:"clip-A",purpose:"<不可信脚本>",durationMs:10000}]}]}} as unknown as Partial<ProjectWorkspace>;
  const html=renderNativeReview({
    ...input("WAITING_FOR_CLIP_REVIEW",workspace),
    attempts:[
      {id:"attempt-A",clipId:"clip-A",status:"SUCCEEDED",attemptNumber:1,outputArtifactId:"artifact-A"},
      {id:"attempt-B",clipId:"clip-B",status:"SUCCEEDED",attemptNumber:2,outputArtifactId:"artifact-B"}
    ] as never, artifacts:[{id:"artifact-A",projectId:project.id,integrityStatus:"READY",mimeType:"video/mp4"}] as never, decisions:[]
  });
  assert.match(html,/id="ux-clips-review"/);
  assert.match(html,/data-attempt="attempt-A"/);
  assert.doesNotMatch(html,/attempt-B/);
  assert.match(html,/data-decision="ACCEPT"/);
  assert.match(html,/data-decision="REDO"/);
  assert.match(html,/data-decision="SKIP"/);
  assert.doesNotMatch(html,/<不可信脚本>/);
  assert.doesNotMatch(html,/<iframe/);
  assert.doesNotMatch(html,/付费生成已自动授权|data-action="paid"/);
});

test("R4 missing or corrupt MP4 is not offered for approval",()=>{
  const workspace={productionPlan:{scenes:[{clips:[{id:"clip-A",purpose:"检查素材",durationMs:10000}]}]}} as unknown as Partial<ProjectWorkspace>;
  const html=renderNativeReview({...input("WAITING_FOR_CLIP_REVIEW",workspace),
    attempts:[{id:"attempt-A",clipId:"clip-A",status:"SUCCEEDED",attemptNumber:1,outputArtifactId:"artifact-A"}] as never,
    artifacts:[{id:"artifact-A",projectId:project.id,integrityStatus:"MISSING",mimeType:"video/mp4"}] as never,
    decisions:[]});
  assert.match(html,/候选文件尚不可用/);
  assert.doesNotMatch(html,/data-decision="ACCEPT"/);
  assert.doesNotMatch(html,/<video/);
});

test("R4 SmartRun uses its own director plan rather than the stale legacy workspace plan",()=>{
  const oldPlan={scenes:[{clips:[{id:"legacy-clip",purpose:"过期镜头",durationMs:6000,contentHash:"old-hash"}]}]};
  const currentPlan={scenes:[{clips:[{id:"run-current-clip",purpose:"当前镜头",durationMs:10000,contentHash:"new-hash"}]}],contentHash:"current-plan-hash"};
  const context=input("WAITING_FOR_CLIP_REVIEW",{productionPlan:oldPlan} as never);
  const html=renderNativeReview({
    ...context,run:{...context.run,productionPlan:currentPlan} as never,
    attempts:[{id:"attempt-current",clipId:"run-current-clip",status:"SUCCEEDED",attemptNumber:1,outputArtifactId:"ready-mp4"}] as never,
    artifacts:[{id:"ready-mp4",projectId:project.id,integrityStatus:"READY",mimeType:"video/mp4"}] as never,
    decisions:[]
  });
  assert.match(html,/run-current-clip/);
  assert.match(html,/data-attempt="attempt-current"/);
  assert.doesNotMatch(html,/legacy-clip|过期镜头/);
});

test("R4 an old final assembly is not offered for acceptance under a newer production plan",()=>{
  const context=input("REVIEW_READY");
  const html=renderNativeReview({
    ...context,
    run:{...context.run,productionPlan:{contentHash:"new-plan"}} as never,
    finalAssembly:{id:"old-assembly",status:"READY",productionPlanHash:"old-plan",outputArtifactId:"old-artifact"} as never,
    artifacts:[{id:"old-artifact",projectId:project.id,integrityStatus:"READY",mimeType:"video/mp4"}] as never
  });
  assert.match(html,/尚无当前版本/);
  assert.doesNotMatch(html,/data-inline-action="final-accept"/);
});

test("R4 inline reference video uses the H264 preview when one is available",()=>{
  const html=renderNativeTools({
    ...input("WAITING_FOR_REFERENCE_REVIEW"),
    referenceVideo:{status:"ACTIVE",version:2,videoArtifactId:"original-hevc",hook:{firstThreeSecondsPattern:"示例"},pacing:{overall:"均匀"}} as never,
    referenceVideoPreviewArtifactId:"browser-compatible-h264"
  });
  assert.match(html,/artifacts\/browser-compatible-h264\/content/);
  assert.doesNotMatch(html,/artifacts\/original-hevc\/content/);
});

test("R4 previewing research is read only and does not silently promote product facts",()=>{
  const html=renderNativeTools({
    ...input("WAITING_FOR_REFERENCE_REVIEW"),
    research:{runs:[],evidence:[],brief:{
      summary:"竞争品牌说<超越保证>",
      contentOpportunities:["冲突型开头"],
      uncertainties:["佩戴效果缺证据"]
    }} as never
  });
  assert.match(html,/联网研究/);
  assert.match(html,/创作参考素材/);
  assert.doesNotMatch(html,/<超越保证>/);
  assert.doesNotMatch(html,/<iframe/);
  assert.doesNotMatch(html,/data-inline-action="truth-confirm"/);
});

import test from "node:test";
import assert from "node:assert/strict";
import type {WorkflowInlineData} from "../src/web/workflow-inline-panels.js";
import {renderNativeReview,renderNativeTools} from "../src/web/workflow-inline-panels.js";
const pid="ux-r3-project";
const workspace={project:{id:pid,name:"PVS",status:"PRODUCT_TRUTH_REVIEW"}} as WorkflowInlineData["workspace"];
const run=(status:string,id="ux-run")=>({id,projectId:pid,status,stage:"SOURCES"}) as WorkflowInlineData["run"];

test("R3 native fact panel handles missing draft safely without duplicating the page",()=>{
 const html=renderNativeReview({workspace,run:run("WAITING_FOR_TRUTH_REVIEW")});
 assert.match(html,/id="ux-truth-review"/);
 assert.match(html,/尚无产品事实草稿/);
 assert.match(html,/高级：打开完整事实审核页/);
 assert.doesNotMatch(html,/<iframe|<script/i);
});

test("R3 fact dispositions are escaped and only explicit confirmation is actionable",()=>{
 const facts={
   status:"DRAFT",version:1,productName:'<script>alert(1)</script>',
   confirmedFeatures:[{id:"one",statement:"正常蓝牙连接"}],sellingPoints:[],
   uncertainClaims:[{id:"claim-one",statement:"<img src=x onerror=alert(1)>",reason:"来源待核对",dispositionConfirmedByUser:false}],
   usageRules:[{id:"rule-one",statement:"佩戴位置",dispositionConfirmedByUser:false}]
 };
 const html=renderNativeReview({workspace:{...workspace,productTruth:facts} as unknown as WorkflowInlineData["workspace"],run:run("WAITING_FOR_TRUTH_REVIEW")});
 assert.match(html,/data-inline-claim="claim-one"/);
 assert.match(html,/data-inline-usage="rule-one"/);
 assert.match(html,/data-inline-action="truth-confirm"/);
 assert.match(html,/&lt;script&gt;/);
 assert.doesNotMatch(html,/<script>|<iframe|<img src=x/i);
});

test("R3 clip review keeps per-clip attempt identity and never contains a pay-submit control",()=>{
 const plan={scenes:[{clips:[{id:"clip-1",durationMs:10000,purpose:"产品佩戴特写"}]}]};
 const attempt={id:"attempt-1",clipId:"clip-1",projectId:pid,status:"SUCCEEDED",attemptNumber:2,outputArtifactId:"video-1"};
 const html=renderNativeReview({
   workspace:{...workspace,productionPlan:plan} as WorkflowInlineData["workspace"],
   run:run("WAITING_FOR_CLIP_REVIEW"),
   attempts:[attempt] as WorkflowInlineData["attempts"],
   artifacts:[{id:"video-1",projectId:pid,integrityStatus:"READY",mimeType:"video/mp4"}] as WorkflowInlineData["artifacts"],
   decisions:[]
 });
 assert.match(html,/video-1\/content/);
 assert.match(html,/data-decision="ACCEPT"/);
 assert.match(html,/data-decision="REDO"/);
 assert.match(html,/data-attempt="attempt-1"/);
 assert.match(html,/data-decision="SKIP"/);
 assert.doesNotMatch(html,/data-action="paid"|data-action="batch-submit"|<iframe/);
});

test("R3 stale continuity result is visible and cannot appear adopted",()=>{
 const plan={scenes:[{clips:[{id:"clip-stale",durationMs:8000,purpose:"连续镜头"}]}]};
 const html=renderNativeReview({
   workspace:{...workspace,productionPlan:plan} as WorkflowInlineData["workspace"],
   run:run("WAITING_FOR_CLIP_REVIEW"),
   attempts:[{id:"attempt-stale",clipId:"clip-stale",projectId:pid,status:"SUCCEEDED",attemptNumber:1,outputArtifactId:"video-stale"}] as WorkflowInlineData["attempts"],
   artifacts:[{id:"video-stale",projectId:pid,integrityStatus:"READY",mimeType:"video/mp4"}] as WorkflowInlineData["artifacts"],
   decisions:[{id:"decision-stale",clipId:"clip-stale",clipHash:"x",decision:"STALE",decidedAt:"2026-10-12T00:00:00.000Z"}] as WorkflowInlineData["decisions"]
 });
 assert.match(html,/上游镜头已变化，需要重新审核并处理/);
 assert.doesNotMatch(html,/data-decision="ACCEPT"|data-decision="REDO"/);
});

test("R3 final panel never presents a publish button from merely saved assembly",()=>{
 const html=renderNativeReview({
   workspace,run:run("REVIEW_READY"),
   finalAssembly:{id:"assembly-1",outputArtifactId:"final-video",status:"READY"} as WorkflowInlineData["finalAssembly"],
   finalQc:null,
   artifacts:[{id:"final-video",projectId:pid,integrityStatus:"READY",mimeType:"video/mp4"}] as WorkflowInlineData["artifacts"]
 });
 assert.match(html,/data-inline-action="final-qc"/);
 assert.match(html,/data-inline-action="final-accept"/);
 assert.doesNotMatch(html,/data-inline-action="publish"/);
 assert.doesNotMatch(html,/<iframe/);
});

test("R3 research/ref panels stay native and upload requires explicit action",()=>{
 const html=renderNativeTools({workspace,run:run("PLANNING"),research:{runs:[],evidence:[]}});
 assert.match(html,/data-ux-tool-view="research"/);
 assert.match(html,/data-ux-tool-view="reference-video"/);
 assert.match(html,/data-ux-tool-view="creative-references"/);
 assert.match(html,/id="ux-reference-upload"/);
 assert.doesNotMatch(html,/<iframe/);
});

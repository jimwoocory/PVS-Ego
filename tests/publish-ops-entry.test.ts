import test from "node:test";
import assert from "node:assert/strict";
import { hasTrustedDouyinPublication } from "../src/application/services/published-ops-entry.js";
import { renderProjectPage } from "../src/web/workbench-ui.js";
import { H, ISO } from "./fixtures.js";
import type { PublishPackage, PublishReceipt } from "../src/domain/publish.js";

const PROJECT_ID="project-ops-entry";
const assemblyId="final-assembly-1";
const artifactId="final-video-1";

function pkg(override: Partial<PublishPackage>={}): PublishPackage {
 return {id:"pkg-ops-1",projectId:PROJECT_ID,finalAssemblyId:assemblyId,finalArtifactId:artifactId,
 finalArtifactHash:H.a,providerType:"DOUYIN_BROWSER_AUTOMATION",status:"PUBLISHED_CONFIRMED",
 publishedConfirmedAt:ISO,titleDraft:"示例作品",expiresAt:ISO,singleUseTokenHash:H.c,createdAt:ISO,...override};
}
function receipt(override:Partial<PublishReceipt>={}):PublishReceipt {
 return {id:"receipt-ops-1",projectId:PROJECT_ID,packageId:"pkg-ops-1",
 providerType:"DOUYIN_BROWSER_AUTOMATION",kind:"PUBLISHED_CONFIRMED",
 trusted:true,createdAt:ISO,...override};
}
function facts(packageOverride: Partial<PublishPackage>={},receiptOverride:Partial<PublishReceipt>={}){
 return {projectId:PROJECT_ID,finalAssemblyId:assemblyId,finalArtifactId:artifactId,
 finalArtifactHash:H.a,finalArtifactReady:true,packages:[pkg(packageOverride)],receipts:[receipt(receiptOverride)]};
}

test("only an exact current-artifact trusted Douyin publication qualifies for post-publish operations",()=>{
 assert.equal(hasTrustedDouyinPublication(facts()),true);
 assert.equal(hasTrustedDouyinPublication(facts({status:"HANDOFF_COMPLETED",publishedConfirmedAt:undefined})),false);
 assert.equal(hasTrustedDouyinPublication(facts({status:"SUBMISSION_UNKNOWN",publishedConfirmedAt:undefined})),false);
 assert.equal(hasTrustedDouyinPublication(facts({status:"AWAITING_USER_ACTION",publishedConfirmedAt:undefined})),false);
 assert.equal(hasTrustedDouyinPublication(facts({providerType:"MANUAL_EXPORT"}, {providerType:"MANUAL_EXPORT"})),false);
 assert.equal(hasTrustedDouyinPublication(facts({projectId:"other-project"})),false);
 assert.equal(hasTrustedDouyinPublication(facts({finalArtifactId:"old-output"})),false);
 assert.equal(hasTrustedDouyinPublication(facts({finalArtifactHash:H.b})),false);
 assert.equal(hasTrustedDouyinPublication(facts({finalAssemblyId:"old-assembly"})),false);
 assert.equal(hasTrustedDouyinPublication(facts({}, {projectId:"other-project"})),false);
 assert.equal(hasTrustedDouyinPublication(facts({}, {packageId:"another-package"})),false);
 assert.equal(hasTrustedDouyinPublication(facts({}, {trusted:false})),false);
 assert.equal(hasTrustedDouyinPublication({...facts(),finalArtifactReady:false}),false);
 assert.equal(hasTrustedDouyinPublication({...facts(),packages:[],receipts:[receipt()]}),false);
});

test("final page only renders the single operations button at the very bottom for current trusted publication",()=>{
 const base={
   kind:"final" as const,
   workspace:{project:{id:PROJECT_ID,name:"发布后运营测试",status:"READY_TO_PUBLISH",
     targetDurationMs:10000,aspectRatio:"9:16",targetPlatform:"douyin",
     createdAt:ISO,updatedAt:ISO}},
   blockers:[],attempts:[],generationRequests:[],preflights:[],approvals:[],compiledPrompts:[],
   reviewDecisions:[],commandAttempts:[],
   artifacts:[{id:artifactId,projectId:PROJECT_ID,integrityStatus:"READY",sha256:H.a}],
   finalAssembly:{id:assemblyId,projectId:PROJECT_ID,status:"ACCEPTED",
    outputArtifactId:artifactId,outputArtifactHash:H.a,selectedClipIds:[]},
   finalQc:{overall:"PASS",checks:[],artifactId,artifactHash:H.a},
   publishBridge:{preference:{projectId:PROJECT_ID,providerType:"DOUYIN_BROWSER_AUTOMATION",updatedAt:ISO},
    probes:[],packages:[pkg()],receipts:[receipt()]}
 } as unknown as Parameters<typeof renderProjectPage>[0];
 const html=renderProjectPage(base);
 assert.equal((html.match(/>进入抖音运营<\/a>/g)??[]).length,1);
 assert.match(html,/id="post-publish-ops-entry"/);
 assert.match(html,new RegExp('/projects/'+PROJECT_ID+'/douyin'));
 assert.ok(html.lastIndexOf('id="post-publish-ops-entry"')>html.lastIndexOf('id="publish-center"') || !html.includes('id="publish-center"'));
 assert.ok(html.indexOf('id="post-publish-ops-entry"')>html.indexOf('最终交付状态'));

 for(const variant of [
  {publishBridge:{...base.publishBridge!,packages:[pkg({status:"HANDOFF_COMPLETED",publishedConfirmedAt:undefined})]}},
  {publishBridge:{...base.publishBridge!,receipts:[receipt({trusted:false})]}},
  {publishBridge:{...base.publishBridge!,packages:[pkg({finalArtifactHash:H.b})]}},
  {finalAssembly:{...base.finalAssembly!,status:"READY"}},
  {publishBridge:undefined}
 ]) {
  const updated={...base,...variant} as Parameters<typeof renderProjectPage>[0];
  assert.doesNotMatch(renderProjectPage(updated),/id="post-publish-ops-entry"/);
 }
});

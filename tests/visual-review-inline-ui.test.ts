import test from "node:test";
import assert from "node:assert/strict";
import { renderNativeReview } from "../src/web/workflow-inline-panels.js";
import type { WorkflowInlineData } from "../src/web/workflow-inline-panels.js";
import { makeValidClip, H } from "./fixtures.js";

function page(input: { withEvidence: boolean }) {
  const story = {...makeValidClip(),id:"clip-story",productVisibility:"NONE" as const,order:1};
  const product = {...makeValidClip(),id:"clip-product",productVisibility:"CLEAR" as const,order:2,contentHash:H.a};
  const html=renderNativeReview({
    workspace:{project:{id:"project-visual-ui"}},
    run:{
      id:"run-current",projectId:"project-visual-ui",status:"WAITING_FOR_CLIP_REVIEW",
      blocker:{code:"VISUAL_REVIEW_REQUIRED",message:"视频 1：旧版视觉结论错误"},
      productionPlan:{scenes:[{clips:[story,product]}]}
    },
    attempts:[
      {id:"attempt-story",clipId:story.id,attemptNumber:1,status:"SUCCEEDED",outputArtifactId:"video-story"},
      {id:"attempt-product",clipId:product.id,attemptNumber:1,status:"SUCCEEDED",outputArtifactId:"video-product"}
    ],
    artifacts:[
      {id:"video-story",projectId:"project-visual-ui",integrityStatus:"READY",mimeType:"video/mp4"},
      {id:"video-product",projectId:"project-visual-ui",integrityStatus:"READY",mimeType:"video/mp4"}
    ],
    visualSummaries:input.withEvidence?[
      {clipId:story.id,attemptId:"attempt-story",status:"OUTDATED",autoAcceptEligible:false},
      {clipId:product.id,attemptId:"attempt-product",status:"PASS",
        confidence:"HIGH",autoAcceptEligible:true,productVisibility:"CLEAR",
        productIdentity:"PASS",productStability:"PASS",storyActionAlignment:"PASS",
        audioTrackPresent:true}
    ]:undefined
  } as unknown as WorkflowInlineData);
  return html;
}

test("clip review renders numbered direct links, specific visibility contracts and preserved v1 outdated state",()=>{
  const html=page({withEvidence:true});
  assert.match(html,/id="ux-clip-1"/);
  assert.match(html,/id="ux-clip-2"/);
  assert.match(html,/纯剧情：产品不需要出镜/);
  assert.match(html,/清晰展示产品/);
  assert.match(html,/data-visual-status="OUTDATED"/);
  assert.match(html,/历史质检结果已失效，需要重新检查/);
  assert.match(html,/data-visual-status="PASS"/);
  assert.match(html,/已发现音频轨（未验证台词及音效）/);
  assert.match(html,/可见主要动作初步符合分镜/);
  assert.match(html,/跨镜叙事需要播放后确认|跨镜叙事仍待核对/);
  assert.match(html,/data-inline-action="clip-decision"/);
});
test("a simple GET without current assessment clearly says not run, never fabricated PASS",()=>{
  const html=page({withEvidence:false});
  assert.equal([...html.matchAll(/data-visual-status="NOT_RUN"/g)].length,2);
  assert.match(html,/尚未进行视觉质检/);
  assert.doesNotMatch(html,/data-visual-status="PASS"/);
});

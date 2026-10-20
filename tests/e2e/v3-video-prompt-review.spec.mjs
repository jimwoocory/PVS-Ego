import {test,expect} from "@playwright/test";
import {renderSmartGenerationPage} from "../../dist/src/web/smart-generation-ui.js";
import {makeValidClip} from "../../dist/tests/fixtures.js";

test("V3 generated video stays with its ClipId prompt and the global recheck is immediately above Stop",async({page})=>{
  const pid="project-v3-review-fixture",rid="run-v3-review-fixture";
  const clips=Array.from({length:3},(_,i)=>({
    ...structuredClone(makeValidClip()),
    id:"clip-review-"+(i+1),order:i+1,
    purpose:"第"+(i+1)+"段剧情",productVisibility:i===0?"NONE":"CLEAR",
    contentHash:String(i+1).repeat(64)
  }));
  const prompts=clips.map((clip,i)=>({
    id:"prompt-"+(i+1),clipId:clip.id,promptText:"PROMPT_CONTENT_"+(i+1)
  })).reverse();
  const attempts=clips.map((clip,i)=>({
    id:"attempt-"+(i+1),clipId:clip.id,attemptNumber:1,
    status:"SUCCEEDED",outputArtifactId:"video-artifact-"+(i+1)
  }));
  const artifacts=clips.map((clip,i)=>({
    id:"video-artifact-"+(i+1),projectId:pid,
    integrityStatus:"READY",mimeType:"video/mp4"
  }));
  const now="2026-10-10T04:00:00.000Z";
  const run={
    id:rid,projectId:pid,revision:8,workflowVersion:2,
    status:"WAITING_FOR_CLIP_REVIEW",stage:"CLIP_REVIEW",
    blocker:{code:"VISUAL_REVIEW_REQUIRED",retryable:true,
      message:"视频 1：历史质检结果不足"},
    targetDurationMs:24000,attemptIds:attempts.map(a=>a.id),
    options:{requestText:"完整短剧",directorVersion:3,
      reviewMode:"AUTO",autoSelectLowRiskClips:true,
      generationSettings:{requestedModelVersion:"seedance2.0mini",
        aspectRatio:"9:16",videoResolution:"720p",nativeAudioOutputRequested:true}},
    productionPlan:{scenes:[{clips}]},
    seedancePromptDrafts:prompts,notes:[],createdAt:now,updatedAt:now
  };
  const workspace={project:{id:pid,name:"V3审片同卡布局",
    status:"READY_TO_GENERATE",targetPlatform:"douyin",
    targetDurationMs:24000,aspectRatio:"9:16",createdAt:now,updatedAt:now}};
  const html=renderSmartGenerationPage(workspace,[run],{
    selectedRunId:rid,inline:{attempts,artifacts,decisions:[],visualSummaries:[]}
  });
  await page.goto("/");
  const writes=[];page.on("request",r=>{
    if(!["GET","HEAD"].includes(r.method()))writes.push(r.method()+" "+r.url());
  });
  await page.setContent(html,{waitUntil:"domcontentloaded"});
  await expect(page.locator('a.primary[href="#v3-seedance-workbench-'+rid+'"]')).toHaveCount(1);
  await expect(page.locator(".embedded-review video")).toHaveCount(0);
  await expect(page.locator("#v3-seedance-workbench-"+rid+" video")).toHaveCount(3);
  await expect(page.locator(".v3-prompt-details")).toHaveCount(3);
  for(let i=1;i<=3;i++){
    const card=page.locator("#v3-video-"+i);
    await expect(card.locator("video")).toHaveCount(1);
    await expect(card.locator("video")).toHaveAttribute("src","/api/artifacts/video-artifact-"+i+"/content");
    await expect(card.locator(".ux-clip-card")).toHaveAttribute("data-ux-clip","clip-review-"+i);
    await expect(card.locator('[data-inline-action="clip-decision"][data-decision="ACCEPT"]')).toHaveCount(1);
    await expect(card.locator(".v3-prompt-details")).toHaveJSProperty("open",false);
    await expect(card.locator(".v3-prompt-text")).toHaveValue("PROMPT_CONTENT_"+i);
  }
  await expect(page.locator('[data-inline-action="clip-finalize"]')).toHaveCount(1);
  const footer=page.locator(".ux-visual-qc-footer");
  await expect(footer.locator('[data-visual-recheck="1"]')).toHaveText("重新进行视觉质检");
  await expect(page.locator('.run button[data-action="cancel"]')).toHaveCount(1);
  const position=await page.evaluate(()=>{
    const button=document.querySelector('button[data-visual-recheck="1"]');
    const stop=document.querySelector('.run button[data-action="cancel"]');
    const prompt=document.querySelector('#v3-seedance-workbench-'+"run-v3-review-fixture");
    return {
      footerBeforeStop:stop?.previousElementSibling===button?.closest(".ux-visual-qc-footer"),
      footerAfterPrompts:button?.compareDocumentPosition(prompt)&Node.DOCUMENT_POSITION_PRECEDING?true:false
    };
  });
  expect(position.footerBeforeStop).toBe(true);
  expect(position.footerAfterPrompts).toBe(true);
  await page.evaluate(()=>{window.__v3ConfirmCount=0;window.confirm=()=>{window.__v3ConfirmCount++;return false;}});
  await footer.locator('button[data-visual-recheck="1"]').click();
  expect(await page.evaluate(()=>window.__v3ConfirmCount)).toBe(1);
  expect(writes).toEqual([]);
});

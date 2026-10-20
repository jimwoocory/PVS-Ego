import { test, expect } from "@playwright/test";
import { FormalV8Production, formalV8Options } from "../../dist/tests/v8-production-fixtures.js";
import { MemorySmartRuns } from "../../dist/tests/smart-test-support.js";
import { SmartGenerationService } from "../../dist/src/application/services/smart-generation-service.js";
import { runnableSmartStatuses } from "../../dist/src/domain/smart-generation.js";
import { renderSmartGenerationPage } from "../../dist/src/web/smart-generation-ui.js";

async function browserFixture(page) {
  const production = new FormalV8Production(), repo = new MemorySmartRuns(), service = new SmartGenerationService(repo, production);
  const before = process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
  process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING = "1";
  let run;
  try { run = await service.create("project-1", "e2e-formal-v8", formalV8Options, 2); }
  finally { if(before === undefined) delete process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING; else process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING = before; }
  const drain = async () => { for(let i=0;i<30 && runnableSmartStatuses.includes(run.status);i++)run=await service.advance(run.projectId,run.id); };
  await drain();
  run=await service.review(run.projectId,run.id,{action:"SELECT_CREATIVE",expectedRevision:run.revision,creativeId:"creative-1"});
  await drain();
  const writes=[], errors=[];
  page.on("pageerror", error=>errors.push(error.message));
  await page.route("**/projects/project-1/smart*", async route=>{
    const html=renderSmartGenerationPage({project:{id:"project-1",name:"隔离 V8 正式审核",status:"DRAFT",targetPlatform:"douyin",targetDurationMs:10000,aspectRatio:"16:9",
      createdAt:"2026-10-09T00:00:00.000Z",updatedAt:"2026-10-09T00:00:00.000Z"}},[run]);
    await route.fulfill({status:200,contentType:"text/html; charset=utf-8",body:html});
  });
  await page.route("**/api/projects/project-1/smart-runs**", async route=>{
    const request=route.request();
    if(request.method()==="GET")return route.fulfill({json:request.url().endsWith("smart-runs")?{runs:[run]}:{run}});
    const action=request.url().split("/").at(-1),body=request.postDataJSON();writes.push(action);
    try {
      if(action==="review")run=await service.review(run.projectId,run.id,body);
      else if(action==="director-v8")run=await service.updateDirectorV8(run.projectId,run.id,body);
      else if(action==="plan-v8")run=await service.updatePlanV8(run.projectId,run.id,body);
      else if(action==="prompts-v8")run=await service.compilePromptV8(run.projectId,run.id,body);
      else if(action==="script-v8")run=await service.updateV8Screenplay(run.projectId,run.id,body);
      else throw Error("E2E_FORBIDDEN_ACTION:"+action);
      await drain();await route.fulfill({json:{run}});
    } catch(error) { await route.fulfill({status:400,json:{message:error.message}}); }
  });
  await page.goto("/projects/project-1/smart");
  return {production,writes,errors,current:()=>run};
}

test("formal V8 same-task screenplay → director → real segments → voice prompts requires each human adoption", async ({page})=>{
  const f=await browserFixture(page);
  await expect(page.getByText("完整剧本 · 人工审核",{exact:true})).toBeVisible();
  await page.locator('[data-action="CONFIRM_SCRIPT"]').click();
  await expect(page.locator('.action-error')).toContainText("请先逐场检查");
  await page.locator('.v8-manual-confirm').check();
  await page.locator('[data-action="CONFIRM_SCRIPT"]').click();
  await expect(page.getByText("导演镜头表：2 个视频编号 · 10 秒",{exact:true})).toBeVisible();
  expect(f.production.visualCalls).toBe(0);
  await page.locator('[data-v8-shot]').first().fill("室友左侧，主人公右侧；此时不提前揭晓产品身份");
  await page.locator('[data-action="director-v8"]').click();
  await expect(page.locator('[data-action="CONFIRM_V8_DIRECTOR"]')).toBeVisible();
  await page.locator('.v8-production-confirm').check();
  await page.locator('[data-action="CONFIRM_V8_DIRECTOR"]').click();
  await expect(page.locator('[data-action="CONFIRM_PLAN"]')).toBeVisible();
  await expect(page.locator('[data-v8-segment]').first()).toContainText("人物");
  await page.locator('[data-v8-composition]').first().fill("室友在画面左侧，主人公在右侧；双方视线与动作连续");
  await page.locator('[data-action="plan-v8"]').click();
  await expect(page.locator('[data-action="CONFIRM_PLAN"]')).toBeVisible();
  await page.locator('.v8-production-confirm').check();
  await page.locator('[data-action="CONFIRM_PLAN"]').click();
  await expect(page.locator('[data-action="prompts-v8"]')).toBeVisible();
  expect(f.current().paidScope).toBeUndefined();
  for(const [name,key,voice] of [["室友","CHARACTER_A","清晰青年女声"],["主人公","CHARACTER_B","沉稳青年男声"]]) {
    const row=page.locator('[data-v8-voice="'+name+'"]');await row.locator('select').selectOption(key);await row.locator('input').fill(voice);
  }
  await page.locator('[data-action="prompts-v8"]').click();
  await expect(page.locator('[data-action="CONFIRM_V8_PROMPTS"]')).toBeVisible();
  await expect(page.locator('.v8-production-workbench .v8-prompt-pre').first()).toContainText("室友：“这是什么？”");
  const clipAssetPanel=page.locator('.v8-clip-prompt .v3-asset-bindings').first();
  await expect(clipAssetPanel.locator("summary")).toContainText("查看本段图片引用");
  await clipAssetPanel.locator("summary").click();
  await expect(clipAssetPanel.locator('[data-image-index="1"]')).toContainText("@图片1");
  await expect(page.locator('.v8-production-workbench')).toContainText("后期文案清单：");
  await expect(page.locator('.v8-production-workbench')).toContainText("请按说明使用");
  await page.locator('[data-action="CONFIRM_V8_PROMPTS"]').click();
  await expect(page.locator('.action-error')).toContainText("请先阅读");
  await page.locator('.v8-production-confirm').check();
  await page.locator('[data-action="CONFIRM_V8_PROMPTS"]').click();
  await expect(page.locator('[data-action="paid"]')).toBeVisible();
  expect(f.current().v8Prompts.status).toBe("CONFIRMED");
  expect(f.current().consent).toBeUndefined();
  expect(f.production.counts.generate).toBe(0);
  expect(f.writes.some(x=>/paid|publish|generation/.test(x))).toBe(false);
  expect(f.errors).toEqual([]);
});

test("formal V8 read-only browser workbench does not adopt or spend on page load", async ({page})=>{
  const f=await browserFixture(page);
  const revision=f.current().revision;
  await page.reload();
  await expect(page.locator('[data-action="CONFIRM_SCRIPT"]')).toBeVisible();
  expect(f.current().revision).toBe(revision);
  expect(f.writes).toEqual([]);
  expect(f.production.counts.approvals).toBe(0);
  expect(f.production.counts.generate).toBe(0);
  expect(f.errors).toEqual([]);
});

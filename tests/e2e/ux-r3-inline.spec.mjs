import {test,expect} from "@playwright/test";

test("UX-R3 native review and tools stay within one page; opening panels has no write side effects",async({page})=>{
  const writes=[];
  page.on("pageerror",error=>console.log("R3_PAGE_ERROR",error.message));
  page.on("request",r=>{if(!["GET","HEAD"].includes(r.method()))writes.push(r.url());});
  await page.goto("/projects/e2e-ready/smart");
  await expect(page.locator("main.ux-workbench")).toBeVisible();
  await expect(page.locator("#workflow-next-action")).toContainText("审核产品事实");
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.locator('#workflow-next-action a.primary').click();
  await expect(page.locator("#review-panel-e2e-workflow-truth-run")).toBeVisible();
  await expect(page.locator("#review-panel-e2e-workflow-truth-run")).toContainText("产品事实");
  await page.locator("#workflow-support-materials > summary").click();
  await page.locator('#workflow-support-materials [data-workflow-tool="research"]').click();
  await expect(page.locator('[data-ux-tool-view="research"]')).toBeVisible();
  await page.locator('#workflow-support-materials [data-workflow-tool="reference-video"]').click();
  await expect(page.locator('[data-ux-tool-view="reference-video"]')).toBeVisible();
  await page.locator('#workflow-support-materials [data-workflow-tool="creative-references"]').click();
  await expect(page.locator('[data-ux-tool-view="creative-references"]')).toBeVisible();
  expect(writes).toEqual([]);
});

test("UX-R3 legacy compatibility stays reachable without new paid submission",async({page,request})=>{
  await page.goto("/projects/e2e-ready/smart?ui=legacy");
  await expect(page.locator(".main-nav")).toBeVisible();
  const wf=await request.get("/api/projects/e2e-ready/workflow");
  expect(wf.ok()).toBeTruthy();
  expect((await wf.json()).workflow.action.requiresExplicitConsent).toBe(false);
});

import {test, expect} from "@playwright/test";

function captureErrors(page) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  return errors;
}

test("W2: active project keeps one primary task while other goals remain optional",async({page})=>{
 const writes=[];page.on("request",req=>{if(!["GET","HEAD"].includes(req.method()))writes.push(req.url());});
 await page.goto("/projects/e2e-ready/smart");
 await expect(page.locator("main.ux-workbench")).toBeVisible();
 await expect(page.locator(".ux-stages")).toBeVisible();
 await expect(page.locator("#workflow-next-action")).toBeVisible();
 await expect(page.locator("#run-list .run")).toBeVisible();
 const purposes=page.locator("#workflow-purpose-entry");
 await expect(purposes).toBeHidden();
 await page.locator("#ux-new-goal-options > summary").click();
 await expect(purposes).toBeVisible();
 await expect(purposes.getByRole("link",{name:"进入单片段生成"})).toHaveAttribute("href","/projects/e2e-ready/single-video");
 await purposes.getByRole("button",{name:"在本任务中打开研究"}).click();
 await expect(page.locator("#workflow-support-materials")).toHaveAttribute("open","");
 await expect(page.locator('#workflow-tool-panel [data-ux-tool-view="research"]')).toBeVisible();
 await expect(page.locator("iframe")).toHaveCount(0);
 expect(writes).toEqual([]);
 await page.goto("/projects/e2e-draft/smart");
 await expect(page.locator("#workflow-purpose-entry")).toBeVisible();
 await expect(page.locator("#smart-create")).toBeVisible();
});

test("W2/R3: one originating SmartRun shows a native reviewer instead of a full iframe",async({page,request})=>{
 const errors=captureErrors(page);
 await page.goto("/projects/e2e-ready/smart");
 const workflow=page.locator("#workflow-next-action");
 await expect(workflow).toContainText("等待人工审核");
 const action=workflow.getByRole("link",{name:"审核产品事实与使用规则"});
 await expect(action).toHaveAttribute("href","#review-panel-e2e-workflow-truth-run");
 await action.click();
 const review=page.locator("#review-panel-e2e-workflow-truth-run");
 await expect(review).toHaveAttribute("open","");
 await expect(review.locator("#ux-truth-review")).toBeVisible();
 await expect(review.locator("iframe")).toHaveCount(0);
 await expect(review.getByRole("link",{name:"高级：打开完整事实审核页"})).toHaveAttribute("href","/projects/e2e-ready/truth");
 await expect(review.getByRole("button",{name:"刷新当前任务状态"})).toHaveCount(0);
 const response=await request.get("/api/projects/e2e-ready/smart-runs/e2e-workflow-truth-run");
 expect(response.ok()).toBe(true);
 expect((await response.json()).run.status).toBe("WAITING_FOR_TRUTH_REVIEW");
 expect(errors).toEqual([]);
});

test("W2/R3: native research, reference video and creative-reference panels do not navigate or submit",async({page,request})=>{
 const errors=captureErrors(page);
 const writes=[];page.on("request",req=>{if(!["GET","HEAD"].includes(req.method()))writes.push(req.url());});
 await page.goto("/projects/e2e-ready/smart");
 const root=page.locator("#workflow-support-materials");
 await root.locator("summary").first().click();
 const panel=page.locator("#workflow-tool-panel");
 for(const [name,kind] of [["联网研究","research"],["参考视频","reference-video"],["创作参考素材池","creative-references"]]){
   await root.getByRole("button",{name,exact:true}).click();
   await expect(panel.locator('[data-ux-tool-view="'+kind+'"]')).toBeVisible();
   await expect(page).toHaveURL(/\/projects\/e2e-ready\/smart$/);
 }
 await expect(page.locator("iframe")).toHaveCount(0);
 expect(writes).toEqual([]);
 const run=(await (await request.get("/api/projects/e2e-ready/smart-runs/e2e-workflow-truth-run")).json()).run;
 expect(run.attemptIds).toEqual([]);
 expect(errors).toEqual([]);
});

test("W2: project list resumes a real active SmartRun rather than an unrelated legacy step", async ({page})=>{
  await page.goto("/projects");
  const item = page.locator("article.card").filter({hasText:"E2E Ready Project"});
  await expect(item).toContainText("当前工作流");
  await expect(item).toContainText("审核产品事实与使用规则");
  await expect(item.getByRole("link",{name:"继续项目"})).toHaveAttribute("href",
    "/projects/e2e-ready/smart?activeRun=e2e-workflow-truth-run#smart-run-e2e-workflow-truth-run");
  await item.getByRole("link",{name:"继续项目"}).click();
  await expect(page).toHaveURL(/\/projects\/e2e-ready\/smart\?activeRun=e2e-workflow-truth-run#smart-run-e2e-workflow-truth-run$/);
  await expect(page.locator("#smart-run-e2e-workflow-truth-run")).toBeVisible();
});

test("W3: only a platform-confirmed current Douyin publication exposes operations and never publishes automatically", async ({page,request})=>{
  const errors=captureErrors(page);
  const writes=[];
  page.on("request",req=>{if(req.method()!=="GET" && req.method()!=="HEAD")writes.push(req.url());});
  await page.goto("/projects/e2e-published/final");
  const entry=page.locator("#post-publish-ops-entry");
  await expect(entry).toBeVisible();
  await expect(entry).toContainText("当前成片已有抖音可信发布回执");
  const go=entry.getByRole("link",{name:"进入抖音运营"});
  await expect(go).toHaveAttribute("href","/projects/e2e-published/douyin");
  await expect(page.getByRole("link",{name:"进入抖音运营"})).toHaveCount(1);
  await go.click();
  await expect(page).toHaveURL(/\/projects\/e2e-published\/douyin$/);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await page.goto("/projects/e2e-final/final");
  await expect(page.locator("#post-publish-ops-entry")).toHaveCount(0);
  await expect(page.getByRole("link",{name:"进入抖音运营"})).toHaveCount(0);
  expect((await request.post("/api/projects/e2e-ready/workflow",{data:{}})).status()).toBe(405);
});

test("W4: unknown SmartRun id/foreign reference does not create a misleading return link",async ({page})=>{
  await page.goto("/projects/e2e-ready/product?fromSmartRun=not-real-123");
  await expect(page.locator("#smart-return-card")).toBeHidden();
  await page.goto("/projects/e2e-draft/product?fromSmartRun=e2e-workflow-truth-run");
  await expect(page.locator("#smart-return-card")).toBeHidden();
});

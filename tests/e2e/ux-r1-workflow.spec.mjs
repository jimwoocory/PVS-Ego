import {test, expect} from "@playwright/test";

test("UX-R1 old pages and project list use one task projection without writing on reads", async ({page,request})=>{
  const writes=[];
  page.on("request",req=>{if(!["GET","HEAD"].includes(req.method()))writes.push(req.method()+" "+req.url());});
  const api=await request.get("/api/projects/e2e-ready/workflow");
  expect(api.ok()).toBe(true);
  const {workflow}=await api.json();
  expect(workflow.source).toBe("SMART_RUN");
  expect(workflow.taskSelectionRequired).toBe(false);
  expect(workflow.activeTaskCount).toBe(1);
  expect(workflow.phase).toBeTruthy();

  for(const pageName of ["product","research","reference-video","models"]){
    await page.goto("/projects/e2e-ready/"+pageName);
    const summary=page.locator("#workflow-read-model");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(workflow.stageLabel);
    await expect(summary).toContainText(workflow.action.label);
    await expect(summary.locator("a")).toHaveAttribute("href",workflow.action.href);
    await expect(page.locator(".workflow-nav-head")).toContainText("当前任务下一步：");
  }
  await page.goto("/projects");
  const item=page.locator("article.card").filter({hasText:"E2E Ready Project"});
  await expect(item).toContainText(workflow.action.label);
  await expect(item.getByRole("link",{name:"继续项目"})).toHaveAttribute("href",
    "/projects/e2e-ready/smart?activeRun=e2e-workflow-truth-run#smart-run-e2e-workflow-truth-run");
  expect(writes).toEqual([]);
});

test("UX-R1 user-facing progress, legacy adapter and history semantics remain readable",async({page,request})=>{
  await page.goto("/projects/e2e-ready/smart");
  await expect(page.locator("#workflow-next-action")).toContainText("审核产品事实与使用规则");
  await expect(page.getByLabel("当前工作流进度")).toContainText("产品与事实");
  await expect(page.getByLabel("当前工作流进度")).toContainText("发布与运营");
  const old=await request.get("/api/projects/e2e-draft/workflow");
  expect(old.ok()).toBe(true);
  const {workflow}=await old.json();
  expect(workflow.source).toBe("PROJECT");
  expect(workflow.action.href).toBe("/projects/e2e-draft/product");
  expect(workflow.publication.receiptVerification).toBe("NOT_CHECKED");
  expect((await request.post("/api/projects/e2e-ready/workflow",{data:{}})).status()).toBe(405);
});


test("UX-R1 derives the real final-assembly next action from an isolated saved assembly",async({page,request})=>{
  const response=await request.get("/api/projects/e2e-final/workflow");
  expect(response.ok()).toBe(true);
  const {workflow}=await response.json();
  expect(workflow.source).toBe("PROJECT");
  expect(["ASSEMBLY","PUBLISH"]).toContain(workflow.phase);
  if(workflow.phase==="ASSEMBLY"){
    expect(workflow.stageLabel).toBe("成片待确认");
    expect(workflow.action.label).toBe("检查并确认已渲染成片");
  }else{
    // The earlier final-QC E2E may have already accepted this same fixture.
    // The projection must reflect the persisted assembly, not a stale page label.
    expect(workflow.stageLabel).toBe("成片已确认");
    expect(workflow.action.label).toBe("查看已确认成片与发布状态");
  }
  expect(workflow.action.href).toBe("/projects/e2e-final/final");
  expect(workflow.publication.receiptVerification).toBe("NOT_CHECKED");
  await page.goto("/projects/e2e-final/product");
  await expect(page.locator("#workflow-read-model")).toContainText(workflow.action.label);
  await expect(page.locator(".workflow-nav-head")).toContainText("当前任务下一步：");
});

test("UX-R1 an invalid selected task cannot silently redirect to another run",async({page,request})=>{
  await page.goto("/projects/e2e-ready/smart?activeRun=not-current-run");
  const workflow=page.locator("#workflow-next-action");
  await expect(workflow).toContainText("指定任务不存在或不可继续");
  await expect(workflow.getByRole("link",{name:"选择要继续的任务"})).toHaveAttribute("href",
    "/projects/e2e-ready/smart#choose-task");
  const chooser=page.locator("#choose-task");
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole("link")).toHaveCount(1);
  await chooser.getByRole("link").click();
  await expect(page).toHaveURL(/activeRun=e2e-workflow-truth-run/);
  await expect(page.locator("#workflow-next-action")).toContainText("审核产品事实与使用规则");
  const latest=await request.get("/api/projects/e2e-ready/workflow?activeRun=not-current-run");
  expect(latest.ok()).toBe(true);
  const view=(await latest.json()).workflow;
  expect(view.taskSelectionRequired).toBe(true);
  expect(view.action.requiresExplicitConsent).toBe(false);
});

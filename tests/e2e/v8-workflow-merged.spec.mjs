import { test, expect } from "@playwright/test";

const readyOps = { ready: true, status: "READY", message: "研究连接就绪" };
const blockedOps = { ready: false, status: "SITE_OFFLINE", message: "网页尚未注册" };

test("V8: next-action link is dark blue text with no filled background", async ({ page }) => {
  await page.goto("/projects/e2e-ready/smart");
  const anchor = page.locator("#workflow-next-action a.primary");
  await expect(anchor).toBeVisible();
  const style = await anchor.evaluate(el => {
    const c = getComputedStyle(el);
    return { color: c.color, bg: c.backgroundColor, borderWidth: c.borderTopWidth };
  });
  expect(style.bg).toBe("rgba(0, 0, 0, 0)");
  expect(style.borderWidth).toBe("0px");
  expect(style.color).toMatch(/rgb\(22, 69, 123\)/);
});

test("Deep Douyin research checks readiness first; blocked Bridge prevents research until skip", async ({ page }) => {
  const calls = [];
  await page.route("**/api/douyin/ops/research-readiness", route =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(blockedOps) }));
  await page.route("**/api/projects/e2e-ready/research/run", route => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ run: { status: "COMPLETED" } }) });
  });
  await page.goto("/projects/e2e-ready/smart");
  await page.locator("#workflow-support-materials > summary").click();
  await page.locator('#workflow-support-materials [data-workflow-tool="research"]').click();
  const form = page.locator("#ux-native-research-form");
  await form.locator('input[name="goal"]').fill("研究同类护颈枕创意");
  await form.locator('select[name="mode"]').selectOption("DEEP");
  await form.getByRole("button", { name: /在当前任务中开始研究/ }).click();
  await expect(form.locator("[data-douyin-connection-error]")).toContainText("尚未确认");
  expect(calls).toHaveLength(0);
  await form.locator("[data-douyin-research-skip]").click();
  expect(await form.locator('[name="marketVideoEnabled"]').isChecked()).toBe(false);
  page.on("dialog", dialog => dialog.accept());
  await form.getByRole("button", { name: /在当前任务中开始研究/ }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].marketVideo.enabled).toBe(false);
});

test("Deep Douyin research accepts Bridge only when runtime AND account are ready", async ({ page }) => {
  const calls = [];
  await page.route("**/api/douyin/ops/research-readiness", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ready: false, status: "AUTH_REQUIRED", message: "抖音研究账号需要登录" })
  }));
  await page.route("**/api/projects/e2e-ready/research/run", route => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ run: { status: "COMPLETED" } }) });
  });
  await page.goto("/projects/e2e-ready/smart");
  await page.locator("#workflow-support-materials > summary").click();
  await page.locator('#workflow-support-materials [data-workflow-tool="research"]').click();
  const form = page.locator("#ux-native-research-form");
  await form.locator('input[name="goal"]').fill("研究同类产品");
  await form.locator('select[name="mode"]').selectOption("DEEP");
  await form.getByRole("button", { name: /在当前任务中开始研究/ }).click();
  await expect(form.locator("[data-douyin-connection-error]")).toContainText("尚未确认");
  expect(calls).toHaveLength(0);
  await page.unroute("**/api/douyin/ops/research-readiness");
  await page.route("**/api/douyin/ops/research-readiness", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(readyOps)
  }));
  await form.getByRole("button", { name: "重新检测抖音连接" }).click();
  await expect(form.locator("[data-douyin-connection-status]")).toContainText("均已确认");
  page.on("dialog", dialog => dialog.accept());
  await form.getByRole("button", { name: /在当前任务中开始研究/ }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].marketVideo.enabled).toBe(true);
});

test("slow legacy operations endpoint cannot cause a false research timeout", async ({ page }) => {
  let oldCalls = 0;
  let readinessCalls = 0;
  // The former full dashboard takes >6 seconds when reading the works list.
  // Any request to it indicates the research gate regressed to the slow path.
  await page.route("**/api/douyin/ops/status", route => {
    oldCalls++;
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({runtime:{ready:true,status:"READY"}})});
  });
  await page.route("**/api/douyin/ops/research-readiness", async route => {
    readinessCalls++;
    // Even a slow *lightweight* lookup should no longer be mistaken for a disconnection at 6s.
    await new Promise(resolve => setTimeout(resolve, 6500));
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(readyOps)});
  });
  await page.goto("/projects/e2e-ready/research");
  const form = page.locator("#research-form");
  await form.locator('select[name="mode"]').selectOption("DEEP");
  await expect(form.locator("[data-douyin-connection-status]")).toContainText("均已确认",{timeout:12000});
  await expect(form.locator("[data-douyin-connection-status]")).not.toContainText("超时");
  expect(readinessCalls).toBeGreaterThanOrEqual(1);
  expect(oldCalls).toBe(0);
  await expect(page.locator("[data-douyin-preflight]")).toHaveCount(1);
});

test("New project saves source product first, offers optional research, then must review truth", async ({ page, request }) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0h8AAAAASUVORK5CYII=";
  const created = await request.post("/api/projects",{
    data:{name:"V8 Research Before Truth",targetDurationMs:30000}
  });
  expect(created.status()).toBe(201);
  const projectId=(await created.json()).project.id;
  try {
    const saved=await request.post("/api/projects/"+projectId+"/product-input/generate-truth",{
      data:{
        productName:"V8 Study Pillow",brand:"Fixture Brand",category:"枕头",
        featureDescription:"用户提供的基础产品介绍，仅在隔离测试中保存。",
        images:[{name:"fixture.png",mimeType:"image/png",base64:"data:image/png;base64,"+png}],
        forbiddenChanges:[],deferTruth:true
      }
    });
    expect(saved.status()).toBe(201);
    const result=await saved.json();
    expect(result.pendingTruth).toBe(true);
    expect(result.productTruth).toBeUndefined();
    const next=await request.get("/api/projects/"+projectId+"/workflow");
    expect(next.status()).toBe(200);
    const nextStep=(await next.json()).workflow;
    expect(nextStep.action.href).toContain("/research");
    expect(nextStep.action.label).toContain("可跳过");
    await page.goto("/projects/"+projectId+"/research?fromProduct=1");
    await expect(page.locator("#research-then-truth")).toBeVisible();
    await expect(page.locator("#research-finish-truth")).toHaveText(/生成待确认产品事实/);
    // Only the optional research page can initiate a new truth draft. This
    // hook deliberately avoids calling the external text-model provider.
    let actualGenerate=0;
    await page.route("**/api/projects/"+projectId+"/truth/generate-from-input",async route=>{
      actualGenerate++;
      await route.fulfill({status:201,contentType:"application/json",body:'{"productTruth":{"status":"DRAFT"}}'});
    });
    page.on("dialog",dialog=>dialog.accept());
    await page.locator("#research-finish-truth").click();
    await expect(page).toHaveURL(new RegExp("/projects/"+projectId+"/truth"));
    expect(actualGenerate).toBe(1);
    const project=await request.get("/api/projects/"+projectId);
    expect(project.status()).toBe(200);
    const data=await project.json();
    expect(data.project.currentProductTruthRef).toBeFalsy();
  } finally {
    const removed=await request.delete("/api/projects/"+projectId,{
      data:{confirmName:"V8 Research Before Truth"}
    });
    expect(removed.ok()).toBeTruthy();
  }
});

test("No research preflight can launch Douyin or submit paid video without explicit button click", async ({ page }) => {
  let launches = 0;
  const writes = [];
  await page.route("**/api/douyin/ops/research-readiness", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(blockedOps)
  }));
  await page.route("**/api/douyin/ops/launch", route => {
    launches += 1;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Bridge 未就绪" }) });
  });
  page.on("request", request => {
    if (!["GET", "HEAD"].includes(request.method())) writes.push(request.url());
  });
  await page.goto("/projects/e2e-ready/smart");
  await page.locator("#workflow-support-materials > summary").click();
  await page.locator('#workflow-support-materials [data-workflow-tool="research"]').click();
  await page.locator("#ux-native-research-form select[name=mode]").selectOption("DEEP");
  await expect(page.locator("#ux-native-research-form [data-douyin-connection-status]")).toContainText("尚未注册");
  expect(launches).toBe(0);
  expect(writes).toEqual([]);
  await page.locator("#ux-native-research-form [data-douyin-connect-launch]").click();
  expect(launches).toBe(1);
  expect(writes.filter(x => x.includes("/smart-runs/") || x.includes("/paid") || x.includes("/publish"))).toEqual([]);
});

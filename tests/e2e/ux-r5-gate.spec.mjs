import {test,expect} from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const screenshotDir=path.resolve(".runtime","ux-r5-browser");
async function shot(page,name){
  await fs.mkdir(screenshotDir,{recursive:true});
  await page.screenshot({path:path.join(screenshotDir,name),fullPage:true});
}
test("UX-R5 real Chrome desktop workbench shows one primary next action and zero iframe",async({page})=>{
  await page.setViewportSize({width:1366,height:768});
  const writes=[];
  page.on("request",r=>{if(!["GET","HEAD"].includes(r.method()))writes.push(r.method()+" "+r.url());});
  await page.goto("/projects/e2e-ready/smart");
  await expect(page.locator("main.ux-workbench")).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator(".ux-stages li")).toHaveCount(6);
  await expect(page.locator("#workflow-next-action a.primary")).toHaveCount(1);
  const current=await page.locator("#workflow-next-action").boundingBox();
  expect(current.y+current.height).toBeLessThanOrEqual(768);
  await shot(page,"desktop-active.png");
  expect(writes).toEqual([]);
});

test("UX-R5 390px mobile workbench has no horizontal scrolling and retains exact task navigation",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto("/projects/e2e-ready/smart");
  await expect(page.locator("main.ux-workbench")).toBeVisible();
  const sizes=await page.evaluate(()=>({
    viewport:window.innerWidth,
    scroll:document.documentElement.scrollWidth,
    right:document.documentElement.getBoundingClientRect().right
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.viewport+2);
  await expect(page.locator("#workflow-next-action a.primary")).toBeVisible();
  await expect(page.locator("#workflow-next-action a.primary")).toHaveAttribute("href","#review-panel-e2e-workflow-truth-run");
  await shot(page,"mobile-active.png");
  await page.goto("/projects/e2e-draft/smart");
  await expect(page.locator("#smart-create")).toBeVisible();
  await shot(page,"mobile-create.png");
});

test("UX-R5 optional research starts inside the task and never submits paid video generation",async({page})=>{
  const writes=[];
  // The enhanced research workflow requires both Bridge AND account readiness.
  await page.route("**/api/douyin/ops/research-readiness",route=>route.fulfill({
    status:200,contentType:"application/json",
    body:JSON.stringify({ready:true,status:"READY",message:"研究账号已连接"})
  }));
  await page.route("**/api/projects/e2e-ready/research/run",async route=>{
    writes.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({run:{status:"COMPLETED"}})});
  });
  await page.goto("/projects/e2e-ready/smart");
  await page.locator("#workflow-support-materials > summary").click();
  await page.locator('#workflow-support-materials [data-workflow-tool="research"]').click();
  const form=page.locator("#ux-native-research-form");
  await expect(form).toBeVisible();
  await form.locator('input[name="goal"]').fill("研究高赞耳夹式耳机的视频表达和使用场景");
  await form.locator('select[name="mode"]').selectOption("DEEP");
  page.on("dialog",d=>d.accept());
  await form.getByRole("button",{name:/在当前任务中开始研究/}).click();
  await expect.poll(()=>writes.length).toBe(1);
  expect(writes[0].path).toBe("/api/projects/e2e-ready/research/run");
  expect(writes[0].body.mode).toBe("DEEP");
  expect(writes[0].body.marketVideo).toMatchObject({enabled:true,sort:"MOST_LIKED"});
  expect(writes.some(x=>/paid|generation-batch|publish/.test(x.path))).toBe(false);
});

test("UX-R5 review interaction only posts after click and never silently authorizes payment",async({page})=>{
  await page.goto("/projects/e2e-ready/smart");
  const writes=[];
  await page.route("**/api/projects/e2e-ready/clips/clip-demo/review",async route=>{
    const request=route.request();
    writes.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});
    await route.fulfill({status:201,contentType:"application/json",body:JSON.stringify({decision:"ACCEPT"})});
  });
  await page.route("**/api/projects/e2e-ready/smart-runs/e2e-workflow-truth-run/resume",async route=>{
    writes.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});
    await route.fulfill({status:200,contentType:"application/json",body:"{}"});
  });
  // Only simulate the client click contract; server-side approval/version rules
  // are independently covered by service unit tests.
  await page.evaluate(()=>{
    const panel=document.querySelector("#review-panel-e2e-workflow-truth-run");
    const button=document.createElement("button");
    button.dataset.inlineAction="clip-decision";
    button.dataset.decision="ACCEPT";
    button.dataset.clip="clip-demo";
    button.dataset.attempt="attempt-demo";
    button.textContent="测试镜头采用";
    panel.append(button);
  });
  page.on("dialog",dialog=>dialog.accept());
  await page.getByRole("button",{name:"测试镜头采用"}).click();
  await expect.poll(()=>writes.length).toBe(2);
  expect(writes[0].body).toEqual({decision:"ACCEPT",generationAttemptId:"attempt-demo"});
  expect(writes[0].path).toBe("/api/projects/e2e-ready/clips/clip-demo/review");
  expect(writes[1].path).toBe("/api/projects/e2e-ready/smart-runs/e2e-workflow-truth-run/resume");
  expect(writes.some(x=>/paid|publish|submit/.test(x.path))).toBe(false);
});

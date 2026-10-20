import {test,expect} from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const root=process.cwd();
const imageDir=path.join(root,".runtime","ux-r2-r5-screenshots");

test("R2 task-first workbench is readable above the fold at 1366×768 and has zero frames",async({page})=>{
 const writes=[];page.on("request",r=>{if(!["GET","HEAD"].includes(r.method()))writes.push(r.url());});
 await page.setViewportSize({width:1366,height:768});
 await page.goto("/projects/e2e-ready/smart");
 await expect(page.locator("main.ux-workbench")).toBeVisible();
 await expect(page.locator(".ux-stages li[data-state=CURRENT]")).toHaveCount(1);
 await expect(page.locator("#workflow-next-action")).toBeVisible();
 await expect(page.locator("#run-list .run")).toBeVisible();
 await expect(page.locator("#workflow-purpose-entry")).toBeHidden();
 await expect(page.locator("iframe")).toHaveCount(0);
 const metrics=await page.evaluate(()=>{
  const a=document.querySelector('#workflow-next-action').getBoundingClientRect();
  return {top:a.top,bottom:a.bottom,scrollWidth:document.documentElement.scrollWidth,windowWidth:innerWidth};
 });
 expect(metrics.top).toBeLessThan(768);
 expect(metrics.scrollWidth).toBeLessThanOrEqual(1366);
 await fs.mkdir(imageDir,{recursive:true});
 await page.screenshot({path:path.join(imageDir,"ux-r2-task-1366.png")});
 expect(writes).toEqual([]);
});

test("R2 mobile width 390 is not horizontally scrollable, and legacy fallback works",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto("/projects/e2e-ready/smart");
 const layout=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));
 expect(layout.width).toBeLessThanOrEqual(layout.viewport+2);
 await expect(page.locator(".ux-stages")).toBeVisible();
 await expect(page.locator("#workflow-next-action")).toBeVisible();
 await expect(page.locator("#workflow-purpose-entry")).toBeHidden();
 await fs.mkdir(imageDir,{recursive:true});
 await page.screenshot({path:path.join(imageDir,"ux-r2-task-mobile390.png"),fullPage:true});
 await page.goto("/projects/e2e-ready/smart?ui=legacy");
 await expect(page.locator("main.ux-workbench")).toHaveCount(0);
 await expect(page.locator("#workflow-next-action")).toBeVisible();
 await expect(page.locator("#workflow-purpose-entry")).toBeVisible();
});

test("R3 truth in-page confirmation posts once, resumes exact Run, auto-refreshes without paid action",async({page})=>{
 await page.goto("/projects/e2e-ready/smart?activeRun=e2e-workflow-truth-run");
 const posted=[];
 await page.route("**/api/projects/e2e-ready/truth/confirm",async route=>{
   posted.push({path:"truth",body:route.request().postDataJSON()});
   await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})});
 });
 await page.route("**/api/projects/e2e-ready/smart-runs/e2e-workflow-truth-run/resume",async route=>{
   posted.push({path:"resume",body:route.request().postDataJSON()});
   await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})});
 });
 await page.evaluate(()=>{
  const panel=document.querySelector("#ux-truth-review");
  panel.insertAdjacentHTML("beforeend",'<select data-inline-claim="claim-a"><option value="KEEP_UNVERIFIED">保留未验证</option></select><button type="button" data-inline-action="truth-confirm">确认本轮事实</button>');
 });
 page.once("dialog",dlg=>dlg.accept());
 await page.getByRole("button",{name:"确认本轮事实"}).click();
 await expect.poll(()=>posted.length).toBe(2);
 expect(posted.map(p=>p.path)).toEqual(["truth","resume"]);
 expect(posted[0].body.dispositions["claim-a"]).toBe("KEEP_UNVERIFIED");
 expect(posted[0].body.projectId).toBe("e2e-ready");
 await expect(page).toHaveURL(/activeRun=e2e-workflow-truth-run/);
});

test("R4 single-clip REDO targets only selected attempt and never triggers an automatic generation or resume",async({page})=>{
 await page.goto("/projects/e2e-ready/smart?activeRun=e2e-workflow-truth-run");
 const posts=[];page.on("request",r=>{if(r.method()==="POST")posts.push(r.url());});
 await page.route("**/api/projects/e2e-ready/clips/clip-only/review",route=>
  route.fulfill({status:201,contentType:"application/json",body:'{"ok":true}'}));
 await page.evaluate(()=>{
  const host=document.querySelector("#smart-run-e2e-workflow-truth-run");
  host.insertAdjacentHTML("afterbegin",'<section class="ux-native-review" id="mock-clip-review"><button data-inline-action="clip-decision" data-decision="REDO" data-clip="clip-only" data-attempt="attempt-only">仅重做此镜头</button></section>');
 });
 page.once("dialog",dlg=>dlg.accept());
 await page.locator("#mock-clip-review button").click();
 await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0]).toContain("/clips/clip-only/review");
 expect(posts.some(u=>u.includes("/resume")||u.includes("/paid")||u.includes("/publish"))).toBe(false);
});

test("R4 native reference inclusion refuses to submit without explicit rights",async({page})=>{
 await page.goto("/projects/e2e-ready/smart");
 const posted=[];page.on("request",r=>{if(r.method()==="POST")posted.push(r.url());});
 await page.evaluate(()=>{
  const host=document.querySelector("#smart-run-e2e-workflow-truth-run");
  host.insertAdjacentHTML("afterbegin",'<section class="ux-native-review" id="ux-reference-review" data-revision="1" data-truth="test"><input type="checkbox" id="ux-reference-rights"><article class="ux-ref-candidate" data-ux-ref-id="ref-1" data-ux-ref-hash="sha-1"><select class="ux-ref-role"><option value="SCENE_REFERENCE">场景</option></select><button data-inline-action="ref-review" data-decision="INCLUDE">加入参考</button></article><p class="ux-inline-error"></p></section>');
 });
 await page.getByRole("button",{name:"加入参考"}).click();
 await expect(page.locator("#ux-reference-review .ux-inline-error").first()).toContainText("请先确认素材使用权");
 expect(posted).toEqual([]);
});

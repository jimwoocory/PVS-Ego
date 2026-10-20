import {test, expect} from "@playwright/test";

test("UX-R2 focuses the active task and keeps new-goal options secondary",async({page,request})=>{
  const writes=[];
  page.on("request",r=>{if(!["GET","HEAD"].includes(r.method()))writes.push(r.url());});
  await page.setViewportSize({width:1366,height:768});
  await page.goto("/projects/e2e-ready/smart");
  await expect(page.locator("main.ux-workbench")).toBeVisible();
  await expect(page.locator(".ux-stages li")).toHaveCount(6);
  await expect(page.locator("#workflow-next-action")).toContainText("审核产品事实与使用规则");
  const options=page.locator("#ux-new-goal-options");
  await expect(options).toBeVisible();
  await expect(options).not.toHaveAttribute("open","");
  await expect(page.getByRole("heading",{name:"这次想完成什么？"})).toBeHidden();
  const box=await page.locator("#workflow-next-action").boundingBox();
  expect(box.y+box.height).toBeLessThan(768);
  await page.locator("#ux-new-goal-options > summary").click();
  await expect(page.getByRole("heading",{name:"这次想完成什么？"})).toBeVisible();
  expect(writes).toEqual([]);
});

test("UX-R2 new project path shows creation choices while old view remains available",async({page})=>{
  await page.goto("/projects/e2e-draft/smart");
  await expect(page.locator("main.ux-workbench")).toBeVisible();
  await expect(page.getByRole("heading",{name:"这次想完成什么？"})).toBeVisible();
  await expect(page.locator("#smart-create")).toBeVisible();
  await expect(page.locator("#ux-new-goal-options")).toHaveCount(0);
  await page.goto("/projects/e2e-ready/smart?ui=legacy");
  await expect(page.locator("main.ux-workbench")).toHaveCount(0);
  await expect(page.locator(".main-nav")).toBeVisible();
});

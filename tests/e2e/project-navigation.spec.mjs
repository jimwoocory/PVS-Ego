import { test, expect } from "@playwright/test";

function collectBrowserErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("project navigation exposes the V2 smart-production main chain while legacy pages remain reachable", async ({ page }) => {
  const errors = collectBrowserErrors(page);

  await page.goto("/projects/e2e-ready/product");
  await expect(page.getByRole("heading", { name: "产品输入", level: 1 })).toBeVisible();
  await expect(page.locator(".workflow-nav")).toContainText("当前位置：产品输入 · 本页任务：检查或更新产品资料");
  await expect(page.locator(".workflow-nav")).toContainText("智能生产主链");
  await expect(page.locator(".workflow-nav-head")).toContainText("当前任务下一步：");
  await expect(page.locator("#workflow-read-model")).toContainText("审核产品事实与使用规则");
  await expect(page.locator(".main-steps")).toContainText("1 产品资料");
  await expect(page.locator(".main-steps")).toContainText("2 智能生成");
  await expect(page.locator(".main-steps")).toContainText("3 成片 / 发布");
  await expect(page.locator(".step-current")).toHaveCount(1);
  await expect(page.locator(".main-steps")).not.toContainText("导演分镜");
  await expect(page.locator(".main-steps")).not.toContainText("视频剪辑");

  await page.getByRole("link", { name: "联网研究" }).click();
  await expect(page).toHaveURL(/\/projects\/e2e-ready\/research$/);
  await expect(page.locator(".workflow-nav")).toContainText("当前位置：联网研究 · 本页任务：补充公开证据并筛选可用研究结果");
  await expect(page.locator(".workflow-nav-head")).toContainText("当前任务下一步：");
  await expect(page.locator("#workflow-read-model")).toContainText("审核产品事实与使用规则");
  await expect(page.locator(".main-steps")).not.toContainText("创意方案");

  expect(errors).toEqual([]);
});

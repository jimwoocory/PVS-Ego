import { test, expect } from "@playwright/test";

test("Health Center renders subsystem diagnosis without external paid actions", async ({ page, request }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  const response = await page.goto("/health-center?projectId=e2e-ready");
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("heading", { name: "系统诊断中心", level: 1 })).toBeVisible();
  await expect(page.locator("body")).toContainText("不会消耗 Dreamina 积分");
  await expect(page.locator('[data-health-group="AI"]')).toHaveCount(1);
  await expect(page.locator('[data-health-group="DREAMINA"]')).toHaveCount(1);
  await expect(page.locator('[data-health-group="MEDIA"]')).toHaveCount(2);
  await expect(page.locator('[data-health-group="DATABASE"]')).toHaveCount(1);
  await expect(page.locator('[data-health-group="RESEARCH"]')).toHaveCount(1);
  expect(await page.locator('[data-health-group="PUBLISH"]').count()).toBeGreaterThanOrEqual(4);

  await expect(page.locator("body")).toContainText("尚未配置大模型 Provider");
  await expect(page.locator("body")).toContainText("Dreamina CLI 未找到");
  await expect(page.locator("body")).toContainText("公开搜索 fallback 仍可用");
  await expect(page.locator("body")).toContainText("下载 MP4 / 手动发布");

  const selected = page.locator('select[name="projectId"]');
  await expect(selected).toHaveValue("e2e-ready");
  await selected.selectOption("e2e-research");
  await page.getByRole("button", { name: "切换项目并重新检查" }).click();
  await expect(page).toHaveURL(/\/health-center\?projectId=e2e-research$/);
  await expect(selected).toHaveValue("e2e-research");

  const api = await request.get("/api/health/report?projectId=e2e-ready");
  expect(api.ok()).toBeTruthy();
  const body = await api.json();
  expect(body.report.projectId).toBe("e2e-ready");
  expect(body.report.items.some((item) => item.group === "DATABASE")).toBeTruthy();
  expect(body.report.items.some((item) => item.group === "PUBLISH")).toBeTruthy();

  expect(errors).toEqual([]);
});

import { test, expect } from "@playwright/test";

test("Final QC runs from the final page and gates final acceptance", async ({ page, request }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/projects/e2e-final/final");

  await expect(page.getByRole("heading", { name: "成片与发布", level: 1 })).toBeVisible();
  await expect(page.locator("body")).toContainText("发布前 QC：尚未运行");
  const acceptBefore = page.getByRole("button", { name: "接受成片" });
  await expect(acceptBefore).toBeDisabled();

  await page.getByRole("button", { name: "运行发布前质检" }).click();
  await expect(page.locator("body")).toContainText("发布前 QC：有警告", {
    timeout: 20_000
  });
  await expect(page.locator("body")).toContainText("产品视觉一致性");
  await expect(page.locator("body")).toContainText("音轨");
  await expect(page.getByRole("button", { name: "接受成片" })).toBeEnabled();

  const qcResponse = await request.get("/api/projects/e2e-final/final/qc");
  expect(qcResponse.ok()).toBeTruthy();
  const qc = await qcResponse.json();
  expect(qc.report.overall).toBe("WARN");
  expect(qc.report.artifactId).toBe("e2e-final-artifact");
  expect(qc.report.checks.some((item) => item.code === "AUDIO_STREAM" && item.severity === "PASS")).toBeTruthy();
  expect(qc.report.checks.some((item) => item.code === "VISUAL_PRODUCT_IDENTITY" && item.severity === "WARN")).toBeTruthy();

  await page.getByRole("button", { name: "接受成片" }).click();
  await expect(page.locator("body")).toContainText("成片确认：已确认", {
    timeout: 20_000
  });
  await expect(page.locator("body")).toContainText("发布前 QC：有警告");
  await expect(page.locator("body")).toContainText("发布设置 / 切换发布方式");

  expect(errors).toEqual([]);
});

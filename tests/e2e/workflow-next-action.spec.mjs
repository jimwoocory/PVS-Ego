import { test, expect } from "@playwright/test";

test("W1 unified workflow presents one next step, returns to the originating task and has a read-only status API", async ({ page, request }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  await page.goto("/projects/e2e-draft/smart");
  const box = page.locator("#workflow-next-action");
  await expect(box).toBeVisible();
  await expect(box).toContainText("当前工作流");
  await expect(box).toContainText("补充产品资料与图片");
  await expect(box.locator("a")).toHaveAttribute("href", "/projects/e2e-draft/product");
  const initial = await request.get("/api/projects/e2e-draft/workflow");
  expect(initial.ok()).toBe(true);
  const result = await initial.json();
  expect(result.workflow.source).toBe("PROJECT");
  expect(result.workflow.action.kind).toBe("OPEN");
  expect(result.workflow.action.href).toBe("/projects/e2e-draft/product");

  await box.getByRole("link", { name: "补充产品资料与图片" }).click();
  await expect(page).toHaveURL(/\/projects\/e2e-draft\/product$/);

  // A same-project saved SmartRun is required; arbitrary return URLs are never trusted.
  await page.route("**/api/projects/e2e-ready/smart-runs/run-browser-123", route =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ run: { id: "run-browser-123", projectId: "e2e-ready" } })
    })
  );
  await page.goto("/projects/e2e-ready/product?fromSmartRun=run-browser-123");
  const returnBox = page.locator("#smart-return-card");
  await expect(returnBox).toBeVisible();
  await expect(returnBox.getByRole("link", {name: "返回原智能生成任务"}))
    .toHaveAttribute("href", "/projects/e2e-ready/smart?activeRun=run-browser-123#smart-run-run-browser-123");
  await returnBox.getByRole("link", {name: "返回原智能生成任务"}).click();
  await expect(page).toHaveURL(/\/projects\/e2e-ready\/smart\?activeRun=run-browser-123#smart-run-run-browser-123$/);

  await page.goto("/projects/e2e-ready/product?fromSmartRun=https%3A%2F%2Fevil.invalid");
  await expect(page.locator("#smart-return-card")).toBeHidden();
  const rejected = await request.post("/api/projects/e2e-ready/workflow", {data:{}});
  expect(rejected.status()).toBe(405);
  expect(errors).toEqual([]);
});

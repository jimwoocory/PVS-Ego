import { test, expect } from "@playwright/test";

function collectBrowserErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("timeline deep link renders an actionable Chinese blocked page instead of raw JSON", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const response = await page.goto("/projects/e2e-ready/timeline");

  expect(response?.status()).toBe(200);
  await expect(page.getByText("视频剪辑暂时不能打开")).toBeVisible();
  await expect(page.getByText("还没有可用于剪辑的当前导演分镜。")).toBeVisible();
  const action = page.getByRole("link", { name: "返回正确步骤" });
  await expect(action).toHaveAttribute("href", "/projects/e2e-ready/director");
  await expect(page.locator("body")).not.toContainText("VALIDATION_ERROR");
  await expect(page.locator("body")).not.toContainText("At least one accepted generated video");
  expect(errors).toEqual([]);
});

test("final deep link follows the same productized access gate", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const response = await page.goto("/projects/e2e-ready/final");

  expect(response?.status()).toBe(200);
  await expect(page.getByText("成片还没有准备好")).toBeVisible();
  await expect(page.getByText("当前还没有可用于最终渲染的有效剪辑方案。")).toBeVisible();
  await expect(page.getByRole("link", { name: "返回正确步骤" })).toHaveAttribute(
    "href",
    "/projects/e2e-ready/director"
  );
  await expect(page.locator("body")).not.toContainText("VALIDATION_ERROR");
  expect(errors).toEqual([]);
});

test("API validation remains JSON even though browser pages are productized", async ({ request }) => {
  const response = await request.post("/api/projects/e2e-ready/final/render");
  expect(response.status()).toBe(400);
  expect(response.headers()["content-type"]).toContain("application/json");
  const body = await response.json();
  expect(body.error).toBe("VALIDATION_ERROR");
});

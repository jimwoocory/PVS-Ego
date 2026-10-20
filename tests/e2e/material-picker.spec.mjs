import { test, expect } from "@playwright/test";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0h8AAAAASUVORK5CYII=",
  "base64"
);

test("create project and product image/logo pickers respond to real browser clicks", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/projects");
  await page.getByLabel("项目名称").fill("E2E Material Picker");
  await page.getByLabel("目标时长（秒）").fill("15");
  await page.getByRole("button", { name: "开始填写产品资料" }).click();

  await expect(page).toHaveURL(/\/projects\/[^/]+\/product$/);
  await page.locator('#product-form input[name="productName"]').fill("E2E Product");
  await page.locator('#product-form input[name="brand"]').fill("E2E Brand");
  await page.locator('#product-form input[name="category"]').fill("测试产品");
  await page.locator('#product-form textarea[name="featureDescription"]').fill("用于浏览器文件选择回归测试，不提交生成。");

  await expect(page.locator("button#product-image-pick")).toBeVisible();
  await expect(page.locator("button#product-logo-pick")).toBeVisible();

  const imageChooserPromise = page.waitForEvent("filechooser");
  await page.locator("button#product-image-pick").click();
  const imageChooser = await imageChooserPromise;
  await imageChooser.setFiles({
    name: "product.png",
    mimeType: "image/png",
    buffer: png
  });

  await expect(page.locator("#product-image-list")).toContainText("product.png");
  await expect(page.locator("#product-image-list")).toContainText("待上传");
  await page.locator("#product-image-list").getByRole("button", { name: "删除" }).click();
  await expect(page.locator("#product-image-list")).toContainText("尚未选择产品图片。");

  const secondImageChooserPromise = page.waitForEvent("filechooser");
  await page.locator("button#product-image-pick").click();
  const secondImageChooser = await secondImageChooserPromise;
  await secondImageChooser.setFiles({
    name: "product-2.png",
    mimeType: "image/png",
    buffer: png
  });
  await expect(page.locator("#product-image-list")).toContainText("product-2.png");

  const logoChooserPromise = page.waitForEvent("filechooser");
  await page.locator("button#product-logo-pick").click();
  const logoChooser = await logoChooserPromise;
  await logoChooser.setFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: png
  });

  await expect(page.locator("#product-logo-preview")).toContainText("logo.png");
  await expect(page.getByRole("button", { name: "删除 Logo" })).toBeEnabled();
  await page.getByRole("button", { name: "删除 Logo" }).click();
  await expect(page.locator("#product-logo-preview")).toContainText("尚未选择 Logo。");

  expect(errors).toEqual([]);
});

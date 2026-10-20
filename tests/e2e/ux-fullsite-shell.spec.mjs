import { test, expect } from "@playwright/test";

// The previous UX-R2–R5 suite exercised primarily the smart workbench.
// This gate intentionally visits EVERY independent end-user HTML page.
const project = "/projects/e2e-ready";
const routes = [
  "/projects", "/agent", "/tasks", "/health-center", "/settings/ai", "/douyin-ops",
  project + "/douyin", project + "/smart", project + "/product", project + "/truth",
  project + "/research", project + "/reference-video", project + "/creative-references",
  project + "/creative", project + "/script", project + "/director", project + "/generate",
  project + "/single-video", project + "/auto-edit", project + "/models", project + "/timeline",
  project + "/final", project + "/publish-settings", "/publish/mobile/test-package"
];

test.describe("全站页面一致性回归", () => {
  for (const target of [
    { name: "桌面 1366px", width: 1366, height: 768 },
    { name: "手机 390px", width: 390, height: 844 }
  ]) {
    test(`${target.name}：所有用户页面使用唯一导航，无页面嵌套与横向溢出`, async ({ page }) => {
      test.setTimeout(420_000);
      await page.setViewportSize({ width: target.width, height: target.height });
      for (const route of routes) {
        await test.step(route, async () => {
          const response = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 40_000 });
          expect(response?.status(), route).toBe(200);
          await expect(page.locator('[data-pvs-ui-shell="unified-v2"]'), route).toHaveCount(1);
          const mobileHandoff = route.startsWith("/publish/mobile/");
          await expect(page.locator('nav[aria-label="全局导航"]'), route).toHaveCount(mobileHandoff ? 0 : 1);
          await expect(page.locator("iframe"), route).toHaveCount(0);
          if (target.width < 400) {
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow, `页面 ${route} 不应横向溢出`).toBeLessThanOrEqual(2);
          }
        });
      }
    });
  }
});

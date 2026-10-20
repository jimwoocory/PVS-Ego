import { test, expect } from "@playwright/test";

test("research page exposes candidate rejection and recovery audit", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/projects/e2e-research/research");

  await expect(page.getByRole("heading", { name: "搜索质量与淘汰记录" })).toBeVisible();
  await expect(page.locator("body")).toContainText("2 轮");
  await expect(page.locator("body")).toContainText("哔哩哔哩首页");
  await expect(page.locator("body")).toContainText("平台首页且未命中产品身份，直接淘汰");
  await expect(page.locator("body")).toContainText("Test Product 官方 说明书 PDF");
  await expect(page.locator("body")).toContainText("形成证据");
  await expect(page.locator("body")).not.toContainText("VALIDATION_ERROR");

  expect(errors).toEqual([]);
});

test("Douyin risk-control card exposes one-click verification handling", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/projects/e2e-ready/research");
  await expect(
    page.getByRole("heading", { name: "抖音爆款 / 竞品视频", exact: true })
  ).toBeVisible();
  await expect(page.locator("body")).toContainText(
    "抖音搜索触发验证码或平台风控"
  );
  const open = page.getByRole("button", {
    name: "打开抖音搜索页查看"
  });
  await expect(open).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重新检测风控状态" })
  ).toBeVisible();
  await expect(page.locator("body")).toContainText(
    "一直只有灰色骨架、没有验证码或滑块"
  );

  const response = page.waitForResponse(
    (item) =>
      item.request().method() === "POST" &&
      item.url().endsWith(
        "/api/projects/e2e-ready/research/douyin-auth/launch"
      )
  );
  await open.click();
  expect((await response).status()).toBe(202);
  await expect(page.locator("#douyin-research-auth-status")).toContainText(
    "已打开 PVS 抖音研究独立浏览器"
  );
  expect(errors).toEqual([]);
});

test("Douyin rerun shows local progress immediately and ignores duplicate clicks", async ({ page }) => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/projects/e2e-ready/research/run",
    async (route) => {
      calls += 1;
      await gate;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          run: { id: "rerun-fixture", status: "FAILED" },
          evidence: []
        })
      });
    }
  );
  await page.goto("/projects/e2e-ready/research");
  const rerun = page.locator("#douyin-research-auth-rerun");
  await rerun.click();
  await expect(rerun).toBeDisabled();
  await expect(rerun).toHaveText("正在检测风控…");
  await expect(page.locator("#douyin-research-auth-status")).toContainText(
    "抖音搜索限制已解除，正在重新研究，请勿重复点击"
  );
  await page.waitForTimeout(150);
  expect(calls).toBe(1);
  release();
});

test("research HTTP refuses a second concurrent run for the same project", async ({ request }) => {
  const create = await request.post("/api/projects", {
    data: {
      name: "E2E Research Mutex",
      targetDurationMs: 10000
    }
  });
  expect(create.ok()).toBeTruthy();
  const projectId = (await create.json()).project.id;
  const body = {
    mode: "DEEP",
    goal: "__E2E_RESEARCH_MUTEX__",
    sourceUrls: [],
    queries: ["fixture"],
    marketVideo: { enabled: false, sort: "MOST_LIKED", timeRange: "ANY", count: 12 }
  };
  const first = request.post(
    "/api/projects/" + encodeURIComponent(projectId) + "/research/run",
    { data: body }
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await request.post(
    "/api/projects/" + encodeURIComponent(projectId) + "/research/run",
    { data: body }
  );
  expect(second.status()).toBe(409);
  const secondBody = await second.json();
  expect(secondBody.error).toBe("RESEARCH_ALREADY_RUNNING");
  expect(secondBody.message).toContain("已有研究任务正在运行");
  expect((await first).status()).toBe(201);

  const deleted = await request.delete(
    "/api/projects/" + encodeURIComponent(projectId),
    { data: { confirmName: "E2E Research Mutex" } }
  );
  expect(deleted.ok()).toBeTruthy();
});

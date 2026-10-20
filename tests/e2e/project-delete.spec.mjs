import { test, expect } from "@playwright/test";

test("project list deletes only the confirmed project and keeps other projects", async ({ page, request }) => {
  const targetName = "E2E Delete Target";
  const create = await request.post("/api/projects", {
    data: {
      name: targetName,
      targetDurationMs: 10000
    }
  });
  expect(create.ok()).toBeTruthy();
  const created = await create.json();
  const targetId = created.project.id;

  await page.goto("/projects");
  const targetCard = page.locator("article.card").filter({ hasText: targetName });
  await expect(targetCard).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "E2E Ready Project" })).toBeVisible();

  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === "confirm") {
      await dialog.accept();
    } else if (dialog.type() === "prompt") {
      await dialog.accept(targetName);
    } else {
      await dialog.dismiss();
    }
  });

  const deleteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().endsWith("/api/projects/" + encodeURIComponent(targetId))
  );
  await targetCard.getByRole("button", { name: "删除项目" }).click();
  expect((await deleteResponse).ok()).toBeTruthy();

  await expect(page.locator("article.card").filter({ hasText: targetName })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "E2E Ready Project" })).toBeVisible();
  expect(dialogs).toHaveLength(2);
  expect(dialogs[0].message).toContain(targetName);
  expect(dialogs[1].message).toContain(targetName);

  const direct = await request.get("/projects/" + encodeURIComponent(targetId) + "/product");
  expect([404, 400]).toContain(direct.status());
});

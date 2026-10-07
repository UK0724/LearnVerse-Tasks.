import { test, expect, Page } from "@playwright/test";
async function setup(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page
    .getByLabel("Email", { exact: true })
    .fill(`board-${Date.now()}-${Math.random()}@example.test`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("another browser password");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("another browser password");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  const p = await command(page, "project.create", {
    name: "Board test",
    prefix: "BT",
  });
  await page.reload();
  if (page.viewportSize()!.width <= 650)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await page.getByRole("button", { name: "▦ Board", exact: true }).click();
  return p;
}
async function workspace(page: Page) {
  return (await page.request.get("/api/v1/workspace")).json();
}
async function command(page: Page, action: string, body: any) {
  const s = await workspace(page);
  const r = await page.request.post("/api/v1/commands/" + action, {
    headers: {
      "If-Match": `"${s.revision}"`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: body,
  });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).result;
}
async function drag(
  page: Page,
  from: string,
  target: ReturnType<Page["locator"]>,
) {
  const start = await page
      .getByRole("button", { name: "Reorder " + from, exact: true })
      .boundingBox(),
    end = await target.boundingBox();
  expect(start).not.toBeNull();
  expect(end).not.toBeNull();
  await page.mouse.move(
    start!.x + start!.width / 2,
    start!.y + start!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    start!.x + start!.width / 2,
    start!.y + start!.height / 2 - 10,
    { steps: 3 },
  );
  await page.mouse.move(
    end!.x + end!.width / 2,
    end!.y + Math.min(end!.height / 2, 150),
    { steps: 15 },
  );
  await page.mouse.up();
}
test("filtered pointer and keyboard ordering persist without reordering hidden cards", async ({
  page,
}) => {
  const p = await setup(page);
  for (const title of [
    "visible A",
    "hidden B",
    "visible C",
    "hidden D",
    "visible E",
  ])
    await command(page, "task.create", {
      projectId: p.id,
      title,
      type: "task",
    });
  await page.reload();
  await page
    .getByRole("button", { name: "Board", exact: false })
    .first()
    .click();
  await page.getByLabel("Search tasks").fill("visible");
  await drag(
    page,
    "BT-5",
    page.locator("article").filter({
      has: page.getByRole("button", { name: "visible C", exact: true }),
    }),
  );
  await expect
    .poll(async () => (await workspace(page)).tasks.map((t: any) => t.title))
    .toEqual(["visible A", "hidden B", "visible E", "visible C", "hidden D"]);
  await expect(
    page.getByRole("button", { name: "Reorder BT-5", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Reorder BT-5", exact: true }).focus();
  await page.keyboard.press("Space", { delay: 100 });
  await expect(
    page.getByRole("button", { name: "Reorder BT-5", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  const third = (await workspace(page)).tasks.find(
    (t: any) => t.key === "BT-3",
  );
  await expect(page.getByRole("status").last()).toContainText(
    "Move to " + third.title,
  );
  await page.keyboard.press("Space", { delay: 100 });
  await expect(
    page.getByRole("button", { name: "Reorder BT-5", exact: true }),
  ).not.toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () =>
      (await workspace(page)).tasks
        .filter((t: any) => t.title.startsWith("visible"))
        .map((t: any) => t.title),
    )
    .toEqual(["visible A", "visible C", "visible E"]);
  const target = page
    .locator(".column")
    .filter({ has: page.getByRole("heading", { name: "To Do" }) });
  await drag(page, "BT-1", target);
  await expect
    .poll(
      async () =>
        (await workspace(page)).tasks.find((t: any) => t.key === "BT-1")
          .statusId,
    )
    .toBe(p.statuses[1].id);
  await page.reload();
  await page
    .getByRole("button", { name: "Board", exact: false })
    .first()
    .click();
  await expect(
    target.getByRole("button", { name: "visible A", exact: true }),
  ).toBeVisible();
  expect(
    (await workspace(page)).tasks
      .filter((t: any) => t.title.startsWith("hidden"))
      .map((t: any) => t.title),
  ).toEqual(["hidden B", "hidden D"]);
  await page.getByLabel("Sort", { exact: true }).selectOption("priority");
  await expect(
    page.getByRole("button", { name: "Reorder BT-1", exact: true }),
  ).toBeDisabled();
});
test("failed optimistic move rolls back; stale editing does not overwrite a concurrent edit", async ({
  page,
}) => {
  const p = await setup(page);
  const task = await command(page, "task.create", {
    projectId: p.id,
    title: "Original task",
    type: "task",
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Board", exact: false })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Original task", exact: true })
    .click();
  await page.route("**/api/v1/commands/task.move", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "UNAVAILABLE", message: "Test save failure" },
      }),
    }),
  );
  await page
    .getByRole("combobox", { name: "Move to status", exact: true })
    .selectOption({ label: "In Progress" });
  await expect(page.getByRole("alert")).toContainText("Test save failure");
  await expect(
    page.getByRole("combobox", { name: "Move to status", exact: true }),
  ).toHaveValue(p.statuses[0].id);
  expect((await workspace(page)).tasks[0].statusId).toBe(p.statuses[0].id);
  await page.unroute("**/api/v1/commands/task.move");
  await command(page, "task.update", { id: task.id, title: "Concurrent edit" });
  await page.getByLabel("Title", { exact: true }).fill("Stale edit");
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Workspace changed");
  expect((await workspace(page)).tasks[0].title).toBe("Concurrent edit");
  await page.getByLabel("Close details").click();
  await expect(
    page.getByRole("button", { name: "Concurrent edit", exact: true }),
  ).toBeVisible();
});
test("mobile workflow exposes task status controls without horizontal page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const p = await setup(page);
  await command(page, "task.create", {
    projectId: p.id,
    title: "Mobile task",
    type: "task",
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Board", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "Mobile task", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Move to status", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

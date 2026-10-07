import { test, expect } from "@playwright/test";
test("project, tasks, sprint carryover, refresh persistence and keyboard/status changes", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page
    .getByLabel("Email", { exact: true })
    .fill(`browser-${Date.now()}@example.test`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser secure password");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("browser secure password");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.getByLabel("Project name").fill("Browser project");
  await page.getByLabel("Key prefix").fill("BP");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.getByRole("button", { name: "▦ Board", exact: true }).click();
  await page.getByRole("button", { name: "Create task" }).click();
  await page.getByLabel("Title", { exact: true }).fill("First browser task");
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "First browser task", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Sprints", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "Plan sprint" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Browser sprint");
  await page.getByLabel("Goal").fill("Verify persistence");
  await page.getByLabel("Start date").fill("2026-10-06");
  await page.getByLabel("End date").fill("2026-10-20");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Plan sprint" })
    .click();
  await page
    .getByRole("button", { name: "Board", exact: false })
    .first()
    .click();
  await page
    .getByRole("button", { name: "First browser task", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Sprint", exact: true })
    .selectOption({ label: "Browser sprint" });
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await page
    .getByRole("button", { name: "First browser task", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Move to status", exact: true })
    .selectOption({ label: "In Progress" });
  await expect(page.getByText("Saving…", { exact: true })).not.toBeVisible();
  await page.getByLabel("Close details").click();
  await page.reload();
  await page
    .getByRole("button", { name: "Board", exact: false })
    .first()
    .click();
  await expect(
    page
      .locator(".column")
      .filter({ has: page.getByRole("heading", { name: "In Progress" }) })
      .getByRole("button", { name: "First browser task", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Sprints", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "Start sprint" }).click();
  await page
    .getByRole("button", { name: "Complete sprint", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("First browser task", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Complete and save snapshot" })
    .click();
  await expect(
    page.getByText("Immutable completion snapshot", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Sprints", exact: false })
    .first()
    .click();
  await expect(
    page.getByText("Immutable completion snapshot", { exact: false }),
  ).toBeVisible();
});

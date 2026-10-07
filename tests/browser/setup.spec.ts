import { test, expect, Page } from "@playwright/test";
async function signUp(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page
    .getByLabel("Email", { exact: true })
    .fill(`setup-${Date.now()}-${Math.random()}@example.test`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("secure setup test password");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("secure setup test password");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}
test("an empty workspace starts with one project action and no sample or filter clutter", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page);
  await expect(
    page.getByRole("heading", { name: "Create your first project" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load fictional samples" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Search tasks", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.getByLabel("Project name").fill("My project");
  await page.getByLabel("Key prefix").fill("WORK");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Open navigation", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "WO My project", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close navigation", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("integration setup shows explicit scopes, a one-time secret, and revocation controls", async ({
  page,
}) => {
  await signUp(page);
  let credential: any = null;
  let submitted: any = null;
  let revoked = false;
  const secret = "fixture-secret-not-a-live-credential";
  await page.route("**/api/v1/integrations/credentials", async (route) => {
    if (route.request().method() === "POST") {
      submitted = route.request().postDataJSON();
      credential = {
        id: "fixture",
        name: submitted.name,
        permissions: submitted.permissions,
        expiresAt: "2026-12-01T00:00:00Z",
        revokedAt: null,
      };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ credential, token: secret }),
      });
    } else
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          credentials: credential ? [credential] : [],
          mcpEnabled: false,
        }),
      });
  });
  await page.route("**/api/v1/integrations/audit?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0, page: 1, limit: 50 }),
    }),
  );
  await page.route("**/api/v1/integrations/credentials/fixture", (route) => {
    revoked = true;
    credential.revokedAt = new Date().toISOString();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ credential }),
    });
  });
  await page
    .getByRole("button", { name: "Integrations", exact: false })
    .click();
  await expect(
    page.getByText("No credentials have been created.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Credential name").fill("Scoped test assistant");
  await page.getByLabel("tasks:write", { exact: true }).check();
  await page
    .getByRole("button", { name: "Create scoped credential", exact: true })
    .click();
  await expect(page.getByLabel("New credential secret")).toHaveValue(secret);
  expect(submitted.permissions).toEqual([
    "tasks:read",
    "projects:read",
    "tasks:write",
  ]);
  expect(submitted.expiresInDays).toBe(7);
  await page.getByRole("button", { name: "Hide secret", exact: true }).click();
  await expect(page.getByLabel("New credential secret")).not.toBeVisible();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Revoke", exact: true }),
  ).toBeDisabled();
  expect(revoked).toBe(true);
});

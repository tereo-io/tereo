import { expect, test as setup } from "@playwright/test";
import { signIn } from "../utils/signIn.js";
import { e2e } from "../config.js";

// Runs once per run, before every other spec, on the database the webServer
// just recreated: setup is pending, so every path leads to /setup.
setup(
  "first-run setup creates the admin, who signs in",
  async ({ page, request }) => {
    const status = await request.get("/v1/setup/status");
    const { setupComplete } = (await status.json()) as {
      setupComplete: boolean;
    };

    if (setupComplete) {
      // Only on a reused core (E2E_REUSE_CORE=1), where an earlier run did it.
      await page.goto("/");
      await page.getByRole("button", { name: "Sign in to Tereo" }).click();
    } else {
      await page.goto("/");
      await expect(page).toHaveURL(/\/setup$/);
      await expect(
        page.getByRole("heading", { name: "Set up Tereo" })
      ).toBeVisible();

      await page.getByLabel("Token").fill(e2e.setupToken);
      // "Name" labels both the admin's and the organization's name field; the
      // admin's comes first, the organization's has a placeholder.
      await page
        .getByRole("textbox", { name: "Name", exact: true })
        .first()
        .fill(e2e.admin.name);
      await page.getByLabel("Email").fill(e2e.admin.email);
      await page
        .getByRole("textbox", { name: "Password", exact: true })
        .fill(e2e.admin.password);
      await page.getByLabel("Confirm password").fill(e2e.admin.password);
      await page.getByPlaceholder("e.g. Acme").fill(e2e.organization.name);
      // Slug and code follow the organization's name until edited.
      await expect(page.getByLabel("Slug")).toHaveValue(e2e.organization.slug);
      await expect(page.getByLabel("Code")).toHaveValue(e2e.organization.code);
      await page.getByRole("button", { name: "Complete Setup" }).click();

      await expect(
        page.getByRole("heading", { name: "Setup complete" })
      ).toBeVisible();
      await expect(page.getByText(e2e.admin.email)).toBeVisible();
      await page.getByRole("button", { name: "Sign in to Tereo" }).click();
    }

    await signIn(page, e2e.admin.email, e2e.admin.password);
    // The first section the admin can see.
    await expect(page).toHaveURL(/\/auth-admin\/dashboard$/);
    await page.context().storageState({ path: e2e.adminStatePath });
  }
);

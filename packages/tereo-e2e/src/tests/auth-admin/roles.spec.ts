import { expect, test } from "../../fixtures/index.js";

test("an admin creates a custom role", async ({ page, uid }) => {
  const name = uid("ui_role").replace(/-/g, "_");
  const displayName = `UI Role ${name}`;

  await page.goto("/auth-admin/roles");
  await page.getByRole("button", { name: "Add new" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByLabel("Display Name").fill(displayName);
  await dialog.getByLabel("Description").fill("Made by the e2e suite");
  await dialog.getByRole("button", { name: "Create Role" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toContainText(displayName);
  await row.click();
  await expect(page.getByRole("heading", { name: displayName })).toBeVisible();
  await expect(page.getByText(`Role: ${name}`)).toBeVisible();
});

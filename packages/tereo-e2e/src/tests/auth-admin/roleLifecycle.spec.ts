import type { CoreApi } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";
import type { Page } from "@playwright/test";

async function customRole(
  api: CoreApi,
  uid: (prefix: string) => string,
  permissions: string[] = []
) {
  const role = await api.createRole({
    name: uid("life").replace(/-/g, "_"),
    displayName: `Lifecycle ${uid("r")}`,
  });
  if (permissions.length) {
    await api.setRolePermissions(role.id, permissions);
  }
  return role;
}

/** The roles list, searched by name, and that role's row in it. */
async function roleRow(page: Page, name: string) {
  await page.goto("/auth-admin/roles");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  return page.getByRole("row", { name: new RegExp(name) });
}

async function confirm(page: Page, title: string, button: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(title, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: button, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("an admin edits a role, then duplicates it with its permissions", async ({
  page,
  api,
  uid,
}) => {
  const role = await customRole(api, uid, ["webhooks.read"]);
  const renamed = `Renamed ${uid("r")}`;

  await page.goto(`/auth-admin/roles/${role.id}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Display Name").fill(renamed);
  await dialog.getByLabel("Description").fill("Edited by the e2e suite");
  await dialog.getByRole("button", { name: "Update Role" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();
  const main = page.getByRole("main");
  await expect(main.getByText("Edited by the e2e suite")).toBeVisible();

  const copyName = uid("copy").replace(/-/g, "_");
  const copyDisplayName = `Copy ${uid("r")}`;
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill(copyName);
  await dialog.getByLabel("Display Name").fill(copyDisplayName);
  await dialog.getByRole("button", { name: "Duplicate Role" }).click();
  await expect(dialog).toBeHidden();

  // The copy opens, a new role with the original's permissions.
  await expect(
    page.getByRole("heading", { name: copyDisplayName })
  ).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(role.id));
  await expect(page.getByText(`Role: ${copyName}`)).toBeVisible();
  await expect(main.getByText("Permissions (1)")).toBeVisible();
  await expect(main.getByText("Webhooks - Read")).toBeVisible();
});

test("an admin deactivates and archives a role, then restores it", async ({
  page,
  api,
  uid,
}) => {
  const role = await customRole(api, uid);
  const main = page.getByRole("main");

  await page.goto(`/auth-admin/roles/${role.id}`);
  // Archive appears only once the role is inactive.
  await expect(
    page.getByRole("button", { name: "Archive", exact: true })
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Status" }).selectOption("false");
  await dialog.getByRole("button", { name: "Update Role" }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByText("Inactive", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await confirm(page, "Archive Role", "Archive");
  await expect(main.getByText("Archived", { exact: true })).toBeVisible();

  // Archived roles leave the list, but keep their page. The search also
  // finds an active role, so the list has loaded once that row shows.
  const active = await api.createRole({
    name: `${role.name}_active`,
    displayName: `Active ${uid("r")}`,
  });
  await roleRow(page, role.name);
  await expect(
    page.getByRole("row", { name: new RegExp(active.name) })
  ).toBeVisible();
  const archivedRow = new RegExp(`${role.name}(?!_active)`);
  await expect(page.getByRole("row", { name: archivedRow })).toHaveCount(0);

  await page.goto(`/auth-admin/roles/${role.id}`);
  await expect(main.getByText("Archived", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit", exact: true })
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await confirm(page, "Restore Role", "Restore");
  await expect(main.getByText("Archived", { exact: true })).toHaveCount(0);
  await expect(main.getByText("Inactive", { exact: true })).toBeVisible();

  await roleRow(page, role.name);
  await expect(page.getByRole("row", { name: archivedRow })).toBeVisible();
});

test("archiving a role from its page returns to the roles list", async ({
  page,
  api,
  uid,
}) => {
  const role = await customRole(api, uid);
  await api.request.patch(`admin/roles/${role.id}`, {
    data: { isActive: false },
  });

  await page.goto(`/auth-admin/roles/${role.id}`);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await confirm(page, "Archive Role", "Archive");
  await expect(page).toHaveURL(/\/auth-admin\/roles$/);
});

test("an admin deletes a role", async ({ page, api, uid }) => {
  const role = await customRole(api, uid);

  await page.goto(`/auth-admin/roles/${role.id}`);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await confirm(page, "Delete Role", "Delete");
  await expect(page).toHaveURL(/\/auth-admin\/roles$/);

  const response = await api.request.get(`admin/roles/${role.id}`);
  expect(response.status()).toBe(404);
  await roleRow(page, role.name);
  await expect(
    page.getByRole("row", { name: new RegExp(role.name) })
  ).toHaveCount(0);
});

test("an admin removes a user from a role on the role's page", async ({
  page,
  api,
  uid,
}) => {
  const role = await customRole(api, uid);
  const user = await api.createUser({ email: `${uid("holder")}@e2e.test` });
  await api.setUserRoles(user.id, [role.id]);

  await page.goto(`/auth-admin/roles/${role.id}`);
  const main = page.getByRole("main");
  await expect(main.getByText("Users with this Role (1)")).toBeVisible();
  const row = main.getByRole("row").filter({ hasText: user.email });
  await row.getByRole("button", { name: "Remove" }).click();
  await confirm(page, "Remove User from Role", "Remove");

  await expect(main.getByText("Users with this Role (0)")).toBeVisible();
  await expect(main.getByText("No users assigned to this role")).toBeVisible();

  await page.goto(`/auth-admin/users/${user.id}`);
  await expect(page.getByText("No roles assigned")).toBeVisible();
});

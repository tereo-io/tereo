import { expect, test } from "../../fixtures/index.js";
import { orgCode } from "../../fixtures/coreApi.js";

test("an admin creates an organization and edits it", async ({ page, uid }) => {
  const name = uid("org");
  const code = orgCode();

  await page.goto("/auth-admin/organizations");
  await page.getByRole("button", { name: "Add new" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  // The slug follows the name until it is edited.
  await expect(dialog.getByRole("textbox", { name: "Slug" })).toHaveValue(name);
  await dialog.getByRole("textbox", { name: "Code" }).fill(code);
  await dialog.getByRole("button", { name: "Create Organization" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toContainText("Active");
  await row.click();

  await expect(page.getByRole("heading", { name })).toBeVisible();
  const main = page.getByRole("main");
  await expect(main.getByText(code, { exact: true })).toBeVisible();
  await expect(page.getByText("No members in this organization")).toBeVisible();

  const renamed = `${name}-renamed`;
  await page.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog");
  // The code is fixed once the organization exists.
  await expect(edit.getByRole("textbox", { name: "Code" })).toBeDisabled();
  await edit.getByRole("textbox", { name: "Name" }).fill(renamed);
  await edit.getByRole("textbox", { name: "Slug" }).fill(renamed);
  await edit.getByRole("button", { name: "Update Organization" }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();
  await expect(main.getByText(renamed, { exact: true }).first()).toBeVisible();
});

test("an admin adds a member, changes their role and removes them", async ({
  page,
  api,
  uid,
}) => {
  const org = await api.createOrganization(uid("org-members"));
  const user = await api.createUser({ email: `${uid("member")}@e2e.test` });

  await page.goto(`/auth-admin/organizations/${org.id}`);
  await page.getByRole("button", { name: "Add Member" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: /^User/ }).fill(user.email);
  // The options open in a listbox outside the dialog.
  await page.getByRole("option", { name: user.email }).click();
  await dialog.getByRole("combobox", { name: "Role" }).selectOption("admin");
  await dialog.getByRole("button", { name: "Add Member" }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByRole("row", { name: new RegExp(user.email) });
  await expect(row).toContainText("Admin");
  await expect(page.getByText("Members (1)")).toBeVisible();

  await row.getByRole("button", { name: "Change role" }).click();
  const change = page.getByRole("dialog");
  await change.getByRole("combobox", { name: "Role" }).selectOption("owner");
  await change.getByRole("button", { name: "Update Role" }).click();
  await expect(change).toBeHidden();
  await expect(row).toContainText("Owner");

  // An organization keeps at least one owner while it has members.
  await row.getByRole("button", { name: "Remove" }).click();
  const confirm = page.getByRole("dialog");
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(
    page.getByText("An organization must keep at least one owner")
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(row).toBeVisible();

  const successor = await api.createUser({
    email: `${uid("successor")}@e2e.test`,
  });
  await api.addOrganizationMember(org.id, successor.id, "owner");
  await page.reload();
  await expect(page.getByText("Members (2)")).toBeVisible();

  await row.getByRole("button", { name: "Remove" }).click();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(confirm).toBeHidden();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("Members (1)")).toBeVisible();
});

test("an organization is deactivated, archived and restored from its page", async ({
  page,
  api,
  uid,
}) => {
  const org = await api.createOrganization(uid("org-archive"));
  await page.goto(`/auth-admin/organizations/${org.id}`);
  const archive = page.getByRole("button", { name: "Archive" });
  // Only an inactive organization can be archived.
  await expect(page.getByRole("heading", { name: org.name })).toBeVisible();
  await expect(archive).toHaveCount(0);

  await page.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog");
  await edit.getByRole("combobox", { name: "Status" }).selectOption("false");
  await edit.getByRole("button", { name: "Update Organization" }).click();
  await expect(edit).toBeHidden();

  await archive.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Archive" })
    .click();
  const main = page.getByRole("main");
  await expect(main.getByText("Archived", { exact: true })).toBeVisible();
  // Archived organizations are read-only.
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add Member" })).toHaveCount(0);

  await page.goto("/auth-admin/organizations");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(org.name);
  await expect(page.getByText("No results found")).toBeVisible();

  await page.goto(`/auth-admin/organizations/${org.id}`);
  await page.getByRole("button", { name: "Restore" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Restore" })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(main.getByText("Archived", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
});

test("archiving an organization from its page returns to the list", async ({
  page,
  api,
  uid,
}) => {
  const org = await api.createOrganization(uid("org-archive-nav"));
  await api.deactivateOrganization(org.id);

  await page.goto(`/auth-admin/organizations/${org.id}`);
  await page.getByRole("button", { name: "Archive" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(page).toHaveURL(/\/auth-admin\/organizations$/);
});

test("an inactive organization is archived and restored from the list", async ({
  page,
  api,
  uid,
}) => {
  const org = await api.createOrganization(uid("org-list"));
  await api.deactivateOrganization(org.id);

  await page.goto("/auth-admin/organizations");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(org.name);
  const row = page.getByRole("row", { name: new RegExp(org.name) });
  await expect(row).toContainText("Inactive");
  await row.getByRole("button", { name: "Archive" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(row).toHaveCount(0);

  await page.getByRole("button", { name: "Archived" }).click();
  await page.getByRole("checkbox", { name: "Include archived" }).check();
  await page.keyboard.press("Escape");
  await expect(row).toContainText("Archived");
  await row.getByRole("button", { name: "Restore" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Restore" })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(row).not.toContainText("Archived");
  await expect(row.getByRole("button", { name: "Archive" })).toBeVisible();
});

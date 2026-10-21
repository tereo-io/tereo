import { signedInPage, signedOutPage } from "../../utils/signIn.js";
import { signIn, startSignIn } from "../../utils/signIn.js";
import { enableTwoFactor } from "../../utils/twoFactor.js";
import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";

test("an admin creates a user, who can then sign in", async ({
  page,
  browser,
  uid,
}) => {
  const email = `${uid("created")}@e2e.test`;

  await page.goto("/auth-admin/users");
  await page.getByRole("button", { name: "Add new" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Name").fill("Created In UI");
  await dialog
    .getByRole("textbox", { name: "Password", exact: true })
    .fill(TEST_PASSWORD);
  await dialog.getByRole("button", { name: "Create User" }).click();
  await expect(dialog).toBeHidden();

  // The list's own search finds the new user.
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  const row = page.getByRole("row", { name: new RegExp(email) });
  await expect(row).toContainText("Created In UI");
  await expect(row).toContainText("Active");
  await row.click();
  await expect(page.getByRole("heading", { name: email })).toBeVisible();

  const userPage = await signedInPage(browser, email, TEST_PASSWORD);
  await expect(
    userPage.getByRole("heading", { name: "My Account" })
  ).toBeVisible();
  await userPage.context().close();
});

test("an admin assigns a role to a user and removes it", async ({
  page,
  api,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("roles")}@e2e.test` });
  const role = await api.createRole({
    name: uid("role").replace(/-/g, "_"),
    displayName: `Role ${uid("r")}`,
  });

  await page.goto(`/auth-admin/users/${user.id}`);
  const main = page.getByRole("main");
  await expect(page.getByText("No roles assigned")).toBeVisible();

  await page.getByRole("button", { name: "Manage Roles" }).click();
  await page
    .getByRole("dialog")
    .getByRole("checkbox", { name: role.displayName })
    .check();
  await page.getByRole("button", { name: "Save Roles" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(main.getByText(role.displayName)).toBeVisible();

  await page.getByRole("button", { name: "Manage Roles" }).click();
  const checkbox = page
    .getByRole("dialog")
    .getByRole("checkbox", { name: role.displayName });
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await page.getByRole("button", { name: "Save Roles" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("No roles assigned")).toBeVisible();
});

test("a deactivated user can no longer sign in", async ({
  page,
  browser,
  api,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("deactivate")}@e2e.test` });

  await page.goto(`/auth-admin/users/${user.id}`);
  await page.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Status" }).selectOption("false");
  await dialog.getByRole("button", { name: "Update User" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("main").getByText("Inactive", { exact: true })
  ).toBeVisible();

  // And so does the list.
  await page.goto("/auth-admin/users");
  await page.getByRole("textbox", { name: "Email" }).fill(user.email);
  await expect(
    page.getByRole("row", { name: new RegExp(user.email) })
  ).toContainText("Inactive");

  const userPage = await signedOutPage(browser);
  await startSignIn(userPage);
  await userPage.getByLabel("Email").fill(user.email);
  await userPage
    .getByRole("textbox", { name: "Password", exact: true })
    .fill(TEST_PASSWORD);
  await userPage.getByRole("button", { name: "Sign In" }).click();
  await expect(userPage.getByRole("alert")).toBeVisible();
  await expect(userPage).toHaveURL(/\/login\?/);
  await userPage.context().close();
});

test("an admin resets a user's 2FA, who then signs in with a password", async ({
  page,
  browser,
  api,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("reset-2fa")}@e2e.test` });
  const userPage = await signedInPage(browser, user.email, TEST_PASSWORD);
  await enableTwoFactor(userPage);
  await userPage.context().close();

  await page.goto(`/auth-admin/users/${user.id}`);
  const reset = page.getByRole("button", { name: "Reset two-factor" });
  await reset.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Reset two-factor" })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(reset).toHaveCount(0);

  const again = await signedOutPage(browser);
  await startSignIn(again);
  await signIn(again, user.email, TEST_PASSWORD);
  await expect(
    again.getByRole("heading", { name: "My Account" })
  ).toBeVisible();
  await expect(
    again.getByRole("main").getByText("Not Enabled", { exact: true })
  ).toBeVisible();
  await again.context().close();
});

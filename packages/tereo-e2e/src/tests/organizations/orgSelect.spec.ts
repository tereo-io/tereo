import { signedOutPage, startSignIn } from "../../utils/signIn.js";
import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";

test("a role granted within an organization applies only there, and a member of two picks one at sign-in", async ({
  page,
  browser,
  api,
  uid,
}) => {
  // webhooks.read is org-assignable, and gates the Webhooks section.
  const role = await api.createRole({
    name: uid("org_webhooks").replace(/-/g, "_"),
    displayName: `Org Webhooks ${uid("r")}`,
  });
  await api.setRolePermissions(role.id, ["webhooks.read"]);
  const plain = await api.createOrganization(uid("org-plain"));
  const granted = await api.createOrganization(uid("org-granted"));
  const user = await api.createUser({ email: `${uid("two-orgs")}@e2e.test` });
  await api.addOrganizationMember(plain.id, user.id);
  await api.addOrganizationMember(granted.id, user.id);

  // The admin grants the role within one organization only.
  await page.goto(`/auth-admin/organizations/${granted.id}`);
  const row = page.getByRole("row", { name: new RegExp(user.email) });
  await row.getByRole("button", { name: "Organization roles" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: role.displayName }).check();
  await dialog.getByRole("button", { name: "Save Roles" }).click();
  await expect(dialog).toBeHidden();
  await row.getByRole("button", { name: "Organization roles" }).click();
  await expect(
    dialog.getByRole("checkbox", { name: role.displayName })
  ).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const userPage = await signedOutPage(browser);
  await startSignIn(userPage);
  await userPage.getByLabel("Email").fill(user.email);
  await userPage
    .getByRole("textbox", { name: "Password", exact: true })
    .fill(TEST_PASSWORD);
  await userPage.getByRole("button", { name: "Sign In" }).click();

  await expect(userPage).toHaveURL(/\/login\/org-select/);
  await expect(
    userPage.getByText("Select an organization to continue")
  ).toBeVisible();
  await expect(
    userPage.getByRole("button", { name: new RegExp(plain.name) })
  ).toBeVisible();
  await userPage
    .getByRole("button", { name: new RegExp(granted.name) })
    .click();

  const nav = userPage.getByRole("banner").getByRole("navigation");
  const webhooks = nav.getByRole("link", { name: "Webhooks" });
  await expect(webhooks).toBeVisible();
  await userPage.getByRole("button", { name: "User menu" }).click();
  const organization = userPage.getByRole("combobox", {
    name: "Organization",
  });
  await expect(organization).toHaveValue(granted.id);

  // Switching signs in again for the other organization, where the role
  // does not apply.
  await organization.selectOption(plain.id);
  await userPage.waitForURL(/\/callback/);
  await userPage.waitForURL((url) => url.pathname !== "/callback");
  await expect(
    userPage.getByRole("button", { name: "User menu" })
  ).toBeVisible();
  await expect(webhooks).toHaveCount(0);
  await userPage.getByRole("button", { name: "User menu" }).click();
  await expect(organization).toHaveValue(plain.id);

  await userPage.context().close();
});

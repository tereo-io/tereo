import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import type { CoreApi } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";
import { signedInPage } from "../../utils/signIn.js";
import type { Page } from "@playwright/test";

const topNav = (page: Page) => page.getByRole("banner").getByRole("navigation");

/** A user holding one new role with exactly the named permissions. */
async function userWithPermissions(
  api: CoreApi,
  uid: (prefix: string) => string,
  permissions: string[]
) {
  const role = await api.createRole({
    name: uid("scoped").replace(/-/g, "_"),
    displayName: `Scoped ${uid("r")}`,
  });
  await api.setRolePermissions(role.id, permissions);
  const user = await api.createUser({ email: `${uid("scoped")}@e2e.test` });
  await api.setUserRoles(user.id, [role.id]);
  return { role, user };
}

test("a user sees only the sections their role grants, and no others by URL", async ({
  browser,
  api,
  uid,
}) => {
  const { user } = await userWithPermissions(api, uid, ["webhooks.read"]);
  const page = await signedInPage(browser, user.email, TEST_PASSWORD);

  const nav = topNav(page);
  await expect(nav.getByRole("link", { name: "Webhooks" })).toBeVisible();
  for (const hidden of [
    "Auth Admin",
    "File Storage",
    "Notifications",
    "Audit Log",
    "Services",
    "Integrations",
  ]) {
    await expect(nav.getByRole("link", { name: hidden })).toHaveCount(0);
  }

  await nav.getByRole("link", { name: "Webhooks" }).click();
  await expect(page).toHaveURL(/\/webhooks/);

  // A page the role doesn't grant sends the user to their account instead.
  for (const path of [
    "/auth-admin/users",
    "/auth-admin/roles",
    "/notifications/log",
    "/services",
    "/integrations",
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/account$/);
    await expect(
      page.getByRole("heading", { name: "My Account" })
    ).toBeVisible();
  }

  await page.context().close();
});

test("File Storage and Audit Log send a user without access to their account", async ({
  browser,
  api,
  uid,
}) => {
  const { user } = await userWithPermissions(api, uid, ["webhooks.read"]);
  const page = await signedInPage(browser, user.email, TEST_PASSWORD);
  for (const path of ["/file-storage/buckets", "/audit-log/entries"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/account$/);
  }
  await page.context().close();
});

test("an admin's change to a role reaches its holder live, without a reload", async ({
  page,
  browser,
  api,
  uid,
}) => {
  const { role, user } = await userWithPermissions(api, uid, ["webhooks.read"]);
  const userPage = await signedInPage(browser, user.email, TEST_PASSWORD);
  const nav = topNav(userPage);
  await expect(nav.getByRole("link", { name: "Webhooks" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Notifications" })).toHaveCount(0);

  // A reload would show any change; this marker survives only without one,
  // so what follows must come from the socket's push.
  await userPage.evaluate(() => {
    (globalThis as unknown as { e2eNoReload: boolean }).e2eNoReload = true;
  });

  const togglePermission = async (displayName: string) => {
    await page.getByRole("button", { name: "Manage Permissions" }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("checkbox", { name: displayName, exact: true })
      .click();
    await dialog.getByRole("button", { name: "Save Permissions" }).click();
    await expect(dialog).toBeHidden();
  };

  await page.goto(`/auth-admin/roles/${role.id}`);
  await togglePermission("Notifications - Read");
  await expect(
    page.getByRole("main").getByText("Notifications - Read")
  ).toBeVisible();

  await expect(nav.getByRole("link", { name: "Notifications" })).toBeVisible();
  await nav.getByRole("link", { name: "Notifications" }).click();
  await expect(userPage).toHaveURL(/\/notifications\/log/);

  // Taking it away again closes the page the user is on.
  await togglePermission("Notifications - Read");
  await expect(nav.getByRole("link", { name: "Notifications" })).toHaveCount(0);
  await expect(userPage).toHaveURL(/\/account$/);
  expect(
    await userPage.evaluate(
      () => (globalThis as unknown as { e2eNoReload?: boolean }).e2eNoReload
    )
  ).toBe(true);

  await userPage.context().close();
});

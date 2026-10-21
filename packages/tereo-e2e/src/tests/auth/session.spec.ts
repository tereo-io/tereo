import { signIn, signedInPage, startSignIn } from "../../utils/signIn.js";
import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";
import { signedOutPage } from "../../utils/signIn.js";
import { e2e } from "../../config.js";

// Every case here signs in a user of its own in a fresh context: signing the
// shared admin out would end the session every other spec runs on.
test.use({ storageState: { cookies: [], origins: [] } });

test("a signed-out visitor is sent to sign in", async ({ page }) => {
  await page.goto("/auth-admin/users");
  await expect(page.getByText("Sign in to get started.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in to Tereo" })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Auth Admin" })).toHaveCount(0);
});

test("a wrong password is refused on the login page", async ({
  page,
  api,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("wrong-pw")}@e2e.test` });

  await startSignIn(page);
  await page.getByLabel("Email").fill(user.email);
  await page
    .getByRole("textbox", { name: "Password", exact: true })
    .fill("Not-the-Passw0rd!");
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login\?/);
});

test("a user without admin permissions lands on their account", async ({
  page,
  api,
  uid,
}) => {
  const user = await api.createUser({
    email: `${uid("plain")}@e2e.test`,
    name: "Plain User",
  });

  await startSignIn(page);
  await signIn(page, user.email, TEST_PASSWORD);

  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "My Account" })).toBeVisible();
  await expect(
    page.getByRole("main").getByText(user.email).first()
  ).toBeVisible();
  // No section is offered to a user who can read none of them.
  await expect(page.getByRole("link", { name: "Auth Admin" })).toHaveCount(0);
});

test("signing out ends the session", async ({ browser, api, uid }) => {
  const user = await api.createUser({ email: `${uid("signout")}@e2e.test` });
  const page = await signedInPage(browser, user.email, TEST_PASSWORD);
  await expect(page.getByRole("heading", { name: "My Account" })).toBeVisible();

  await page.getByRole("button", { name: "User menu" }).click();
  await page.getByRole("button", { name: "Sign Out" }).click();

  await expect(page.getByText("Sign in to get started.")).toBeVisible();
  // Neither a reload nor a fresh sign-in finds the old session.
  await page.goto("/account");
  await expect(page.getByText("Sign in to get started.")).toBeVisible();
  await page.getByRole("button", { name: "Sign in to Tereo" }).click();
  await expect(page).toHaveURL(/\/login\?/);
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();

  await page.context().close();
});

test("the session survives a reload", async ({ browser, api, uid }) => {
  const user = await api.createUser({ email: `${uid("reload")}@e2e.test` });
  const page = await signedInPage(browser, user.email, TEST_PASSWORD);
  await expect(page.getByRole("heading", { name: "My Account" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "My Account" })).toBeVisible();
  await expect(page.getByText("Sign in to get started.")).toHaveCount(0);

  await page.context().close();
});

test("an admin revoking a user's sessions signs that user out", async ({
  browser,
  api,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("revoked")}@e2e.test` });
  const userPage = await signedInPage(browser, user.email, TEST_PASSWORD);
  await expect(
    userPage.getByRole("heading", { name: "My Account" })
  ).toBeVisible();

  // This file's contexts start signed out; the admin needs the saved state.
  const admin = await signedOutPage(browser, {
    storageState: e2e.adminStatePath,
  });
  await admin.goto(`/auth-admin/users/${user.id}`);
  await expect(admin.getByRole("heading", { name: user.email })).toBeVisible();
  await admin.getByRole("button", { name: "Revoke All" }).click();
  await admin
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke All" })
    .click();
  await expect(admin.getByText("No active sessions")).toBeVisible();

  // Core pushes the revocation over the socket; the user's tab signs out
  // without waiting for its access token to expire.
  await expect(userPage.getByText("Sign in to get started.")).toBeVisible({
    timeout: 20_000,
  });

  await admin.context().close();
  await userPage.context().close();
});

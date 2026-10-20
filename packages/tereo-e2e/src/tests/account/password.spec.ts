import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";
import type { Page } from "@playwright/test";
import {
  signedInPage,
  signedOutPage,
  startSignIn,
} from "../../utils/signIn.js";

const NEW_PASSWORD = "E2e-Changed-Passw0rd!";

async function fillChangePassword(
  page: Page,
  current: string,
  next: string,
  confirm = next
) {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Current Password").fill(current);
  await dialog.getByLabel("New Password", { exact: true }).fill(next);
  await dialog.getByLabel("Confirm New Password").fill(confirm);
  await dialog.getByRole("button", { name: "Change Password" }).click();
}

/** Submits core's login page; the caller asserts where it lands. */
async function submitSignIn(page: Page, email: string, password: string) {
  await startSignIn(page);
  await page.getByLabel("Email").fill(email);
  await page
    .getByRole("textbox", { name: "Password", exact: true })
    .fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
}

test("a user changes their password: the old one stops working and other sessions end", async ({
  browser,
  api,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("password")}@e2e.test` });
  const page = await signedInPage(browser, user.email, TEST_PASSWORD);
  const other = await signedInPage(browser, user.email, TEST_PASSWORD);
  await expect(
    other.getByRole("heading", { name: "My Account" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Change Password" }).click();
  await fillChangePassword(page, TEST_PASSWORD, NEW_PASSWORD);
  await expect(page.getByRole("dialog")).toBeHidden();

  // Core ends every other session, and pushes that to the other tab.
  await expect(other.getByText("Sign in to get started.")).toBeVisible({
    timeout: 20_000,
  });
  // This one is kept.
  await page.reload();
  await expect(page.getByRole("heading", { name: "My Account" })).toBeVisible();

  const stale = await signedOutPage(browser);
  await submitSignIn(stale, user.email, TEST_PASSWORD);
  await expect(stale.getByRole("alert")).toBeVisible();
  await expect(stale).toHaveURL(/\/login\?/);

  const fresh = await signedOutPage(browser);
  await submitSignIn(fresh, user.email, NEW_PASSWORD);
  await expect(
    fresh.getByRole("heading", { name: "My Account" })
  ).toBeVisible();

  for (const p of [page, other, stale, fresh]) await p.context().close();
});

test("a password change is refused for a wrong current password, a weak new one or a mismatch", async ({
  browser,
  api,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("pw-refused")}@e2e.test` });
  const page = await signedInPage(browser, user.email, TEST_PASSWORD);
  await page.getByRole("button", { name: "Change Password" }).click();
  const dialog = page.getByRole("dialog");

  await fillChangePassword(page, "Not-The-Passw0rd!", NEW_PASSWORD);
  await expect(dialog.getByText("Current password is incorrect")).toBeVisible();

  // Long enough for the UI's own check, but without the special character
  // core's rules require.
  await fillChangePassword(page, TEST_PASSWORD, "NoSpecialChars123");
  await expect(
    dialog.getByText("Password must contain at least one special character")
  ).toBeVisible();

  await fillChangePassword(
    page,
    TEST_PASSWORD,
    NEW_PASSWORD,
    "E2e-Other-Passw0rd!"
  );
  await expect(dialog.getByText("Passwords do not match")).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await page.context().close();

  // Nothing changed: the original password still signs in.
  const again = await signedInPage(browser, user.email, TEST_PASSWORD);
  await expect(
    again.getByRole("heading", { name: "My Account" })
  ).toBeVisible();
  await again.context().close();
});

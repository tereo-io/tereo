import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";
import { signedInPage } from "../../utils/signIn.js";
import type { Page } from "@playwright/test";

const signedOut = (page: Page) =>
  // Core pushes the revocation over the socket; the tab signs out without
  // waiting for its access token to expire.
  expect(page.getByText("Sign in to get started.")).toBeVisible({
    timeout: 20_000,
  });

/** The account page's session entries, which a reload brings up to date. */
const sessionItems = (page: Page) =>
  page
    .getByRole("main")
    .getByRole("listitem")
    .filter({ has: page.getByText("Expires:") });

test("revoking another session signs that browser out", async ({
  browser,
  api,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("revoke-one")}@e2e.test` });
  const other = await signedInPage(browser, user.email, TEST_PASSWORD);
  const page = await signedInPage(browser, user.email, TEST_PASSWORD);

  const sessions = sessionItems(page);
  await expect(sessions).toHaveCount(2);
  const current = sessions.filter({ hasText: "Current" });
  await expect(current).toHaveCount(1);
  await expect(current.getByRole("button", { name: "Revoke" })).toHaveCount(0);

  await sessions
    .filter({ hasNotText: "Current" })
    .getByRole("button", { name: "Revoke" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(sessions).toHaveCount(1);

  await signedOut(other);
  await page.reload();
  await expect(page.getByRole("heading", { name: "My Account" })).toBeVisible();

  await page.context().close();
  await other.context().close();
});

test("revoking all other sessions keeps this one", async ({
  browser,
  api,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("revoke-all")}@e2e.test` });
  const others = [
    await signedInPage(browser, user.email, TEST_PASSWORD),
    await signedInPage(browser, user.email, TEST_PASSWORD),
  ];
  const page = await signedInPage(browser, user.email, TEST_PASSWORD);
  await expect(sessionItems(page)).toHaveCount(3);

  const revokeAll = page.getByRole("button", {
    name: "Revoke All Other Sessions",
  });
  await revokeAll.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("revoke 2 other session(s)")).toBeVisible();
  await dialog.getByRole("button", { name: "Revoke All" }).click();
  await expect(dialog).toBeHidden();

  for (const other of others) await signedOut(other);
  await expect(sessionItems(page)).toHaveCount(1);
  // With no other session, there is nothing left to revoke.
  await expect(revokeAll).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "My Account" })).toBeVisible();

  for (const p of [page, ...others]) await p.context().close();
});

test("revoking all sessions, the current one included, signs this browser out too", async ({
  browser,
  api,
  uid,
}) => {
  const user = await api.createUser({
    email: `${uid("revoke-self")}@e2e.test`,
  });
  const other = await signedInPage(browser, user.email, TEST_PASSWORD);
  const page = await signedInPage(browser, user.email, TEST_PASSWORD);

  await page.getByRole("button", { name: "Revoke All Other Sessions" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("checkbox", {
      name: "Also revoke current session (will log you out)",
    })
    .check();
  await dialog.getByRole("button", { name: "Revoke All" }).click();

  await signedOut(page);
  await signedOut(other);

  await page.context().close();
  await other.context().close();
});

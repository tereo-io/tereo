import { signedInPage, signIn, startSignIn } from "../../utils/signIn.js";
import { nextTotpStep, totpCode, totpStep } from "../../utils/totp.js";
import { enableTwoFactor, signOut } from "../../utils/twoFactor.js";
import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";

test(
  "a user enables 2FA, then signs in with a code",
  { tag: "@slow" },
  async ({ browser, api, uid }) => {
    // Up to one 30-second TOTP step is waited out below.
    test.setTimeout(120_000);
    const user = await api.createUser({ email: `${uid("totp")}@e2e.test` });

    // A fresh sign-in: core enrolls a factor only on a recent login.
    const page = await signedInPage(browser, user.email, TEST_PASSWORD);
    await expect(page).toHaveURL(/\/account$/);
    await page.getByRole("button", { name: "Enable 2FA" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Scan this code")).toBeVisible();
    // The QR code (qrcode.react) and the same secret as text.
    await expect(dialog.locator("svg").first()).toBeVisible();
    const secret = (await dialog.getByRole("code").textContent())!.trim();
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);

    const enrolledStep = totpStep();
    await dialog
      .getByLabel("Code from your app")
      .fill(totpCode(secret, enrolledStep));
    await dialog.getByRole("button", { name: "Verify and Enable" }).click();
    await dialog
      .getByRole("checkbox", { name: "I have saved my recovery codes" })
      .check();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    await expect(
      page.getByRole("main").getByText("Enabled", { exact: true })
    ).toBeVisible();

    await page.getByRole("button", { name: "User menu" }).click();
    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page.getByText("Sign in to get started.")).toBeVisible();

    await startSignIn(page);
    await page.getByLabel("Email").fill(user.email);
    await page
      .getByRole("textbox", { name: "Password", exact: true })
      .fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/login\/2fa/);
    await expect(
      page.getByRole("heading", { name: "Two-Factor Authentication" })
    ).toBeVisible();

    const step = await nextTotpStep(enrolledStep);
    await page.getByLabel("Verification Code").fill(totpCode(secret, step));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(
      page.getByRole("heading", { name: "My Account" })
    ).toBeVisible();

    await page.context().close();
  }
);

test("enabling 2FA shows the recovery codes once", async ({
  browser,
  api,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("codes")}@e2e.test` });
  const page = await signedInPage(browser, user.email, TEST_PASSWORD);
  await page.getByRole("button", { name: "Enable 2FA" }).click();
  const dialog = page.getByRole("dialog");
  const secret = (await dialog.getByRole("code").textContent())!.trim();
  await dialog.getByLabel("Code from your app").fill(totpCode(secret));
  await dialog.getByRole("button", { name: "Verify and Enable" }).click();

  await expect(
    dialog.getByText("These codes are shown only once")
  ).toBeVisible();
  const done = dialog.getByRole("button", { name: "Done" });
  await expect(done).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: "I have saved my recovery codes" })
    .check();
  await done.click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Regenerate Recovery Codes" })
  ).toBeVisible();

  await page.context().close();
});

test("a wrong 2FA code is refused", async ({ browser, api, uid }) => {
  const user = await api.createUser({ email: `${uid("totp-bad")}@e2e.test` });
  const page = await signedInPage(browser, user.email, TEST_PASSWORD);
  await page.getByRole("button", { name: "Enable 2FA" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("code")).toBeVisible();

  const secret = (await dialog.getByRole("code").textContent())!.trim();
  const wrong = String((Number(totpCode(secret)) + 1) % 1_000_000).padStart(
    6,
    "0"
  );
  await dialog.getByLabel("Code from your app").fill(wrong);
  await dialog.getByRole("button", { name: "Verify and Enable" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Enable 2FA" })).toBeVisible();

  await page.context().close();
});

test("the account page shows the user's details and roles", async ({
  browser,
  api,
  uid,
}) => {
  const user = await api.createUser({
    email: `${uid("account")}@e2e.test`,
    name: "Account Owner",
  });
  const role = await api.createRole({
    name: uid("acct_role").replace(/-/g, "_"),
    displayName: `Account Role ${uid("x")}`,
  });
  await api.setUserRoles(user.id, [role.id]);

  const page = await signedInPage(browser, user.email, TEST_PASSWORD);
  const main = page.getByRole("main");
  await expect(page.getByRole("heading", { name: "My Account" })).toBeVisible();
  await expect(main.getByText("Account Owner")).toBeVisible();
  await expect(main.getByText(role.displayName)).toBeVisible();
  // This sign-in is the session marked current.
  await expect(
    main.getByRole("listitem").filter({ hasText: "Current" })
  ).toHaveCount(1);

  await page.context().close();
});

test(
  "a user turns 2FA off, and signs in with a password alone",
  { tag: "@slow" },
  async ({ browser, api, uid }) => {
    // Up to one 30-second TOTP step is waited out below.
    test.setTimeout(120_000);
    const user = await api.createUser({ email: `${uid("totp-off")}@e2e.test` });
    const page = await signedInPage(browser, user.email, TEST_PASSWORD);
    const enrollment = await enableTwoFactor(page);

    await page.getByRole("button", { name: "Disable 2FA" }).click();
    const dialog = page.getByRole("dialog");
    // Core refuses the step that enabling 2FA claimed.
    const step = await nextTotpStep(enrollment.step);
    await dialog
      .getByLabel("Code from your authenticator app")
      .fill(totpCode(enrollment.secret, step));
    await dialog.getByRole("button", { name: "Disable 2FA" }).click();
    await expect(dialog).toBeHidden();
    const main = page.getByRole("main");
    await expect(main.getByText("Not Enabled", { exact: true })).toBeVisible();

    await signOut(page);
    await startSignIn(page);
    await signIn(page, user.email, TEST_PASSWORD);
    await expect(
      page.getByRole("heading", { name: "My Account" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Enable 2FA" })
    ).toBeVisible();

    await page.context().close();
  }
);

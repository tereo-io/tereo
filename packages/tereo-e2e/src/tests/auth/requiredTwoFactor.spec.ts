import { signedOutPage, startSignIn } from "../../utils/signIn.js";
import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";
import { totpCode } from "../../utils/totp.js";
import {
  readRecoveryCodes,
  submitRecoveryCode,
} from "../../utils/twoFactor.js";

// A role requiring 2FA, not the `required` policy: the policy would hold every
// other spec's users, and the admin, to it.
test("a role that requires 2FA has the user set it up at sign-in", async ({
  browser,
  api,
  uid,
}) => {
  const role = await api.createRole({
    name: uid("needs_2fa").replace(/-/g, "_"),
    displayName: `Needs 2FA ${uid("r")}`,
    requires2fa: true,
  });
  const user = await api.createUser({ email: `${uid("forced")}@e2e.test` });
  await api.setUserRoles(user.id, [role.id]);

  const page = await signedOutPage(browser);
  const signInWithPassword = async () => {
    await page.getByLabel("Email").fill(user.email);
    await page
      .getByRole("textbox", { name: "Password", exact: true })
      .fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
  };
  await startSignIn(page);
  await signInWithPassword();

  await expect(
    page.getByRole("heading", { name: "Set Up Two-Factor Authentication" })
  ).toBeVisible();
  const secret = (await page.getByRole("code").textContent())!.trim();
  await page
    .getByRole("button", { name: "I've scanned the code - Continue" })
    .click();
  await page.getByLabel("Verification Code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();

  await expect(
    page.getByRole("heading", { name: "Save Your Recovery Codes" })
  ).toBeVisible();
  const recoveryCodes = await readRecoveryCodes(page);
  const proceed = page.getByRole("button", { name: "Continue to Login" });
  await expect(proceed).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "I have saved my recovery codes in a secure location",
    })
    .check();
  await proceed.click();

  // Enrolling ended the password-only login; it starts over, now with 2FA.
  await expect(page).toHaveURL(/\/login\?/);
  await signInWithPassword();
  await expect(
    page.getByRole("heading", { name: "Two-Factor Authentication" })
  ).toBeVisible();
  await submitRecoveryCode(page, recoveryCodes[0]);
  await expect(page.getByRole("heading", { name: "My Account" })).toBeVisible();

  // Required, so the user cannot turn it off.
  const main = page.getByRole("main");
  await expect(main.getByText("Enabled", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Regenerate Recovery Codes" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Disable 2FA" })).toHaveCount(
    0
  );

  await page.context().close();
});

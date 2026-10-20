import { nextTotpStep, totpCode } from "../../utils/totp.js";
import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";
import { signedInPage } from "../../utils/signIn.js";
import {
  enableTwoFactor,
  readRecoveryCodes,
  signOut,
  startTwoFactorSignIn,
  submitRecoveryCode,
} from "../../utils/twoFactor.js";

test(
  "a recovery code signs in once, and only once",
  { tag: "@slow" },
  async ({ browser, api, uid }) => {
    const user = await api.createUser({ email: `${uid("recovery")}@e2e.test` });
    const page = await signedInPage(browser, user.email, TEST_PASSWORD);
    const { recoveryCodes } = await enableTwoFactor(page);
    const total = recoveryCodes.length;
    const main = page.getByRole("main");
    await expect(main.getByText(`${total} remaining`)).toBeVisible();

    await signOut(page);
    await startTwoFactorSignIn(page, user.email, TEST_PASSWORD);
    await submitRecoveryCode(page, recoveryCodes[0]);
    await expect(
      page.getByRole("heading", { name: "My Account" })
    ).toBeVisible();
    await expect(main.getByText(`${total - 1} remaining`)).toBeVisible();

    await signOut(page);
    await startTwoFactorSignIn(page, user.email, TEST_PASSWORD);
    await submitRecoveryCode(page, recoveryCodes[0]);
    await expect(
      page.getByText("Invalid recovery code. Please try again.")
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login\/2fa\/recovery/);

    await submitRecoveryCode(page, recoveryCodes[1]);
    await expect(
      page.getByRole("heading", { name: "My Account" })
    ).toBeVisible();
    await expect(main.getByText(`${total - 2} remaining`)).toBeVisible();

    await page.context().close();
  }
);

test(
  "regenerating recovery codes replaces the old ones",
  { tag: "@slow" },
  async ({ browser, api, uid }) => {
    // Up to one 30-second TOTP step is waited out below.
    test.setTimeout(120_000);
    const user = await api.createUser({ email: `${uid("regen")}@e2e.test` });
    const page = await signedInPage(browser, user.email, TEST_PASSWORD);
    const enrollment = await enableTwoFactor(page);

    await page
      .getByRole("button", { name: "Regenerate Recovery Codes" })
      .click();
    const dialog = page.getByRole("dialog");
    // Core refuses the step that enabling 2FA claimed.
    const step = await nextTotpStep(enrollment.step);
    await dialog
      .getByLabel("Authenticator Code")
      .fill(totpCode(enrollment.secret, step));
    await dialog.getByRole("button", { name: "Generate New Codes" }).click();
    const newCodes = await readRecoveryCodes(dialog);
    expect(newCodes).not.toContain(enrollment.recoveryCodes[0]);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    await signOut(page);
    await startTwoFactorSignIn(page, user.email, TEST_PASSWORD);
    await submitRecoveryCode(page, enrollment.recoveryCodes[0]);
    await expect(
      page.getByText("Invalid recovery code. Please try again.")
    ).toBeVisible();

    await submitRecoveryCode(page, newCodes[0]);
    await expect(
      page.getByRole("heading", { name: "My Account" })
    ).toBeVisible();

    await page.context().close();
  }
);

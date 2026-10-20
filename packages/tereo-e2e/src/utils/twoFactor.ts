import type { Locator, Page } from "@playwright/test";
import { totpCode, totpStep } from "./totp.js";
import { expect } from "@playwright/test";
import { startSignIn } from "./signIn.js";

export interface Enrollment {
  secret: string;
  /** The TOTP step verification claimed; core refuses it, or earlier, again. */
  step: number;
  recoveryCodes: string[];
}

/** The one-time codes a RecoveryCodeGrid inside `container` shows. */
export async function readRecoveryCodes(
  container: Page | Locator
): Promise<string[]> {
  const codes = container.getByRole("listitem").getByRole("code");
  await expect(codes.first()).toBeVisible();
  return (await codes.allTextContents()).map((code) => code.trim());
}

/**
 * Enables 2FA from the account page the signed-in user is on, saves the
 * recovery codes and closes the dialog.
 */
export async function enableTwoFactor(page: Page): Promise<Enrollment> {
  await page.getByRole("button", { name: "Enable 2FA" }).click();
  const dialog = page.getByRole("dialog");
  const secret = (await dialog.getByRole("code").textContent())!.trim();
  const step = totpStep();
  await dialog.getByLabel("Code from your app").fill(totpCode(secret, step));
  await dialog.getByRole("button", { name: "Verify and Enable" }).click();

  const recoveryCodes = await readRecoveryCodes(dialog);
  await dialog
    .getByRole("checkbox", { name: "I have saved my recovery codes" })
    .check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  return { secret, step, recoveryCodes };
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: "User menu" }).click();
  await page.getByRole("button", { name: "Sign Out" }).click();
  await expect(page.getByText("Sign in to get started.")).toBeVisible();
}

/** Signs in with a password, up to the second factor core then asks for. */
export async function startTwoFactorSignIn(
  page: Page,
  email: string,
  password: string
) {
  await startSignIn(page);
  await page.getByLabel("Email").fill(email);
  await page
    .getByRole("textbox", { name: "Password", exact: true })
    .fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(
    page.getByRole("heading", { name: "Two-Factor Authentication" })
  ).toBeVisible();
}

/** Submits a recovery code from the 2FA challenge or the recovery page. */
export async function submitRecoveryCode(page: Page, code: string) {
  if (!/\/login\/2fa\/recovery/.test(page.url())) {
    await page
      .getByRole("link", { name: "Use a recovery code instead" })
      .click();
  }
  await page.getByLabel("Recovery Code").fill(code);
  await page.getByRole("button", { name: "Use Recovery Code" }).click();
}

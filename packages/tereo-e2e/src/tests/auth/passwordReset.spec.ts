import { signedOutPage, startSignIn } from "../../utils/signIn.js";
import { expect, test } from "../../fixtures/index.js";
import { linkIn } from "../../fixtures/mail.js";

const NEW_PASSWORD = "E2e-Reset-Passw0rd!";

test("forgot password → email → new password → back to sign-in", async ({
  browser,
  api,
  mail,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("reset")}@e2e.test` });
  const page = await signedOutPage(browser);
  await startSignIn(page);
  await expect(page).toHaveURL(/\/login\?.*client_id=/);

  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password\?.*client_id=/);
  // The URL changes before the lazy page renders; until it does, "Email"
  // is still the sign-in page's field.
  await expect(
    page.getByRole("heading", { name: "Reset your password" })
  ).toBeVisible();
  await page.getByLabel("Email").fill(user.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(
    page.getByText("If an account exists for that address, we've sent a link.")
  ).toBeVisible();

  const message = await mail.waitForMessage(user.email, {
    subject: "Reset your password",
  });
  await page.goto(linkIn(message));

  await expect(
    page.getByRole("heading", { name: "Reset your password" })
  ).toBeVisible();
  await page.getByLabel("New password").fill(NEW_PASSWORD);
  await page.getByLabel("Confirm password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Your password is set.")).toBeVisible();

  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login\?.*client_id=/);
  await page.getByLabel("Email").fill(user.email);
  await page
    .getByRole("textbox", { name: "Password", exact: true })
    .fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByRole("heading", { name: "My Account" })).toBeVisible();

  await page.context().close();
});

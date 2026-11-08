import { signedInPage, signedOutPage } from "../../utils/signIn.js";
import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";
import { linkIn } from "../../fixtures/mail.js";

const SUBJECT = "Confirm your email address";

test("unverified user resends and confirms", async ({
  browser,
  api,
  mail,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("verify-old")}@e2e.test` });
  const email = `${uid("verify")}@e2e.test`;
  await api.changeUserEmail(user.id, email);
  // The change itself sent the first link; the user asks for another.
  await mail.waitForMessage(email, { subject: SUBJECT });
  const sent = mail.count(email, SUBJECT);

  const page = await signedInPage(browser, email, TEST_PASSWORD);
  await expect(
    page.getByText("Your email address isn't confirmed.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Resend" }).click();

  const message = await mail.waitForMessage(email, {
    subject: SUBJECT,
    after: sent,
  });
  const verify = await signedOutPage(browser);
  await verify.goto(linkIn(message));
  await expect(verify.getByText(email)).toBeVisible();
  await verify.getByRole("button", { name: "Confirm my email" }).click();
  await expect(
    verify.getByText("Your email address is confirmed.")
  ).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "My Account" })).toBeVisible();
  await expect(
    page.getByText("Your email address isn't confirmed.")
  ).toBeHidden();

  await verify.context().close();
  await page.context().close();
});

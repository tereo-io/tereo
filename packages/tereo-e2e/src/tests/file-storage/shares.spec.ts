import { expect, test } from "../../fixtures/index.js";
import { signedOutPage } from "../../utils/signIn.js";

test("a password-protected share link: unlock, download, revoke", async ({
  page,
  browser,
  api,
  uid,
}) => {
  const bucket = uid("shares");
  await api.createBucket(bucket);
  await api.uploadObject(bucket, "contract.txt", "signed contract");
  const password = "Share-Passw0rd!";

  await page.goto(`/file-storage/buckets/${bucket}`);
  await page.getByRole("button", { name: "Share contract.txt" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Password (optional)").fill(password);
  await dialog.getByRole("button", { name: "Create Share" }).click();
  const url = await dialog.getByLabel("Share URL").inputValue();
  expect(url).toMatch(/^http/);
  await expect(
    dialog.getByText("This share is password-protected.")
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();

  // The recipient has no account: a fresh, signed-out browser.
  const visitor = await signedOutPage(browser);
  await visitor.goto(url);
  await expect(
    visitor.getByRole("heading", { name: "Enter password" })
  ).toBeVisible();
  const passwordBox = visitor.getByRole("textbox", { name: "Password" });
  await passwordBox.fill("wrong-password");
  await visitor.getByRole("button", { name: "Unlock" }).click();
  // A wrong password only clears the field; the page says nothing more.
  await expect(passwordBox).toHaveValue("");
  await expect(
    visitor.getByRole("heading", { name: "Enter password" })
  ).toBeVisible();

  await passwordBox.fill(password);
  const download = visitor.waitForEvent("download");
  await visitor.getByRole("button", { name: "Unlock" }).click();
  expect((await download).suggestedFilename()).toBe("contract.txt");

  // The bucket's Shares tab lists it, and revoking ends the link.
  await page.getByRole("button", { name: "Shares", exact: true }).click();
  const shares = page.getByRole("region", { name: "Shares" });
  const row = shares.getByRole("row", { name: /contract\.txt/ });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Revoke share" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Revoke/ })
    .click();
  await expect(row).toContainText(/Revoked/i);

  // Core answers a revoked token itself, with its uniform 404, rather than
  // sending the browser on to the unlock page.
  const response = await visitor.goto(url);
  expect(response?.status()).toBe(404);
  await visitor.context().close();
});

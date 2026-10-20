import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";
import { signedInPage } from "../../utils/signIn.js";

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

test("a user uploads a profile photo, then removes it", async ({
  browser,
  api,
  uid,
}) => {
  const user = await api.createUser({ email: `${uid("photo")}@e2e.test` });
  const page = await signedInPage(browser, user.email, TEST_PASSWORD);
  const main = page.getByRole("main");
  const photo = main.getByRole("img", { name: "Profile" });
  await expect(photo).toHaveCount(0);

  await main.getByRole("button", { name: "Upload Photo" }).click();
  const dialog = page.getByRole("dialog");
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Upload File" }).click();
  await (
    await chooser
  ).setFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(dialog).toBeHidden();

  // The image loads from core's presigned URL, so the stored object is real.
  await expect(photo).toBeVisible();
  await expect
    .poll(() =>
      photo.evaluate(
        (img) => (img as unknown as { naturalWidth: number }).naturalWidth
      )
    )
    .toBe(1);
  await expect(
    main.getByRole("button", { name: "Change Photo", exact: true })
  ).toBeVisible();

  await page.reload();
  await expect(photo).toBeVisible();

  await main.getByRole("button", { name: "Remove" }).click();
  await expect(photo).toHaveCount(0);
  await expect(
    main.getByRole("button", { name: "Upload Photo" })
  ).toBeVisible();

  await page.context().close();
});

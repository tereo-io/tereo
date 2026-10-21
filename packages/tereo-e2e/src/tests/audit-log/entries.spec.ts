import { signIn, signedOutPage, startSignIn } from "../../utils/signIn.js";
import { expect, test } from "../../fixtures/index.js";
import { nextClientIp } from "../../utils/clientIp.js";
import type { Page } from "@playwright/test";
import { e2e } from "../../config.js";

const entries = (page: Page) => page.getByRole("region", { name: "Audit Log" });

// The log lists the admin's current organization's entries; a bucket belongs
// to one, so its creation shows up without choosing an organization.
test("an admin's change appears in the audit log, with its details", async ({
  page,
  api,
  uid,
}) => {
  const bucket = uid("audited");
  await api.createBucket(bucket, "Audited bucket");

  await page.goto("/audit-log/entries");
  await page.getByRole("textbox", { name: "Entity Name" }).fill(bucket);
  // Creating a bucket also grants its creator a permission on it, a second
  // entry under the same name.
  const row = entries(page).getByRole("row", {
    name: new RegExp(`CREATE tereo bucket ${bucket} `),
  });
  await expect(row).toContainText("E2E Admin");
  await expect(row).toContainText("E2E Org");

  await row.click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText(bucket);
  await expect(detail).toContainText("admin@e2e.test");
});

test("a sign-in is audited with the client's address", async ({
  page,
  browser,
}) => {
  // The admin signs in again from an address of its own, a session apart
  // from the one the other specs share.
  const ip = nextClientIp();
  const elsewhere = await signedOutPage(browser, { ip });
  await startSignIn(elsewhere);
  await signIn(elsewhere, e2e.admin.email, e2e.admin.password);
  await elsewhere.context().close();

  await page.goto("/audit-log/entries");
  await page.getByRole("textbox", { name: "IP Address" }).fill(ip);
  const login = entries(page).getByRole("row", { name: /LOGIN/ });
  await expect(login).toHaveCount(1);
  await expect(login).toContainText("admin@e2e.test");
});

import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";
import { signedInPage } from "../../utils/signIn.js";
import type { Page } from "@playwright/test";

const objectRow = (page: Page, name: string) =>
  page
    .getByRole("region", { name: "Objects" })
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name, exact: true }) });

test("an admin grants a member read access to a bucket, then revokes it", async ({
  page,
  browser,
  api,
  uid,
}) => {
  const bucket = uid("granted");
  await api.createBucket(bucket);
  await api.uploadObject(bucket, "report.txt", "quarterly numbers");

  // Object access takes both a role's permission and a grant on the bucket,
  // which goes only to a member of the bucket's organization (the admin's).
  const role = await api.createRole({
    name: uid("reader").replace(/-/g, "_"),
    displayName: `Reader ${uid("r")}`,
  });
  await api.setRolePermissions(role.id, [
    "file-service.buckets.read",
    "file-service.objects.read",
  ]);
  const user = await api.createUser({ email: `${uid("reader")}@e2e.test` });
  await api.setUserRoles(user.id, [role.id]);
  await api.addOrganizationMember(await api.defaultOrganizationId(), user.id);

  const userPage = await signedInPage(browser, user.email, TEST_PASSWORD);
  await userPage.goto(`/file-storage/buckets/${bucket}`);
  await expect(
    userPage.getByRole("main").getByText("Bucket not found")
  ).toBeVisible();

  await page.goto(`/file-storage/buckets/${bucket}`);
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await page.getByRole("button", { name: "Add new" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(`Grant Permission on ${bucket}`, { exact: true })
  ).toBeVisible();
  await dialog.getByRole("combobox", { name: /^Member of/ }).fill(user.email);
  // The options open in a listbox outside the dialog.
  await page.getByRole("option", { name: new RegExp(user.email) }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "Can Read" })
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Can Write" })
  ).not.toBeChecked();
  await dialog.getByRole("button", { name: "Grant", exact: true }).click();
  await expect(dialog).toBeHidden();
  const grantRow = page
    .getByRole("main")
    .getByRole("row")
    .filter({ hasText: user.email });
  await expect(grantRow).toBeVisible();

  // Read-only: the user sees the object, and no way to upload.
  await userPage.reload();
  await expect(objectRow(userPage, "report.txt")).toBeVisible();
  await expect(
    userPage.getByRole("button", { name: "Upload Files" })
  ).toHaveCount(0);

  await grantRow.getByRole("button", { name: "Revoke" }).click();
  await expect(
    dialog.getByText("Revoke Permission", { exact: true })
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(grantRow).toHaveCount(0);

  await userPage.reload();
  await expect(
    userPage.getByRole("main").getByText("Bucket not found")
  ).toBeVisible();

  await userPage.context().close();
});

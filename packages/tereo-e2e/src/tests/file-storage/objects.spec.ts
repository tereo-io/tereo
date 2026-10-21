import { expect, test } from "../../fixtures/index.js";
import type { Page } from "@playwright/test";

const objectRow = (page: Page, name: string) =>
  page
    .getByRole("region", { name: "Objects" })
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name, exact: true }) });

async function uploadFiles(
  page: Page,
  files: { name: string; content: string }[]
) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload Files" }).click();
  await (
    await chooser
  ).setFiles(
    files.map((f) => ({
      name: f.name,
      mimeType: "text/plain",
      buffer: Buffer.from(f.content),
    }))
  );
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(`Selected Files (${files.length})`)
  ).toBeVisible();
  await dialog
    .getByRole("button", {
      name: files.length > 1 ? `Upload ${files.length} files` : "Upload",
      exact: true,
    })
    .click();
  await expect(dialog).toBeHidden();
}

test("an admin creates a bucket and opens it", async ({ page, uid }) => {
  const name = uid("ui-bucket");

  await page.goto("/file-storage/buckets");
  await page.getByRole("button", { name: "Add new" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Bucket Name").fill(name);
  await dialog.getByLabel("Description").fill("Made by the e2e suite");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();

  // Creating opens the new, empty bucket.
  await expect(page).toHaveURL(new RegExp(`/file-storage/buckets/${name}`));
  await expect(page.getByText("This folder is empty.")).toBeVisible();

  await page.getByRole("link", { name: "Buckets" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toContainText("Made by the e2e suite");
  await expect(row).toContainText("private");
});

test("upload files, browse folders and search", async ({ page, api, uid }) => {
  const bucket = uid("browse");
  await api.createBucket(bucket);
  await api.uploadObject(bucket, "reports/2026/q3.txt", "quarterly");

  await page.goto(`/file-storage/buckets/${bucket}`);
  await uploadFiles(page, [
    { name: "alpha.txt", content: "first" },
    { name: "beta.txt", content: "second file" },
  ]);
  await expect(objectRow(page, "alpha.txt")).toContainText("5 B");
  await expect(objectRow(page, "beta.txt")).toContainText("11 B");
  await expect(objectRow(page, "reports")).toContainText("Folder");

  // Into the folder the API seeded, and back out through the breadcrumb.
  await page.getByRole("button", { name: "reports", exact: true }).click();
  await page.getByRole("button", { name: "2026", exact: true }).click();
  await expect(objectRow(page, "q3.txt")).toContainText("text/plain");
  await expect(
    page.getByRole("navigation", { name: "breadcrumb" })
  ).toContainText("2026");
  await page
    .getByRole("navigation", { name: "breadcrumb" })
    .getByRole("link", { name: "root" })
    .click();
  await expect(objectRow(page, "alpha.txt")).toBeVisible();

  await page.getByRole("button", { name: "Search" }).click();
  const search = page.getByRole("dialog");
  await search.getByRole("textbox").fill("q3");
  await expect(
    search.getByRole("region", { name: "Results" }).getByRole("row", {
      name: /q3\.txt/,
    })
  ).toBeVisible();
  await expect(
    search.getByRole("region", { name: "Results" }).getByRole("row", {
      name: /alpha\.txt/,
    })
  ).toHaveCount(0);
});

test("versions: overwrite, then restore the earlier version", async ({
  page,
  api,
  uid,
}) => {
  const bucket = uid("versions");
  await api.createBucket(bucket);
  await api.uploadObject(bucket, "notes.txt", "v1");

  // Versioning is turned on through the bucket's details.
  await page.goto(`/file-storage/buckets/${bucket}?tab=details`);
  await page.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog");
  await edit.getByRole("checkbox", { name: "Versioning enabled" }).check();
  await edit.getByRole("button", { name: /Save|Update/ }).click();
  await expect(edit).toBeHidden();

  await page.getByRole("button", { name: "Objects", exact: true }).click();
  await uploadFiles(page, [{ name: "notes.txt", content: "version two" }]);
  await expect(objectRow(page, "notes.txt")).toContainText("11 B");

  await objectRow(page, "notes.txt")
    .getByRole("button", { name: "Versions" })
    .click();
  const versions = page.getByRole("dialog");
  const version = (size: string) =>
    versions
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: size, exact: true }) });
  await expect(version("11 B")).toContainText("current");
  await expect(version("2 B")).not.toContainText("current");

  // Restoring makes the first upload current again.
  await version("2 B").getByRole("button", { name: "Restore" }).click();
  await expect(version("2 B")).toContainText("current");
  await expect(
    version("11 B").getByRole("button", { name: "Restore" })
  ).toBeVisible();
  await versions.getByRole("button", { name: "Close" }).click();
  await expect(objectRow(page, "notes.txt")).toContainText("2 B");
});

test("delete an object and restore it from the deleted view", async ({
  page,
  api,
  uid,
}) => {
  const bucket = uid("restore");
  await api.createBucket(bucket);
  await api.updateBucket(bucket, { versioningEnabled: true });
  await api.uploadObject(bucket, "keep.txt", "keep");
  await api.uploadObject(bucket, "doomed.txt", "doomed");

  await page.goto(`/file-storage/buckets/${bucket}`);
  await objectRow(page, "doomed.txt")
    .getByRole("button", { name: "Delete" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(objectRow(page, "doomed.txt")).toHaveCount(0);
  await expect(objectRow(page, "keep.txt")).toBeVisible();

  await page.getByRole("checkbox", { name: "Show deleted" }).check();
  const deleted = page.getByRole("region", { name: "Deleted objects" });
  const row = deleted.getByRole("row", { name: /doomed\.txt/ });
  await expect(row).toBeVisible();
  await row
    .getByRole("button", { name: "Versions — restore one to undelete" })
    .click();
  const versions = page.getByRole("dialog");
  await versions.getByRole("button", { name: "Restore" }).click();
  await expect(versions.getByRole("cell", { name: "current" })).toBeVisible();
  await versions.getByRole("button", { name: "Close" }).click();

  await page.getByRole("checkbox", { name: "Show deleted" }).uncheck();
  await expect(objectRow(page, "doomed.txt")).toBeVisible();
});

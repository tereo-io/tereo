import { expect, test } from "../../fixtures/index.js";
import {
  clientCredentialsGrant,
  createService,
  readCredentials,
} from "../../utils/clientCredentials.js";

test("an admin adds a service, whose credentials are shown once", async ({
  page,
  request,
  uid,
}) => {
  const slug = uid("svc");
  const name = `Service ${slug}`;

  await page.goto("/services/list");
  await page.getByRole("button", { name: "Add new" }).click();
  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await form.getByRole("textbox", { name: "Slug", exact: true }).fill(slug);
  await form.getByRole("button", { name: "Add Service" }).click();

  const shown = page.getByRole("dialog");
  await expect(shown.getByText("Copy the secret now")).toBeVisible();
  const credentials = await readCredentials(shown);
  expect((await clientCredentialsGrant(request, credentials)).status()).toBe(
    200
  );
  await shown
    .getByRole("button", { name: "I have saved these credentials" })
    .click();

  // Saving the credentials opens the new service.
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  const main = page.getByRole("main");
  await expect(main.getByText("Active", { exact: true })).toBeVisible();
  await expect(main.getByText(credentials.clientId)).toBeVisible();
  await expect(page.getByText(credentials.clientSecret)).toHaveCount(0);

  await page.goto("/services/list");
  await page.getByRole("textbox", { name: "Slug", exact: true }).fill(slug);
  await expect(page.getByRole("row", { name: new RegExp(slug) })).toContainText(
    name
  );
});

test("an admin renames a service", async ({ page, api, uid }) => {
  const slug = uid("svc-rename");
  const service = await createService(api.request, {
    name: `Service ${slug}`,
    slug,
  });
  const renamed = `Renamed ${slug}`;

  await page.goto(`/services/${service.id}`);
  await page.getByRole("button", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill(renamed);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  await expect(
    page.getByRole("heading", { name: renamed, level: 1 })
  ).toBeVisible();
  // The slug stays as it was.
  await expect(page.getByRole("main").getByText(slug).first()).toBeVisible();
});

test("a regenerated service secret overlaps the old one until the overlap is ended", async ({
  page,
  api,
  request,
  uid,
}) => {
  const slug = uid("svc-regen");
  const service = await createService(api.request, {
    name: `Service ${slug}`,
    slug,
  });
  const old = service.credentials;

  await page.goto(`/services/${service.id}`);
  await page.getByRole("button", { name: "Regenerate Secret" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("keeps working for");
  await dialog.getByRole("button", { name: "Regenerate", exact: true }).click();
  // The confirmation closes as the new secret opens; kosmeo's dialogs have no
  // name, so pick this one by its text.
  const shown = page
    .getByRole("dialog")
    .filter({ hasText: "The previous secret keeps working until" });
  const fresh = await readCredentials(shown);
  expect(fresh.clientSecret).not.toBe(old.clientSecret);
  await shown
    .getByRole("button", { name: "I have saved these credentials" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Both secrets work during the overlap.
  await expect(page.getByText("Two secrets work right now")).toBeVisible();
  expect((await clientCredentialsGrant(request, old)).status()).toBe(200);
  expect((await clientCredentialsGrant(request, fresh)).status()).toBe(200);

  await page.getByRole("button", { name: "End Overlap Now" }).click();
  const confirm = page.getByRole("dialog");
  await confirm.getByRole("button", { name: "End Overlap" }).click();
  await expect(page.getByText("Two secrets work right now")).toBeHidden();

  expect((await clientCredentialsGrant(request, old)).status()).toBe(401);
  expect((await clientCredentialsGrant(request, fresh)).status()).toBe(200);
});

test("a deactivated service cannot get tokens until it is reactivated", async ({
  page,
  api,
  request,
  uid,
}) => {
  const slug = uid("svc-active");
  const service = await createService(api.request, {
    name: `Service ${slug}`,
    slug,
  });
  const credentials = service.credentials;
  expect((await clientCredentialsGrant(request, credentials)).status()).toBe(
    200
  );

  await page.goto(`/services/${service.id}`);
  const main = page.getByRole("main");
  await page.getByRole("button", { name: "Deactivate" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Deactivate ${service.name}?`);
  await dialog.getByRole("button", { name: "Deactivate" }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByText("Inactive", { exact: true })).toBeVisible();
  await expect(main.getByText("This service is deactivated")).toBeVisible();
  expect(
    (await clientCredentialsGrant(request, credentials)).status()
  ).not.toBe(200);

  await page.getByRole("button", { name: "Reactivate" }).click();
  await expect(main.getByText("Active", { exact: true })).toBeVisible();
  await expect(main.getByText("This service is deactivated")).toBeHidden();
  expect((await clientCredentialsGrant(request, credentials)).status()).toBe(
    200
  );
});

import { expect, test } from "../../fixtures/index.js";
import {
  clientCredentialsGrant,
  createIntegration,
  createService,
  readCredentials,
} from "../../utils/clientCredentials.js";

test("an admin adds an integration, whose credentials are shown once", async ({
  page,
  request,
  uid,
}) => {
  const slug = uid("int");
  const name = `Integration ${slug}`;

  await page.goto("/integrations/list");
  await page.getByRole("button", { name: "Add new" }).click();
  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await form.getByRole("textbox", { name: "Slug", exact: true }).fill(slug);
  await form.getByRole("button", { name: "Add Integration" }).click();

  const shown = page.getByRole("dialog");
  await expect(shown.getByText("Copy the secret now")).toBeVisible();
  const credentials = await readCredentials(shown);
  expect((await clientCredentialsGrant(request, credentials)).status()).toBe(
    200
  );
  await shown
    .getByRole("button", { name: "I have saved these credentials" })
    .click();

  // Saving the credentials opens the new integration.
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  const main = page.getByRole("main");
  await expect(main.getByText("Platform (no organization)")).toBeVisible();
  await expect(main.getByText(credentials.clientId)).toBeVisible();
  await expect(page.getByText(credentials.clientSecret)).toHaveCount(0);

  await page.goto("/integrations/list");
  await page.getByRole("textbox", { name: "Slug", exact: true }).fill(slug);
  await expect(page.getByRole("row", { name: new RegExp(slug) })).toContainText(
    name
  );
});

test("an admin renames an integration", async ({ page, api, uid }) => {
  const slug = uid("int-rename");
  const integration = await createIntegration(api.request, {
    name: `Integration ${slug}`,
    slug,
  });
  const renamed = `Renamed ${slug}`;

  await page.goto(`/integrations/${integration.id}`);
  await page.getByRole("button", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill(renamed);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: renamed, level: 1 })
  ).toBeVisible();
});

test("a regenerated integration secret overlaps the old one until the overlap is ended", async ({
  page,
  api,
  request,
  uid,
}) => {
  const slug = uid("int-regen");
  const integration = await createIntegration(api.request, {
    name: `Integration ${slug}`,
    slug,
  });
  const old = integration.credentials;

  await page.goto(`/integrations/${integration.id}`);
  await page.getByRole("button", { name: "Regenerate Secret" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Regenerate", exact: true })
    .click();
  const shown = page
    .getByRole("dialog")
    .filter({ hasText: "I have saved these credentials" });
  const fresh = await readCredentials(shown);
  expect(fresh.clientSecret).not.toBe(old.clientSecret);
  await shown
    .getByRole("button", { name: "I have saved these credentials" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect(page.getByText("Two secrets work right now")).toBeVisible();
  expect((await clientCredentialsGrant(request, old)).status()).toBe(200);
  expect((await clientCredentialsGrant(request, fresh)).status()).toBe(200);

  await page.getByRole("button", { name: "End Overlap Now" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "End Overlap" })
    .click();
  await expect(page.getByText("Two secrets work right now")).toBeHidden();

  expect((await clientCredentialsGrant(request, old)).status()).toBe(401);
  expect((await clientCredentialsGrant(request, fresh)).status()).toBe(200);
});

test("a deactivated integration cannot get tokens until it is reactivated", async ({
  page,
  api,
  request,
  uid,
}) => {
  const slug = uid("int-active");
  const integration = await createIntegration(api.request, {
    name: `Integration ${slug}`,
    slug,
  });
  const credentials = integration.credentials;

  await page.goto(`/integrations/${integration.id}`);
  const main = page.getByRole("main");
  await page.getByRole("button", { name: "Deactivate" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Deactivate ${integration.name}?`);
  await dialog.getByRole("button", { name: "Deactivate" }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByText("Inactive", { exact: true })).toBeVisible();
  await expect(main.getByText("This integration is deactivated")).toBeVisible();
  expect(
    (await clientCredentialsGrant(request, credentials)).status()
  ).not.toBe(200);

  await page.getByRole("button", { name: "Reactivate" }).click();
  await expect(main.getByText("Active", { exact: true })).toBeVisible();
  expect((await clientCredentialsGrant(request, credentials)).status()).toBe(
    200
  );
});

test("an admin sets an integration's roles and audiences", async ({
  page,
  api,
  uid,
}) => {
  const slug = uid("int-access");
  const integration = await createIntegration(api.request, {
    name: `Integration ${slug}`,
    slug,
  });
  const role = await api.createRole({
    name: uid("int_role").replace(/-/g, "_"),
    displayName: `Integration Role ${uid("r")}`,
  });
  const serviceSlug = uid("aud");
  const service = await createService(api.request, {
    name: `Audience ${serviceSlug}`,
    slug: serviceSlug,
  });

  await page.goto(`/integrations/${integration.id}`);
  const main = page.getByRole("main");
  await expect(main.getByText("No roles")).toBeVisible();
  await expect(main.getByText("No audiences")).toBeVisible();

  await page.getByRole("button", { name: "Edit Roles" }).click();
  let dialog = page.getByRole("dialog");
  // A platform integration's roles are global, and the dialog says so.
  await expect(dialog.getByText("Global roles", { exact: true })).toBeVisible();
  await dialog.getByRole("checkbox", { name: role.displayName }).check();
  await dialog.getByRole("button", { name: "Save Roles" }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByText(role.displayName)).toBeVisible();

  await page.getByRole("button", { name: "Edit Audiences" }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("checkbox", { name: `${service.name} (${service.slug})` })
    .check();
  await dialog.getByRole("button", { name: "Save Audiences" }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByText(service.slug, { exact: true })).toBeVisible();

  // And taking the role away again.
  await page.getByRole("button", { name: "Edit Roles" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: role.displayName }).uncheck();
  await dialog.getByRole("button", { name: "Save Roles" }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByText("No roles")).toBeVisible();
});

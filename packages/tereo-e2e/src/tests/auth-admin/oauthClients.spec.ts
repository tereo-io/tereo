import { expect, test } from "../../fixtures/index.js";
import {
  createLoginClient,
  loginClientSecretWorks,
  readCredentials,
} from "../../utils/clientCredentials.js";

// `.invalid` never resolves (RFC 2606): a redirect there leaves no machine.
const appUrl = (id: string) => `https://${id}.e2e.invalid/callback`;

test("an admin creates an OAuth client, whose secret is shown once", async ({
  page,
  request,
  uid,
}) => {
  const name = `Client ${uid("create")}`;
  const redirectUri = appUrl(uid("app"));

  await page.goto("/auth-admin/oauth-clients");
  await page.getByRole("button", { name: "Add new" }).click();
  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await form.getByLabel("Redirect URIs", { exact: true }).fill(redirectUri);
  await form.getByLabel("Scopes").fill("openid profile email");
  await form.getByRole("button", { name: "Create Client" }).click();

  const shown = page.getByRole("dialog");
  await expect(
    shown.getByText("The client secret will not be shown again.")
  ).toBeVisible();
  const credentials = await readCredentials(shown);
  await shown
    .getByRole("button", { name: "I have saved these credentials" })
    .click();
  await expect(shown).toBeHidden();
  expect(await loginClientSecretWorks(request, credentials, redirectUri)).toBe(
    true
  );

  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toContainText(credentials.clientId);
  await row.click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  const main = page.getByRole("main");
  await expect(main.getByText(credentials.clientId)).toBeVisible();
  await expect(main.getByText(redirectUri)).toBeVisible();
  // The detail page never shows the secret again.
  await expect(page.getByText(credentials.clientSecret)).toHaveCount(0);
});

test("an admin edits a client", async ({ page, api, uid }) => {
  const client = await createLoginClient(api.request, {
    name: `Client ${uid("edit")}`,
    redirectUris: [appUrl(uid("before"))],
  });
  const renamed = `Renamed ${uid("edit")}`;
  const redirectUri = appUrl(uid("after"));

  await page.goto(`/auth-admin/oauth-clients/${client.id}`);
  const main = page.getByRole("main");
  await expect(main.getByText("Asked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill(renamed);
  await dialog.getByLabel("Redirect URIs", { exact: true }).fill(redirectUri);
  await dialog
    .getByRole("checkbox", { name: "Ask users to approve this app" })
    .uncheck();
  await dialog.getByRole("button", { name: "Update Client" }).click();
  await expect(dialog).toBeHidden();

  await expect(
    page.getByRole("heading", { name: renamed, level: 1 })
  ).toBeVisible();
  await expect(main.getByText(redirectUri)).toBeVisible();
  await expect(main.getByText("Not asked", { exact: true })).toBeVisible();
});

test("regenerating a client's secret replaces the old one", async ({
  page,
  api,
  request,
  uid,
}) => {
  const redirectUri = appUrl(uid("regen"));
  const client = await createLoginClient(api.request, {
    name: `Client ${uid("regen")}`,
    redirectUris: [redirectUri],
  });
  const old = { clientId: client.clientId, clientSecret: client.clientSecret };
  expect(await loginClientSecretWorks(request, old, redirectUri)).toBe(true);

  await page.goto(`/auth-admin/oauth-clients/${client.id}`);
  await page.getByRole("button", { name: "Regenerate Secret" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("New Client Secret");
  const fresh = await readCredentials(dialog);
  expect(fresh.clientId).toBe(client.clientId);
  expect(fresh.clientSecret).not.toBe(client.clientSecret);
  await dialog
    .getByRole("button", { name: "I have saved these credentials" })
    .click();
  await expect(dialog).toBeHidden();

  expect(await loginClientSecretWorks(request, fresh, redirectUri)).toBe(true);
  expect(await loginClientSecretWorks(request, old, redirectUri)).toBe(false);
});

test("an admin deletes a client from its page", async ({ page, api, uid }) => {
  const client = await createLoginClient(api.request, {
    name: `Client ${uid("delete")}`,
    redirectUris: [appUrl(uid("delete"))],
  });

  await page.goto(`/auth-admin/oauth-clients/${client.id}`);
  await page.getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(client.name);
  await dialog.getByRole("button", { name: "Delete" }).click();

  await expect(page).toHaveURL(/\/auth-admin\/oauth-clients$/);
  expect((await api.request.get(`admin/clients/${client.id}`)).status()).toBe(
    404
  );
});

test("an admin deletes a client from the list", async ({ page, api, uid }) => {
  const client = await createLoginClient(api.request, {
    name: `Client ${uid("list-delete")}`,
    redirectUris: [appUrl(uid("list-delete"))],
  });

  await page.goto("/auth-admin/oauth-clients");
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill(client.name);
  const row = page.getByRole("row", { name: new RegExp(client.name) });
  await row.getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(client.name);
  await dialog.getByRole("button", { name: "Delete" }).click();

  await expect(row).toHaveCount(0);
  expect((await api.request.get(`admin/clients/${client.id}`)).status()).toBe(
    404
  );
});

import { expect, test } from "../../fixtures/index.js";

// `.invalid` never resolves (RFC 2606), so core accepts the endpoint without
// any DNS lookup and its deliveries fail without leaving the machine.
const hookUrl = (id: string) => `https://hooks.e2e.invalid/${id}`;

test("an admin creates a webhook endpoint for an event type", async ({
  page,
  uid,
}) => {
  const url = hookUrl(uid("create"));

  await page.goto("/webhooks/endpoints");
  await page.getByRole("button", { name: "Add new" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("URL").fill(url);
  await dialog.getByLabel("Description").fill("User sign-ups");
  await dialog.getByRole("combobox", { name: "Event Types" }).click();
  await dialog
    .getByRole("textbox", { name: "Search options" })
    .fill("auth.user.created");
  await dialog.getByRole("option", { name: "auth.user.created" }).click();
  await dialog.getByRole("button", { name: "Hide options" }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Event Types" })
  ).toContainText("auth.user.created");
  await dialog.getByRole("button", { name: "Create Endpoint" }).click();

  // The signing secret is shown once, before the endpoint is listed.
  await expect(dialog.getByRole("alert")).toContainText(
    "Save this signing secret now!"
  );
  await expect(dialog.getByText(url)).toBeVisible();
  await dialog
    .getByRole("button", { name: "I have saved the signing secret" })
    .click();

  await page.getByRole("textbox", { name: "URL" }).fill(url);
  const row = page.getByRole("row", { name: new RegExp(url) });
  await expect(row).toContainText("User sign-ups");
  await row.click();

  await expect(
    page.getByRole("heading", { name: "User sign-ups", level: 1 })
  ).toBeVisible();
  await expect(page.getByRole("main").getByText(url).first()).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: "auth.user.created" })
  ).toBeVisible();
});

test("an admin picks event types with the keyboard and keeps the form", async ({
  page,
  uid,
}) => {
  const url = hookUrl(uid("keyboard"));
  const description = `Keyboard ${uid("k")}`;

  await page.goto("/webhooks/endpoints");
  await page.getByRole("button", { name: "Add new" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Webhook Endpoint" });
  await dialog.getByLabel("URL").fill(url);
  await dialog.getByLabel("Description").fill(description);

  const eventTypes = dialog.getByRole("combobox", { name: "Event Types" });
  await eventTypes.click();
  const search = dialog.getByRole("textbox", { name: "Search options" });
  await expect(search).toBeFocused();
  await search.fill("auth.user.created");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  // Escape dismisses the open list; the dialog and what was typed stay.
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect(eventTypes).toContainText("auth.user.created");
  await expect(dialog.getByLabel("URL")).toHaveValue(url);
  await expect(dialog.getByLabel("Description")).toHaveValue(description);

  await dialog.getByRole("button", { name: "Create Endpoint" }).click();
  await page
    .getByRole("dialog", { name: "Webhook Endpoint Created" })
    .getByRole("button", { name: "I have saved the signing secret" })
    .click();

  await page.getByRole("textbox", { name: "URL" }).fill(url);
  const row = page.getByRole("row", { name: new RegExp(url) });
  await expect(row).toContainText(description);
  await row.click();
  await expect(
    page.getByRole("listitem").filter({ hasText: "auth.user.created" })
  ).toBeVisible();
});

test("deliveries: a test event and a real one are recorded", async ({
  page,
  api,
  uid,
}) => {
  const endpoint = await api.createWebhookEndpoint({
    url: hookUrl(uid("deliveries")),
    eventTypes: ["file-service.bucket.created"],
  });

  await page.goto(`/webhooks/endpoints/${endpoint.id}`);
  await page.getByRole("button", { name: "Send Test" }).click();
  await expect(page).toHaveURL(/tab=deliveries/);
  const deliveries = page.getByRole("region", { name: "Deliveries" });
  await expect(
    deliveries.getByRole("row", { name: /webhook\.test/ })
  ).toBeVisible();

  // A subscribed event in the endpoint's organization, emitted through
  // core's outbox, gets a delivery too.
  await api.createBucket(uid("hooked"));
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(
      deliveries.getByRole("row", { name: /file-service\.bucket\.created/ })
    ).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
});

test("the event types list core's declared events", async ({ page }) => {
  await page.goto("/webhooks/event-types");
  await page
    .getByRole("textbox", { name: "Event Type" })
    .fill("auth.user.created");
  const row = page.getByRole("row", { name: /^auth\.user\.created\b/ });
  await expect(row).toContainText("tereo");
  await expect(row).toContainText("Active");
});

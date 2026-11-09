import { expect, test } from "../../fixtures/index.js";

test("the API docs render core's spec", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByRole("link", { name: "API Docs" }).click();
  await expect(page).toHaveURL(/\/docs$/);

  // Redoc's own navigation, built from the bundled OpenAPI spec. Redoc
  // parses the whole spec in the browser, which takes over 20s on CI.
  await expect(
    page.getByRole("menuitem", { name: "Setup", exact: true })
  ).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("textbox", { name: "Search" }).fill("setup");
  await expect(page.getByRole("main")).toContainText(/setup/i);
});

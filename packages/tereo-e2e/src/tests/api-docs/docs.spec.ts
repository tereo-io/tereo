import { expect, test } from "../../fixtures/index.js";

test("the API docs render core's spec", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "API Docs" }).click();
  await expect(page).toHaveURL(/\/docs$/);

  // Redoc's own navigation, built from the bundled OpenAPI spec.
  await expect(page.getByRole("menuitem", { name: "Setup" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("textbox", { name: "Search" }).fill("setup");
  await expect(page.getByRole("main")).toContainText(/setup/i);
});

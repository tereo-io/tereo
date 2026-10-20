import type { Browser, Page } from "@playwright/test";
import { clientIpHeaders } from "./clientIp.js";
import { expect } from "@playwright/test";
import { e2e } from "../config.js";

/**
 * Completes core's login page, which the UI's PKCE flow has already
 * redirected to, and waits for the callback to land back in the app.
 */
export async function signIn(page: Page, email: string, password: string) {
  await expect(page).toHaveURL(/\/login\?/);
  await page.getByLabel("Email").fill(email);
  await page
    .getByRole("textbox", { name: "Password", exact: true })
    .fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL((url) => !/^\/(login|callback)/.test(url.pathname), {
    timeout: 20_000,
  });
}

/** The landing page a signed-out visitor gets, and its sign-in button. */
export async function startSignIn(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Sign in to get started.")).toBeVisible();
  await page.getByRole("button", { name: "Sign in to Tereo" }).click();
}

/**
 * A page in a new browser context, as a client of its own, with nothing
 * stored unless `storageState` is given. Inside a test, `browser.newContext()`
 * would otherwise inherit the project's storage state, the admin's.
 */
export async function signedOutPage(
  browser: Browser,
  options: { ip?: string; storageState?: string } = {}
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: e2e.baseURL,
    storageState: options.storageState ?? { cookies: [], origins: [] },
    extraHTTPHeaders: clientIpHeaders(options.ip),
  });
  return context.newPage();
}

/**
 * A signed-out page, signed in as the given user: their own session, which a
 * spec may end without touching the admin's.
 */
export async function signedInPage(
  browser: Browser,
  email: string,
  password: string
): Promise<Page> {
  const page = await signedOutPage(browser);
  await startSignIn(page);
  await signIn(page, email, password);
  return page;
}

import { clientIpHeaders } from "../utils/clientIp.js";
import { CoreApi } from "./coreApi.js";
import { e2e } from "../config.js";
import { readFileSync } from "fs";
import {
  test as base,
  request,
  type APIRequestContext,
} from "@playwright/test";

interface StorageState {
  origins: {
    origin: string;
    localStorage: { name: string; value: string }[];
  }[];
}

/** The admin's access token, from the storage state the setup project saved. */
const adminAccessToken = (): string => {
  const state = JSON.parse(
    readFileSync(e2e.adminStatePath, "utf-8")
  ) as StorageState;
  const tokens = state.origins
    .flatMap((o) => o.localStorage)
    .find((item) => item.name === "tereo_tokens");
  if (!tokens) throw new Error(`No tereo_tokens in ${e2e.adminStatePath}`);
  return (JSON.parse(tokens.value) as { access_token: string }).access_token;
};

let counter = 0;

interface Fixtures {
  /** Core's API as the signed-in admin, for data a spec is not about. */
  api: CoreApi;
  /** A name no other spec, worker or earlier run has used. */
  uid: (prefix: string) => string;
}

export const test = base.extend<Fixtures>({
  // Each test's browser context is its own client address (utils/clientIp.ts).
  // eslint-disable-next-line no-empty-pattern
  extraHTTPHeaders: async ({}, use) => {
    await use(clientIpHeaders());
  },
  // Playwright reads a fixture's dependencies from its destructuring.
  // eslint-disable-next-line no-empty-pattern
  api: async ({}, use) => {
    const context: APIRequestContext = await request.newContext({
      baseURL: `${e2e.baseURL}/v1/`,
      extraHTTPHeaders: { Authorization: `Bearer ${adminAccessToken()}` },
    });
    await use(new CoreApi(context));
    await context.dispose();
  },
  // eslint-disable-next-line no-empty-pattern
  uid: async ({}, use, testInfo) => {
    await use((prefix) =>
      [
        prefix,
        testInfo.workerIndex,
        Date.now().toString(36),
        (counter++).toString(36),
      ].join("-")
    );
  },
});

export { expect } from "@playwright/test";

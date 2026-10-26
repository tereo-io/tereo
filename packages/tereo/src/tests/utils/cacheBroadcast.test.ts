// @module-tag int
// @module-tag auth
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  broadcastIdentityProviderInvalidate,
  closeCacheBroadcast,
  onIdentityProviderInvalidate,
  startCacheSubscriber,
} from "../../utils/cacheBroadcast.js";

describe("broadcastIdentityProviderInvalidate", () => {
  afterAll(async () => {
    await closeCacheBroadcast();
  });

  it("reaches onIdentityProviderInvalidate listeners", async () => {
    await startCacheSubscriber();
    const id = randomUUID();
    const received = new Promise<string>((resolve) => {
      onIdentityProviderInvalidate((got) => {
        if (got === id) resolve(got);
      });
    });

    await broadcastIdentityProviderInvalidate(id);

    await expect(received).resolves.toBe(id);
  });
});

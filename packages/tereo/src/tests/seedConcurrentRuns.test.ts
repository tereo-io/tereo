import { DEFAULT_ORGANIZATION, LOGIN_CLIENT } from "../definitions/index.js";
import { ensureDefaultOrganization } from "../utils/defaultOrganization.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../utils/db/prisma.js";
import {
  seedDefaultClient,
  seedDefaultOrganization,
} from "../scripts/seed/bootstrapEntities.js";

// Two seeds (or core starts) at once on a fresh database both find no row and
// both insert it. Each case makes the existence check miss, as it would before
// the other run's insert committed, while that row is really there.
describe("bootstrap entities created by concurrent runs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("seedDefaultOrganization returns the default organization another run inserted", async () => {
    vi.spyOn(prisma.organization, "findUnique").mockResolvedValueOnce(null);

    await expect(seedDefaultOrganization()).resolves.toMatchObject({
      id: DEFAULT_ORGANIZATION.id,
    });
  });

  it("seedDefaultClient returns the login client another run inserted", async () => {
    vi.spyOn(prisma.oAuthClient, "findUnique").mockResolvedValueOnce(null);
    vi.spyOn(prisma.oAuthClient, "findFirst").mockResolvedValueOnce(null);

    await expect(seedDefaultClient()).resolves.toMatchObject({
      clientId: LOGIN_CLIENT.clientId,
    });
  });

  it("ensureDefaultOrganization returns the default organization another run inserted", async () => {
    vi.spyOn(prisma.organization, "findUnique").mockResolvedValueOnce(null);

    await expect(ensureDefaultOrganization()).resolves.toMatchObject({
      id: DEFAULT_ORGANIZATION.id,
    });
  });
});

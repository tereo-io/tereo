// @module-tag int
// @module-tag platform
// @module-tag race
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { DEFAULT_ORGANIZATION } from "../../definitions/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../utils/db/prisma.js";

// Two seeds (or core starts) at once on a fresh database both find no row and
// both insert it. Each case makes the existence check miss, as it would before
// the other run's insert committed, while that row is really there.
describe("ensureDefaultOrganization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ensureDefaultOrganization returns the default organization another run inserted", async () => {
    vi.spyOn(prisma.organization, "findUnique").mockResolvedValueOnce(null);

    await expect(ensureDefaultOrganization()).resolves.toMatchObject({
      id: DEFAULT_ORGANIZATION.id,
    });
  });
});

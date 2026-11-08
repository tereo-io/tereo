// @module-tag int
// @module-tag auth
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SYSTEM_USER_ID } from "../../../definitions/systemUser.js";
import { generateUniqueId } from "../../support/auth/crypto.js";
import { createTestUser } from "../../support/auth/users.js";
import { prisma } from "../../../utils/db/prisma.js";
import {
  invalidateBranding,
  resolveBranding,
} from "../../../utils/branding/resolve.js";

// The default profile is a singleton in a shared DB. When one pre-exists it
// is never touched and the tests that need to own it skip.
describe("resolveBranding", () => {
  let ownedDefaultId: string | null = null;
  let hadDefault = false;
  let bucketId: number;
  let clientUuid: string;
  let clientId: string;
  const objectIds: string[] = [];

  const makeObject = async (key: string, deleted = false) => {
    const object = await prisma.object.create({
      data: {
        bucketId,
        objectKey: key,
        createdBy: SYSTEM_USER_ID,
        deletedAt: deleted ? new Date() : null,
      },
    });
    objectIds.push(object.id);
    return object.id;
  };

  beforeAll(async () => {
    const owner = await createTestUser();
    hadDefault = !!(await prisma.brandingProfile.findFirst({
      where: { clientId: null },
    }));
    if (!hadDefault) {
      const row = await prisma.brandingProfile.create({
        data: {
          clientId: null,
          appName: "Default app",
          headline: "Default headline",
          updatedBy: SYSTEM_USER_ID,
        },
      });
      ownedDefaultId = row.id;
    }
    const bucket = await prisma.bucket.create({
      data: {
        name: `test-bucket-branding-${generateUniqueId()}`,
        createdBy: SYSTEM_USER_ID,
        ownerId: SYSTEM_USER_ID,
      },
    });
    bucketId = bucket.id;
    clientId = `branding-${generateUniqueId()}`;
    const client = await prisma.oAuthClient.create({
      data: {
        clientId,
        name: "Resolve test client",
        redirectUris: [],
        scopes: [],
        grantTypes: ["client_credentials"],
        ownerId: owner.id,
      },
    });
    clientUuid = client.id;
    await invalidateBranding();
  });

  afterAll(async () => {
    // The client's profile goes with it (cascade).
    await prisma.oAuthClient.deleteMany({ where: { id: clientUuid } });
    if (ownedDefaultId) {
      await prisma.brandingProfile.deleteMany({
        where: { id: ownedDefaultId },
      });
    }
    await prisma.bucket.deleteMany({ where: { id: bucketId } });
    await invalidateBranding();
  });

  it("gives an unknown client id the default's branding", async (ctx) => {
    if (hadDefault) ctx.skip();
    const resolved = await resolveBranding(`unknown-${generateUniqueId()}`);
    expect(resolved?.appName).toBe("Default app");
    expect(resolved?.headline).toBe("Default headline");
    expect(resolved).toEqual(await resolveBranding(null));
  });

  it("treats malformed client ids as no client", async () => {
    const none = await resolveBranding(undefined);
    expect(await resolveBranding(["a", "b"])).toEqual(none);
    expect(await resolveBranding("")).toEqual(none);
    expect(await resolveBranding("x".repeat(10_000))).toEqual(none);
  });

  it("shows a save after invalidateBranding", async () => {
    const before = await resolveBranding(clientId);
    expect(before?.appName ?? null).not.toBe("Saved name");

    await prisma.brandingProfile.create({
      data: {
        clientId: clientUuid,
        appName: "Saved name",
        updatedBy: SYSTEM_USER_ID,
      },
    });
    await invalidateBranding();
    expect((await resolveBranding(clientId))?.appName).toBe("Saved name");

    await prisma.brandingProfile.deleteMany({
      where: { clientId: clientUuid },
    });
    await invalidateBranding();
    expect((await resolveBranding(clientId))?.appName ?? null).not.toBe(
      "Saved name"
    );
  });

  it("drops an image whose object is soft-deleted", async () => {
    const live = await makeObject(`${generateUniqueId()}.png`);
    const gone = await makeObject(`${generateUniqueId()}.png`, true);
    const liveRow = await prisma.object.findUniqueOrThrow({
      where: { id: live },
    });
    await prisma.brandingProfile.create({
      data: {
        clientId: clientUuid,
        logoObjectId: gone,
        faviconObjectId: live,
        updatedBy: SYSTEM_USER_ID,
      },
    });
    await invalidateBranding();
    const resolved = await resolveBranding(clientId);
    expect(resolved?.logoUrl).toBeNull();
    expect(resolved?.faviconUrl).toBe(
      `/oauth/branding/assets/${liveRow.objectKey}`
    );
    await prisma.brandingProfile.deleteMany({
      where: { clientId: clientUuid },
    });
    await invalidateBranding();
  });

  describe("caching", () => {
    const setAppName = async (appName: string) => {
      await prisma.brandingProfile.upsert({
        where: { clientId: clientUuid },
        create: { clientId: clientUuid, appName, updatedBy: SYSTEM_USER_ID },
        update: { appName },
      });
    };

    const removeProfile = async () => {
      await prisma.brandingProfile.deleteMany({
        where: { clientId: clientUuid },
      });
      await invalidateBranding();
    };

    it("expires a known client's entry after five minutes", async () => {
      await setAppName("First");
      await invalidateBranding();
      expect((await resolveBranding(clientId))?.appName).toBe("First");

      // Written without an invalidation, as a replica that missed one sees it.
      await setAppName("Second");
      expect((await resolveBranding(clientId))?.appName).toBe("First");

      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60_000 + 1);
      try {
        expect((await resolveBranding(clientId))?.appName).toBe("Second");
      } finally {
        clock.mockRestore();
        await removeProfile();
      }
    });

    it("keeps unknown ids from evicting known clients", async () => {
      await setAppName("Cached");
      await invalidateBranding();
      expect((await resolveBranding(clientId))?.appName).toBe("Cached");
      await setAppName("Not yet seen");

      for (let i = 0; i < 1100; i++) {
        await resolveBranding(`junk-${i}-${generateUniqueId()}`);
      }

      expect((await resolveBranding(clientId))?.appName).toBe("Cached");
      await removeProfile();
    });

    it("costs an unknown id one client lookup and no profile reads", async () => {
      await resolveBranding(null);
      const clients = vi.spyOn(prisma.oAuthClient, "findUnique");
      const profiles = vi.spyOn(prisma.brandingProfile, "findFirst");
      try {
        const junk = `junk-${generateUniqueId()}`;
        await resolveBranding(junk);
        await resolveBranding(junk);
        expect(clients).toHaveBeenCalledTimes(1);
        expect(profiles).not.toHaveBeenCalled();
      } finally {
        clients.mockRestore();
        profiles.mockRestore();
      }
    });
  });
});

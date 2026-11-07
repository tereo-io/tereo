// @module-tag int
// @module-tag auth
import { SYSTEM_USER_ID } from "../../../definitions/systemUser.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateUniqueId } from "../../support/auth/crypto.js";
import { createTestUser } from "../../support/auth/users.js";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";

const makeClient = async (ownerId: string) =>
  prisma.oAuthClient.create({
    data: {
      clientId: `branding-${generateUniqueId()}`,
      name: "Branding test client",
      redirectUris: [],
      scopes: [],
      grantTypes: ["client_credentials"],
      ownerId,
    },
  });

describe("branding tables", () => {
  let ownerId: string;
  let userId: string;
  const clientIds: string[] = [];
  let hadDefault = false;

  beforeAll(async () => {
    ownerId = (await createTestUser()).id;
    userId = (await createTestUser()).id;
    hadDefault = (await db.brandingProfiles.getDefault()) !== null;
  });

  afterAll(async () => {
    if (!hadDefault) {
      await prisma.brandingProfile.deleteMany({ where: { clientId: null } });
    }
    await prisma.oAuthClient.deleteMany({ where: { id: { in: clientIds } } });
  });

  it("allows only one default profile", async () => {
    await prisma.brandingProfile.deleteMany({ where: { clientId: null } });
    await prisma.brandingProfile.create({
      data: { clientId: null, updatedBy: SYSTEM_USER_ID },
    });
    await expect(
      prisma.brandingProfile.create({
        data: { clientId: null, updatedBy: SYSTEM_USER_ID },
      })
    ).rejects.toThrow();
  });

  it("removes a client's profile and grants with the client", async () => {
    const client = await makeClient(ownerId);
    await prisma.brandingProfile.create({
      data: { clientId: client.id, updatedBy: SYSTEM_USER_ID },
    });
    await db.brandingGrants.create(
      { clientUuid: client.id, userId, grantedBy: SYSTEM_USER_ID },
      prisma
    );
    await prisma.oAuthClient.delete({ where: { id: client.id } });
    expect(await db.brandingProfiles.getByClientUuid(client.id)).toBeNull();
    expect(await db.brandingGrants.listActive(client.id)).toHaveLength(0);
  });

  it("requires provisioned_from exactly when provisioned", async () => {
    const client = await makeClient(ownerId);
    clientIds.push(client.id);
    await expect(
      prisma.brandingProfile.create({
        data: {
          clientId: client.id,
          updatedBy: SYSTEM_USER_ID,
          provisioned: true,
        },
      })
    ).rejects.toThrow();
    await expect(
      prisma.brandingProfile.create({
        data: {
          clientId: client.id,
          updatedBy: SYSTEM_USER_ID,
          provisionedFrom: "a.json",
        },
      })
    ).rejects.toThrow();
  });

  it("allows one active grant per client and user, and a new one after revoke", async () => {
    const client = await makeClient(ownerId);
    clientIds.push(client.id);
    const input = {
      clientUuid: client.id,
      userId,
      grantedBy: SYSTEM_USER_ID,
    };
    await db.brandingGrants.create(input, prisma);
    await expect(db.brandingGrants.create(input, prisma)).rejects.toThrow();
    await db.brandingGrants.revoke(client.id, userId, SYSTEM_USER_ID, prisma);
    expect(await db.brandingGrants.getActive(client.id, userId)).toBeNull();
    await db.brandingGrants.create(input, prisma);
    expect(await db.brandingGrants.clientUuidsForUser(userId)).toContain(
      client.id
    );
  });
});

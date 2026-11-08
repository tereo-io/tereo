// @module-tag int
// @module-tag auth
// @module-tag race
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { lockWaiters, untilQueued } from "../../support/dbLocks.js";
import { SYSTEM_USER_ID } from "../../../definitions/systemUser.js";
import { NotFoundError } from "../../../utils/errors.js";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import {
  EMPTY_PROFILE_VALUES,
  deleteClientBrandingTx,
  saveProfileTx,
} from "../../../utils/branding/write.js";
import {
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
  grantBranding,
} from "../../support/branding.js";

describe("saveProfileTx racing a client delete", () => {
  it("is 404 when the client was deleted while it waited for the profile lock", async () => {
    const { userId } = await brandingPrincipal([]);
    const client = await createBrandingClient(userId);

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    // A client delete: the profile lock, then the client gone at commit.
    const deletion = prisma.$transaction(
      async (tx) => {
        await db.brandingProfiles.lockForWrite({ clientUuid: client.id }, tx);
        locked();
        await released;
        await tx.oAuthClient.delete({ where: { id: client.id } });
      },
      { timeout: 30_000 }
    );
    await held;

    const baseline = await lockWaiters();
    const save = prisma.$transaction(
      (tx) =>
        saveProfileTx(
          tx,
          { client },
          { ...EMPTY_PROFILE_VALUES, appName: "Late" },
          { userId, email: null },
          null
        ),
      { timeout: 30_000 }
    );
    await untilQueued(baseline, 1, 5_000);
    release();

    await deletion;
    await expect(save).rejects.toBeInstanceOf(NotFoundError);
    expect(
      await prisma.brandingProfile.count({ where: { clientId: client.id } })
    ).toBe(0);
  });
});

describe("deleteClientBrandingTx racing a grant revoke", () => {
  beforeAll(ensureDefaultOrganization);

  it("does not revoke again a grant an admin revoked while it waited", async () => {
    const { userId } = await brandingPrincipal([]);
    const client = await createBrandingClient(userId);
    await grantBranding(client.id, userId);
    const grant = await prisma.brandingGrant.findFirstOrThrow({
      where: { clientId: client.id },
    });

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let revoked!: () => void;
    const held = new Promise<void>((r) => (revoked = r));
    // An admin revoke: the grant updated, not yet committed.
    const revoke = prisma.$transaction(
      async (tx) => {
        await db.brandingGrants.revoke(client.id, userId, userId, tx);
        revoked();
        await released;
      },
      { timeout: 30_000 }
    );
    await held;

    const baseline = await lockWaiters();
    const deletion = prisma.$transaction(
      (tx) =>
        deleteClientBrandingTx(tx, client, {
          userId: SYSTEM_USER_ID,
          email: null,
        }),
      { timeout: 30_000 }
    );
    await untilQueued(baseline, 1, 5_000);
    release();
    await revoke;
    await deletion;

    const entries = await prisma.auditLogEntry.findMany({
      where: { entityType: "BrandingGrant", entityId: grant.id },
    });
    expect(
      entries.filter(
        (e) =>
          (e.metadata as { reason?: string } | null)?.reason ===
          "client_deleted"
      )
    ).toHaveLength(0);
    await deleteBrandingClients([client.id]);
  });
});

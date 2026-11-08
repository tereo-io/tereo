// @module-tag int
// @module-tag auth
// @module-tag race
import { lockWaiters, untilQueued } from "../../support/dbLocks.js";
import { NotFoundError } from "../../../utils/errors.js";
import { prisma } from "../../../utils/db/prisma.js";
import { describe, expect, it } from "vitest";
import db from "../../../utils/db/index.js";
import {
  EMPTY_PROFILE_VALUES,
  saveProfileTx,
} from "../../../utils/branding/write.js";
import {
  brandingPrincipal,
  createBrandingClient,
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

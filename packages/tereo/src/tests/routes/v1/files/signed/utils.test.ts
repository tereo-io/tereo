// @module-tag int
// @module-tag files
import { auditAndSpendShareUrl } from "../../../../../routes/v1/files/signed/utils.js";
import { storeShareUrlNonce } from "../../../../../utils/shareUrlNonces.js";
import { SYSTEM_USER_ID } from "../../../../../definitions/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logAuditTx } from "../../../../../utils/outbox.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import db from "../../../../../utils/db/index.js";
import { randomUUID } from "crypto";

describe("auditAndSpendShareUrl", () => {
  const capped = { capped: true };

  const minted = async () => {
    const verified = {
      share: randomUUID(),
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    await storeShareUrlNonce(
      verified.share,
      verified.nonce,
      verified.expiresAt
    );
    return verified;
  };

  const auditFor =
    (entityId: string) => (tx: Parameters<typeof logAuditTx>[0]) =>
      logAuditTx(tx, {
        auth: { userId: SYSTEM_USER_ID, email: null },
        action: "CREATE",
        entityType: "presignedDownload",
        entityId,
      });

  const entries = (entityId: string) =>
    prisma.auditLogEntry.count({
      where: { entityType: "presignedDownload", entityId },
    });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spends a capped share's URL once, auditing only the download it serves", async () => {
    const verified = await minted();
    const first = randomUUID();
    const replay = randomUUID();

    await auditAndSpendShareUrl(verified, capped, auditFor(first));
    await expect(
      auditAndSpendShareUrl(verified, capped, auditFor(replay))
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await entries(first)).toBe(1);
    expect(await entries(replay)).toBe(0);
  });

  it("lets only one of two concurrent hits through", async () => {
    const verified = await minted();
    const results = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((id) =>
        auditAndSpendShareUrl(verified, capped, auditFor(id))
      )
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });

  it("gives the nonce back when the commit fails after spending it", async () => {
    const verified = await minted();
    const real = db.$transaction;
    vi.spyOn(db, "$transaction").mockImplementationOnce((fn) =>
      real(async (tx) => {
        await fn(tx);
        throw new Error("commit failed");
      })
    );
    const failed = randomUUID();
    await expect(
      auditAndSpendShareUrl(verified, capped, auditFor(failed))
    ).rejects.toThrow("commit failed");
    expect(await entries(failed)).toBe(0);

    // The URL still serves, once.
    const retry = randomUUID();
    await auditAndSpendShareUrl(verified, capped, auditFor(retry));
    expect(await entries(retry)).toBe(1);
    await expect(
      auditAndSpendShareUrl(verified, capped, auditFor(randomUUID()))
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

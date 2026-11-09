// @module-tag int
// @module-tag auth
import { PASSWORD_LINK_PURPOSES } from "../../../utils/db/userLinkTokens.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateUniqueId } from "../../support/auth/crypto.js";
import { createTestUser } from "../../support/auth/users.js";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";

describe("user link tokens", () => {
  let creatorId: string;
  const userIds: string[] = [];

  const makeUser = async () => {
    const { id } = await createTestUser();
    userIds.push(id);
    return id;
  };

  const link = (
    userId: string,
    purpose: "setup" | "reset" | "verify",
    email: string | null = null
  ) =>
    db.userLinkTokens.create({
      userId,
      purpose,
      email,
      tokenHash: generateUniqueId().padEnd(64, "0").slice(0, 64),
      createdBy: creatorId,
      expiresAt: new Date(Date.now() + 60_000),
    });

  beforeAll(async () => {
    creatorId = (await createTestUser()).id;
  });

  afterAll(async () => {
    await prisma.userLinkToken.deleteMany({
      where: { userId: { in: userIds } },
    });
  });

  it("a live password link and a live verify link coexist", async () => {
    const userId = await makeUser();
    await link(userId, "setup");
    await expect(
      link(userId, "verify", "a@example.com")
    ).resolves.toBeDefined();
  });

  it("a second live password link violates the live-password index", async () => {
    const userId = await makeUser();
    await link(userId, "setup");
    await expect(link(userId, "reset")).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("a verify link requires an email and a password link refuses one", async () => {
    const userId = await makeUser();
    await expect(link(userId, "verify", null)).rejects.toThrow(
      /user_link_tokens_email_purpose_check/
    );
    await expect(link(userId, "reset", "a@example.com")).rejects.toThrow(
      /user_link_tokens_email_purpose_check/
    );
  });

  it("findLiveByHash filters by purpose", async () => {
    const userId = await makeUser();
    const { tokenHash } = await link(userId, "reset");
    expect(await db.userLinkTokens.findLiveByHash(tokenHash, ["verify"])).toBe(
      null
    );
    const found = await db.userLinkTokens.findLiveByHash(
      tokenHash,
      PASSWORD_LINK_PURPOSES
    );
    expect(found?.user.id).toBe(userId);
  });

  it("invalidateForUser leaves other purposes live", async () => {
    const userId = await makeUser();
    await link(userId, "setup");
    const verify = await link(userId, "verify", "a@example.com");
    await db.userLinkTokens.invalidateForUser(userId, PASSWORD_LINK_PURPOSES);
    const row = await prisma.userLinkToken.findUniqueOrThrow({
      where: { id: verify.id },
    });
    expect(row.usedAt).toBeNull();
  });
});

// @module-tag int
// @module-tag platform
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { randomUUID } from "crypto";

// Constraints the database itself enforces for guest users.

const tag = randomUUID().slice(0, 8);
const userIds: string[] = [];
const roleIds: string[] = [];
const serviceIds: string[] = [];

async function insertUser(userType: string, expiresAt: Date | null) {
  const id = randomUUID();
  userIds.push(id);
  await prisma.$executeRaw`
    INSERT INTO "auth"."users" ("id", "email", "user_type", "expires_at", "updated_at")
    VALUES (${id}::uuid, ${`schema-${tag}-${id}@test.local`}, ${userType}::"auth"."user_type", ${expiresAt}, now())`;
  return id;
}

async function insertSetupToken(userId: string, used: boolean) {
  await prisma.$executeRaw`
    INSERT INTO "auth"."user_link_tokens"
      ("id", "user_id", "purpose", "token_hash", "created_by", "expires_at", "used_at")
    VALUES (${randomUUID()}::uuid, ${userId}::uuid, 'setup', ${randomUUID()}, ${userId}::uuid,
      now() + interval '1 day', ${used ? new Date() : null})`;
}

const FUTURE = new Date(Date.now() + 86_400_000);

describe("guest users schema", () => {
  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "auth"."user_link_tokens" WHERE "user_id" = ANY(${userIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM "auth"."roles" WHERE "id" = ANY(${roleIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM "auth"."users" WHERE "id" = ANY(${userIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM "core"."services" WHERE "id" = ANY(${serviceIds}::uuid[])`;
  });

  it("guest needs expires_at", async () => {
    await expect(insertUser("guest", null)).rejects.toThrow(
      /users_guest_expiry_check/
    );
    await expect(insertUser("guest", FUTURE)).resolves.toBeTruthy();
  });

  it("non-guest may not have expires_at", async () => {
    await expect(insertUser("human", FUTURE)).rejects.toThrow(
      /users_guest_expiry_check/
    );
    await expect(insertUser("human", null)).resolves.toBeTruthy();
  });

  it("system role cannot be guest assignable", async () => {
    const serviceId = randomUUID();
    serviceIds.push(serviceId);
    await prisma.service.create({
      data: {
        id: serviceId,
        slug: `schema-${tag}`,
        namespace: `schema-${tag}`,
        name: "Schema test",
        createdBy: SYSTEM_USER_ID,
      },
    });
    const insertRole = async (service: string | null) => {
      const id = randomUUID();
      roleIds.push(id);
      await prisma.$executeRaw`
        INSERT INTO "auth"."roles" ("id", "name", "display_name", "service_id", "guest_assignable", "updated_at")
        VALUES (${id}::uuid, ${`schema-${tag}-${id}`}, 'Schema', ${service}::uuid, true, now())`;
    };
    await expect(insertRole(serviceId)).rejects.toThrow(
      /roles_guest_assignable_custom_check/
    );
    await expect(insertRole(null)).resolves.toBeUndefined();
  });

  it("one live setup token per user", async () => {
    const userId = await insertUser("human", null);
    await insertSetupToken(userId, true);
    await insertSetupToken(userId, true);
    await insertSetupToken(userId, false);
    await expect(insertSetupToken(userId, false)).rejects.toThrow(
      /user_link_tokens_user_id_live_password_key/
    );
  });
});

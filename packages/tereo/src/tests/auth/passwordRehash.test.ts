import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes, scryptSync } from "node:crypto";
import { prisma } from "../../utils/db/prisma.js";
import {
  createTestClient,
  createTestUser,
  getAccessTokenForUser,
} from "./utils/test-helpers.js";

const legacyHash = (password: string) => {
  const salt = randomBytes(32);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt.toString("hex")}:${key.toString("hex")}`;
};

let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  client = await createTestClient();
});

const storedHash = async (id: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;

describe("password hash upgrade at login", () => {
  it("rehashes a legacy hash at the current parameters on a correct login", async () => {
    const user = await createTestUser();
    const legacy = legacyHash(user.plainPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: legacy },
    });

    expect(await getAccessTokenForUser(user, client)).toBeTruthy();

    const upgraded = await storedHash(user.id);
    expect(upgraded).not.toBe(legacy);
    expect(upgraded).toMatch(/^scrypt\$16384\$8\$5\$/);
    // The upgraded hash still lets the user in.
    expect(await getAccessTokenForUser(user, client)).toBeTruthy();
    expect(await storedHash(user.id)).toBe(upgraded);
  });

  it("leaves a current hash alone", async () => {
    const user = await createTestUser();
    expect(await getAccessTokenForUser(user, client)).toBeTruthy();
    expect(await storedHash(user.id)).toBe(user.passwordHash);
  });
});

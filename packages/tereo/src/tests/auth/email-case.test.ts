import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  getAccessTokenForUser,
} from "../support/auth.js";

describe("Email case", () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    client = await createTestClient();
    user = await createTestUser();
  });

  it("logs in with the email in a different case and padded", async () => {
    const token = await getAccessTokenForUser(
      { ...user, email: `  ${user.email.toUpperCase()} ` },
      client
    );

    const response = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
    const me = (await response.json()) as { id: string; email: string };
    expect(me).toMatchObject({ id: user.id, email: user.email });
  });

  it("refuses to store an email that is not lower case", async () => {
    await expect(
      prisma.user.update({
        where: { id: user.id },
        data: { email: user.email.toUpperCase() },
      })
    ).rejects.toThrow();
  });
});

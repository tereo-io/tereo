import { getTestPrincipalToken } from "../support/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  getAccessTokenForUser,
} from "../support/auth.js";

describe("bearer scheme case", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestPrincipalToken({
      permissions: ["webhooks.event-types.read"],
    });
  });

  it("admits a valid token sent as bearer or BEARER", async () => {
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      const res = await fetch(`${BASE_URL}/v1/webhooks/event-types`, {
        headers: { Authorization: `${scheme} ${token}` },
      });
      expect(res.status, scheme).toBe(HTTP_STATUS.OK);
    }
  });

  it("still refuses another scheme", async () => {
    const res = await fetch(`${BASE_URL}/v1/webhooks/event-types`, {
      headers: { Authorization: `Token ${token}` },
    });
    expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it("admits a lower-case bearer at /oauth/userinfo", async () => {
    const user = await createTestUser();
    const client = await createTestClient();
    const userToken = await getAccessTokenForUser(user, client);
    const res = await fetch(`${BASE_URL}/oauth/userinfo`, {
      headers: { Authorization: `bearer ${userToken}` },
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
  });
});

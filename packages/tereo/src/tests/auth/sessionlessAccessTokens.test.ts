import { getTestPrincipalToken } from "../utils/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  getAccessTokenForUser,
  getUiAccessTokenForUser,
} from "./utils/test-helpers.js";

/**
 * A client without the refresh_token grant gets access tokens that no
 * refresh token carries. Signing a user out everywhere must reach them too.
 */

let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  client = await createTestClient({ grantTypes: ["authorization_code"] });
});

const me = async (token: string) =>
  (
    await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).status;

const setup = async () => {
  const user = await createTestUser();
  const sessionless = await getAccessTokenForUser(
    user,
    client,
    "openid core:account"
  );
  expect(await me(sessionless)).toBe(HTTP_STATUS.OK);
  return { user, sessionless };
};

describe("access tokens issued without a refresh token", () => {
  it("are revoked by a password change", async () => {
    const { user, sessionless } = await setup();
    const owner = await getUiAccessTokenForUser(user);

    const res = await fetch(`${BASE_URL}/v1/account/password`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        newPassword: "An0ther-Long-Passw0rd!",
      }),
    });
    expect(res.status).toBe(HTTP_STATUS.OK);

    expect(await me(sessionless)).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await me(owner)).toBe(HTTP_STATUS.OK);
  });

  it("are revoked by signing out everywhere else", async () => {
    const { user, sessionless } = await setup();
    const owner = await getUiAccessTokenForUser(user);

    const res = await fetch(`${BASE_URL}/v1/account/sessions`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${owner}` },
    });
    expect(res.status).toBe(HTTP_STATUS.OK);

    expect(await me(sessionless)).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await me(owner)).toBe(HTTP_STATUS.OK);
  });

  it("keep the caller's own when it signs out everywhere else", async () => {
    const { user, sessionless } = await setup();
    const other = await getAccessTokenForUser(
      user,
      client,
      "openid core:account"
    );

    const res = await fetch(`${BASE_URL}/v1/account/sessions`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${sessionless}` },
    });
    expect(res.status).toBe(HTTP_STATUS.OK);

    expect(await me(sessionless)).toBe(HTTP_STATUS.OK);
    expect(await me(other)).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it("stay revoked after the user is deactivated and reactivated", async () => {
    const { user, sessionless } = await setup();
    const admin = await getTestPrincipalToken({ permissions: ["users.write"] });
    const setActive = async (isActive: boolean) =>
      (
        await fetch(`${BASE_URL}/v1/admin/users/${user.id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${admin}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isActive }),
        })
      ).status;

    expect(await setActive(false)).toBe(HTTP_STATUS.OK);
    expect(await setActive(true)).toBe(HTTP_STATUS.OK);

    expect(await me(sessionless)).toBe(HTTP_STATUS.UNAUTHORIZED);
  });
});

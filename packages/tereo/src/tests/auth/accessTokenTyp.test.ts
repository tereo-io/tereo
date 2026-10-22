import { getTestPrincipalToken } from "../support/principals.js";
import { LOGIN_CLIENT } from "../../definitions/index.js";
import { generateIdToken } from "../../utils/tokens.js";
import { currentSigningKey } from "../../utils/keys.js";
import { prisma } from "../../utils/db/prisma.js";
import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import env from "../../env.js";
import jwt from "jsonwebtoken";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestUser,
  getJwtHeader,
} from "../support/auth.js";

/**
 * Access tokens carry `typ: at+jwt` (RFC 9068). One without it is from
 * before the change and is accepted only if issued before the server
 * started; an ID token is never accepted.
 */

const me = (token: string) =>
  fetch(`${BASE_URL}/v1/account/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

/** A stored access token for the UI's client, signed with the given header. */
const legacyToken = async (iat: number, typ?: string) => {
  const user = await createTestUser();
  const client = await prisma.oAuthClient.findUniqueOrThrow({
    where: { clientId: LOGIN_CLIENT.clientId },
  });
  const jti = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await prisma.accessToken.create({
    data: {
      jti,
      clientId: client.id,
      userId: user.id,
      scopes: [],
      expiresAt: new Date(exp * 1000),
    },
  });
  return jwt.sign(
    {
      iss: env.ISSUER,
      sub: user.id,
      iat,
      exp,
      jti,
      scope: "",
      client_id: client.clientId,
    },
    currentSigningKey().privateKey,
    {
      algorithm: "RS256",
      keyid: currentSigningKey().kid,
      ...(typ !== undefined && { header: { alg: "RS256", typ } }),
    }
  );
};

const now = () => Math.floor(Date.now() / 1000);

describe("access token typ", () => {
  it("is at+jwt on issued access tokens", async () => {
    const token = await getTestPrincipalToken({ permissions: [] });
    expect(getJwtHeader(token).typ).toBe("at+jwt");
    expect((await me(token)).status).toBe(HTTP_STATUS.OK);
  });

  it("accepts a JWT-typed token issued before the server started", async () => {
    const token = await legacyToken(now() - 3 * 3600);
    expect(getJwtHeader(token).typ).toBe("JWT");
    expect((await me(token)).status).toBe(HTTP_STATUS.OK);
  });

  it("refuses a JWT-typed token issued since", async () => {
    const token = await legacyToken(now() + 3600);
    expect((await me(token)).status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it("refuses any other typ", async () => {
    const token = await legacyToken(now() - 3 * 3600, "id+jwt");
    expect((await me(token)).status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it("refuses an ID token, which is typed JWT", async () => {
    const user = await createTestUser();
    const { token } = generateIdToken({
      subject: user.id,
      clientId: LOGIN_CLIENT.clientId,
    });
    expect(getJwtHeader(token).typ).toBe("JWT");
    expect((await me(token)).status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });
});

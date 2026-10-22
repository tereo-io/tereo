import { generateAccessToken, verifyAccessToken } from "../../utils/tokens.js";
import { DEFAULT_ORGANIZATION_ID } from "../../definitions/index.js";
import { ID_TOKEN_HINT_GRACE_SECONDS } from "../../utils/tokens.js";
import { getTestPrincipalToken } from "../support/principals.js";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { generateKeyPairSync } from "crypto";
import env from "../../env.js";
import jwt from "jsonwebtoken";
import * as jose from "jose";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../support/webhooks.js";
import {
  ACTIVATION_DELAY_MS,
  currentSigningKey,
  publishedSigningKeys,
  refreshSigningKeys,
} from "../../utils/keys.js";
import {
  BASE_URL,
  createTestClient,
  fetchJwks,
  getJwtHeader,
  HTTP_STATUS,
  type TokenResponse,
} from "../support/auth.js";

/**
 * Rotating the JWT signing key through the admin API. The server keeps the
 * new keys; later files load the last, immediate, one as the active one.
 * Tokens minted here before the rotation are signed in this process with the
 * then-active key.
 */

interface KeySummary {
  kid: string;
  version: number | null;
  active: boolean;
  activatesAt: string | null;
  retiredAt: string | null;
  expiresAt: string | null;
}

interface RotateResponse {
  keys: KeySummary[];
  activatesAt: string;
}

const JWT_KEY_PREFIX = "JWT_SIGNING_KEY_V";

const signingKeyRow = (version: number) =>
  prisma.secret.findUniqueOrThrow({
    where: { name: `${JWT_KEY_PREFIX}${version}` },
  });

/** A client_credentials access token, issued by the server. */
const serverToken = async (): Promise<string> => {
  const client = await createTestClient({
    clientType: "confidential",
    grantTypes: ["client_credentials"],
    scopes: ["openid"],
  });
  const response = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(
        `${client.clientId}:${client.plainSecret}`
      ).toString("base64")}`,
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      scope: "openid",
    }),
  });
  expect(response.status).toBe(HTTP_STATUS.OK);
  const { access_token } = (await response.json()) as TokenResponse;
  return access_token!;
};

/** An access token signed in this process. */
const localToken = () =>
  generateAccessToken({
    subject: "signing-key-rotation-test",
    clientId: "signing-key-rotation-test",
    scopes: [],
  }).token;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const listKeys = (token: string) =>
  fetch(`${BASE_URL}/v1/admin/signing-keys`, { headers: auth(token) });

describe("JWT signing key rotation", () => {
  let adminToken: string;
  let readerToken: string;
  let oldKid: string;
  let oldPrivateKey: string;
  let newKid: string;
  let newVersion: number;
  let immediateKid: string;
  let rotatedAt: number;
  let endpointId: string;

  beforeAll(async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["core.signing-key.rotated"] }
    );
    endpointId = endpoint.id;
    adminToken = await getTestPrincipalToken({
      permissions: ["settings.write"],
    });
    readerToken = await getTestPrincipalToken({
      permissions: ["settings.read"],
    });
    oldKid = getJwtHeader(adminToken).kid!;
    // The key adminToken was signed with, kept for re-signing after the
    // rotations below have moved the signing key on.
    await refreshSigningKeys();
    expect(currentSigningKey().kid).toBe(oldKid);
    oldPrivateKey = currentSigningKey().privateKey;
  });

  it("lists the active key to settings readers", async () => {
    const response = await listKeys(readerToken);
    expect(response.status).toBe(HTTP_STATUS.OK);
    const { keys } = (await response.json()) as { keys: KeySummary[] };
    expect(keys[0]).toMatchObject({ kid: oldKid, active: true });
  });

  it("refuses rotation without settings.write", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/signing-keys/rotate`, {
      method: "POST",
      headers: auth(readerToken),
    });
    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("refuses a malformed rotation body", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/signing-keys/rotate`, {
      method: "POST",
      headers: { ...auth(adminToken), "Content-Type": "application/json" },
      body: JSON.stringify({ immediate: "yes" }),
    });
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it("publishes a new key that activates later; the old one keeps signing", async () => {
    rotatedAt = Date.now();
    const response = await fetch(`${BASE_URL}/v1/admin/signing-keys/rotate`, {
      method: "POST",
      headers: auth(adminToken),
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
    const { keys, activatesAt } = (await response.json()) as RotateResponse;

    const newest = keys[0];
    newKid = newest.kid;
    newVersion = newest.version!;
    expect(newKid).not.toBe(oldKid);
    expect(newKid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newest.active).toBe(false);
    expect(newest.activatesAt).toBe(activatesAt);
    const activation = new Date(activatesAt).getTime();
    expect(activation).toBeGreaterThanOrEqual(rotatedAt + ACTIVATION_DELAY_MS);
    expect(activation).toBeLessThanOrEqual(Date.now() + ACTIVATION_DELAY_MS);

    // The old key signs until the new one activates, then retires.
    const old = keys.find((k) => k.kid === oldKid)!;
    expect(old.active).toBe(true);
    expect(old.retiredAt).toBe(activatesAt);
    expect(
      new Date(old.expiresAt!).getTime() - new Date(old.retiredAt!).getTime()
    ).toBe((env.JWT_ACCESS_TOKEN_TTL + ID_TOKEN_HINT_GRACE_SECONDS) * 1000);

    const audit = await prisma.auditLogEntry.findFirst({
      where: { entityType: "SigningKey", entityId: newKid },
    });
    expect(audit).not.toBeNull();
  });

  it("emits core.signing-key.rotated with both kids and no key material", async () => {
    const retention =
      (env.JWT_ACCESS_TOKEN_TTL + ID_TOKEN_HINT_GRACE_SECONDS) * 1000;
    // emitTx → core.outbox → reaper → fan-out creates the delivery.
    const where = {
      webhookEndpointId: endpointId,
      eventType: "core.signing-key.rotated",
      payload: { path: ["entityId"], equals: newKid },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) > 0,
      10_000
    );
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where });
    const payload = delivery.payload as {
      organizationId: string;
      entityType: string;
      data: Record<string, unknown>;
    };

    expect(payload.organizationId).toBe(DEFAULT_ORGANIZATION_ID);
    expect(payload.entityType).toBe("SigningKey");
    expect(Object.keys(payload.data).sort()).toEqual([
      "activatesAt",
      "kid",
      "retiredKid",
      "retiredKidExpiresAt",
    ]);
    expect(payload.data.kid).toBe(newKid);
    expect(payload.data.retiredKid).toBe(oldKid);
    const activatesAt = new Date(payload.data.activatesAt as string);
    const expiresAt = new Date(payload.data.retiredKidExpiresAt as string);
    expect(expiresAt.getTime() - activatesAt.getTime()).toBe(retention);
    expect(activatesAt.getTime()).toBeGreaterThanOrEqual(
      rotatedAt + ACTIVATION_DELAY_MS
    );
    // The times match what the key list reports.
    const { keys } = (await (await listKeys(readerToken)).json()) as {
      keys: KeySummary[];
    };
    expect(keys.find((k) => k.kid === newKid)!.activatesAt).toBe(
      activatesAt.toISOString()
    );
    expect(keys.find((k) => k.kid === oldKid)!.expiresAt).toBe(
      expiresAt.toISOString()
    );
    expect(JSON.stringify(payload)).not.toMatch(/PRIVATE KEY|PUBLIC KEY/);
  });

  it("publishes both keys in the JWKS, the new one first", async () => {
    const { keys } = await fetchJwks();
    const kids = keys.map((k) => k.kid);
    expect(kids[0]).toBe(newKid);
    expect(kids).toContain(oldKid);
  });

  it("still accepts tokens signed with the old key", async () => {
    expect(getJwtHeader(adminToken).kid).toBe(oldKid);
    const response = await listKeys(adminToken);
    expect(response.status).toBe(HTTP_STATUS.OK);
  });

  it("keeps signing new tokens with the old key until the new one activates", async () => {
    expect(getJwtHeader(await serverToken()).kid).toBe(oldKid);
    await refreshSigningKeys();
    expect(getJwtHeader(localToken()).kid).toBe(oldKid);
  });

  it("signs with the new key once its activation has passed", async () => {
    const row = await signingKeyRow(newVersion);
    await prisma.secret.update({
      where: { name: row.name },
      data: { createdAt: new Date(Date.now() - 1000) },
    });
    await refreshSigningKeys();

    const token = localToken();
    expect(getJwtHeader(token).kid).toBe(newKid);
    expect(verifyAccessToken(token)).not.toBeNull();
    expect(verifyAccessToken(adminToken)).not.toBeNull();
    const jwks = jose.createLocalJWKSet(await fetchJwks());
    await expect(jose.jwtVerify(token, jwks)).resolves.toBeDefined();
  });

  it("refuses a token whose kid is unknown", async () => {
    const claims = jwt.decode(adminToken) as jwt.JwtPayload;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

    for (const kid of ["not-a-core-key", newKid]) {
      const forged = jwt.sign(claims, privateKey, {
        algorithm: "RS256",
        keyid: kid,
      });
      expect((await listKeys(forged)).status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }
  });

  it("refuses a token with no kid, even when correctly signed", async () => {
    const claims = jwt.decode(adminToken) as jwt.JwtPayload;
    // Typed like core's own tokens: an untyped "JWT" is honoured only for
    // tokens issued in the server's first minutes, so the kid alone decides.
    const header = { alg: "RS256" as const, typ: "at+jwt" };
    const withKid = jwt.sign(claims, oldPrivateKey, {
      algorithm: "RS256",
      keyid: oldKid,
      header,
    });
    const withoutKid = jwt.sign(claims, oldPrivateKey, {
      algorithm: "RS256",
      header,
    });

    expect((await listKeys(withKid)).status).toBe(HTTP_STATUS.OK);
    expect((await listKeys(withoutKid)).status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it("drops a retired key once its retention has passed", async () => {
    await refreshSigningKeys();
    expect(verifyAccessToken(adminToken)).not.toBeNull();

    // Retire the old key further back than one token lifetime and grace, by
    // moving the activation of every later version back past it.
    const later = (
      await prisma.secret.findMany({
        where: { name: { startsWith: JWT_KEY_PREFIX } },
      })
    ).filter(
      (row) => Number(row.name.slice(JWT_KEY_PREFIX.length)) >= newVersion
    );
    const retention =
      (env.JWT_ACCESS_TOKEN_TTL + ID_TOKEN_HINT_GRACE_SECONDS) * 1000;
    for (const row of later) {
      const version = Number(row.name.slice(JWT_KEY_PREFIX.length));
      await prisma.secret.update({
        where: { name: row.name },
        data: {
          createdAt: new Date(Date.now() - retention - 60_000 + version),
        },
      });
    }
    try {
      await refreshSigningKeys();
      expect(verifyAccessToken(adminToken)).toBeNull();
      expect(publishedSigningKeys().map((k) => k.kid)).not.toContain(oldKid);
      expect(currentSigningKey().kid).toBe(newKid);
    } finally {
      for (const row of later) {
        await prisma.secret.update({
          where: { name: row.name },
          data: { createdAt: row.createdAt },
        });
      }
    }
  });

  it("switches at once with immediate: true, and drops every older key", async () => {
    const newKeyToken = localToken();
    expect(getJwtHeader(newKeyToken).kid).toBe(newKid);
    const before = Date.now();
    const response = await fetch(`${BASE_URL}/v1/admin/signing-keys/rotate`, {
      method: "POST",
      headers: { ...auth(adminToken), "Content-Type": "application/json" },
      body: JSON.stringify({ immediate: true }),
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
    const { keys, activatesAt } = (await response.json()) as RotateResponse;
    immediateKid = keys[0].kid;
    expect(keys).toEqual([
      expect.objectContaining({ kid: immediateKid, active: true, activatesAt }),
    ]);
    expect(new Date(activatesAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(activatesAt).getTime()).toBeLessThanOrEqual(Date.now());

    const token = await serverToken();
    expect(getJwtHeader(token).kid).toBe(immediateKid);
    await refreshSigningKeys();
    expect(getJwtHeader(localToken()).kid).toBe(immediateKid);

    // Tokens from the keys before it are refused at once, here and by the
    // server, and their keys leave the JWKS.
    expect(verifyAccessToken(adminToken)).toBeNull();
    expect(verifyAccessToken(newKeyToken)).toBeNull();
    expect((await listKeys(adminToken)).status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect((await fetchJwks()).keys.map((k) => k.kid)).toEqual([immediateKid]);
    const rows = await prisma.secret.findMany({
      where: { name: { startsWith: JWT_KEY_PREFIX } },
    });
    expect(rows).toHaveLength(1);

    const audit = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityType: "SigningKey", entityId: immediateKid },
    });
    expect(audit.metadata).toMatchObject({
      retiredKid: newKid,
      retiredKidExpiresAt: activatesAt,
    });
  });
});

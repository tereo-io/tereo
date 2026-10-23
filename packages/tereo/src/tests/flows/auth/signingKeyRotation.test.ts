// @module-tag int
// @module-tag auth
// @module-tag security
import { DEFAULT_ORGANIZATION_ID } from "../../../definitions/index.js";
import { BASE_URL, HTTP_STATUS } from "../../support/auth/constants.js";
import { fetchJwks, getJwtHeader } from "../../support/auth/tokens.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import {
  closeCacheBroadcast,
  startCacheSubscriber,
} from "../../../utils/cacheBroadcast.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../support/webhooks.js";
import {
  generateAccessToken,
  verifyAccessToken,
} from "../../../utils/tokens.js";

/**
 * An immediate rotation (for a compromised key) while an earlier rotation is
 * still pending: the key that was signing stops verifying at once, here (a
 * second process, told by the broadcast) as in the server, and is the one
 * reported retired, not the pending key that never signed.
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

const rotate = (token: string, body?: unknown) =>
  fetch(`${BASE_URL}/v1/admin/signing-keys/rotate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("POST /v1/admin/signing-keys/rotate", () => {
  describe("immediate signing key rotation while a rotation is pending", () => {
    let signingKid: string;
    let pendingKid: string;
    let immediateKid: string;
    let immediateAt: number;
    let keys: KeySummary[];
    let endpointId: string;
    let token: string;
    let localToken: string;

    afterAll(async () => {
      await closeCacheBroadcast();
    });

    beforeAll(async () => {
      await startCacheSubscriber();
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["core.signing-key.rotated"] }
      );
      endpointId = endpoint.id;
      token = await getTestPrincipalToken({
        permissions: ["settings.write"],
      });
      signingKid = getJwtHeader(token).kid!;
      localToken = generateAccessToken({
        subject: "immediate-rotation-test",
        clientId: "immediate-rotation-test",
        scopes: [],
      }).token;
      expect(getJwtHeader(localToken).kid).toBe(signingKid);

      const pending = await rotate(token);
      expect(pending.status).toBe(HTTP_STATUS.OK);
      pendingKid = ((await pending.json()) as RotateResponse).keys[0].kid;

      const immediate = await rotate(token, { immediate: true });
      expect(immediate.status).toBe(HTTP_STATUS.OK);
      const body = (await immediate.json()) as RotateResponse;
      keys = body.keys;
      immediateKid = keys[0].kid;
      immediateAt = new Date(body.activatesAt).getTime();
    });

    it("signs with the immediate key, the only one left", () => {
      expect(keys).toEqual([
        expect.objectContaining({ kid: immediateKid, active: true }),
      ]);
    });

    it("drops the key that was signing, and the pending one, from the JWKS", async () => {
      const kids = (await fetchJwks()).keys.map((k) => k.kid);
      expect(kids).toContain(immediateKid);
      expect(kids).not.toContain(signingKid);
      expect(kids).not.toContain(pendingKid);
    });

    it("refuses the compromised key's tokens at once", async () => {
      const res = await fetch(`${BASE_URL}/v1/admin/signing-keys`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("has every other process drop the compromised key, without waiting for its periodic refresh", async () => {
      await waitFor(async () => verifyAccessToken(localToken) === null, 5_000);
    });

    it("names the key that was signing as retiredKid in the audit entry and event", async () => {
      const audit = await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityType: "SigningKey", entityId: immediateKid },
      });
      expect(audit.metadata).toMatchObject({
        retiredKid: signingKid,
        retiredKidExpiresAt: new Date(immediateAt).toISOString(),
      });

      const where = {
        webhookEndpointId: endpointId,
        eventType: "core.signing-key.rotated",
        payload: { path: ["entityId"], equals: immediateKid },
      };
      await waitFor(
        async () => (await prisma.webhookDelivery.count({ where })) > 0,
        10_000
      );
      const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where });
      const { data } = delivery.payload as { data: Record<string, unknown> };
      expect(data.retiredKid).toBe(signingKid);
    });
  });
});

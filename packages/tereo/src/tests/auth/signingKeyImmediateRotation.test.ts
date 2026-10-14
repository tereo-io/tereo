import { BASE_URL, getJwtHeader, HTTP_STATUS } from "./utils/test-helpers.js";
import { DEFAULT_ORGANIZATION_ID } from "../../definitions/index.js";
import { getTestPrincipalToken } from "../utils/principals.js";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../webhooks/utils/test-helpers.js";

/**
 * An immediate rotation (for a compromised key) while an earlier rotation is
 * still pending: the key that was signing retires at once, and is the one
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

describe("immediate signing key rotation while a rotation is pending", () => {
  let signingKid: string;
  let pendingKid: string;
  let immediateKid: string;
  let immediateAt: number;
  let keys: KeySummary[];
  let endpointId: string;

  beforeAll(async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["core.signing-key.rotated"] }
    );
    endpointId = endpoint.id;
    const token = await getTestPrincipalToken({
      permissions: ["settings.write"],
    });
    signingKid = getJwtHeader(token).kid!;

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

  it("signs with the immediate key", () => {
    expect(keys.find((k) => k.kid === immediateKid)!.active).toBe(true);
    expect(keys.find((k) => k.kid === pendingKid)!.active).toBe(false);
  });

  it("retires the key that was signing when the immediate key activates", () => {
    const compromised = keys.find((k) => k.kid === signingKid)!;
    expect(compromised.active).toBe(false);
    expect(new Date(compromised.retiredAt!).getTime()).toBe(immediateAt);
  });

  it("names the key that was signing as retiredKid in the audit entry and event", async () => {
    const audit = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityType: "SigningKey", entityId: immediateKid },
    });
    expect(audit.metadata).toMatchObject({ retiredKid: signingKid });

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

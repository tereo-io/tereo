// @module-tag int
// @module-tag auth
// @module-tag audit
import { DEFAULT_ORGANIZATION_ID } from "../../../../../../../../definitions/index.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchJson } from "../../../../../../../support/http.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../../../support/webhooks.js";
import {
  BRANDING_URL,
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
} from "../../../../../../../support/branding.js";

describe("/v1/admin/branding/clients/:id/grants side effects", () => {
  let owner: Awaited<ReturnType<typeof brandingPrincipal>>;
  let grantee: Awaited<ReturnType<typeof brandingPrincipal>>;
  let clientUuid: string;
  let endpointId: string;

  beforeAll(async () => {
    [owner, grantee] = await Promise.all([
      brandingPrincipal(["branding.write"]),
      brandingPrincipal(["branding.write"]),
    ]);
    clientUuid = (await createBrandingClient(owner.userId)).id;
    endpointId = (
      await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        {
          eventTypes: [
            "auth.branding.grant-added",
            "auth.branding.grant-revoked",
          ],
        }
      )
    ).id;
  });

  afterAll(async () => {
    await deleteBrandingClients([clientUuid]);
  });

  it("writes an audit entry and an event for each add and revoke", async () => {
    const url = `${BRANDING_URL}/clients/${clientUuid}/grants`;
    await fetchJson("POST", url, owner.token, { userId: grantee.userId });
    await fetchJson("DELETE", `${url}/${grantee.userId}`, owner.token);

    const grant = await prisma.brandingGrant.findFirstOrThrow({
      where: { clientId: clientUuid, userId: grantee.userId },
    });
    expect(grant.revokedBy).toBe(owner.userId);

    const entries = await prisma.auditLogEntry.findMany({
      where: { entityType: "BrandingGrant", entityId: grant.id },
      orderBy: { createdAt: "asc" },
    });
    expect(entries.map((e) => e.action)).toEqual(["CREATE", "DELETE"]);
    expect(entries.every((e) => e.userId === owner.userId)).toBe(true);

    for (const eventType of [
      "auth.branding.grant-added",
      "auth.branding.grant-revoked",
    ]) {
      const where = {
        webhookEndpointId: endpointId,
        eventType,
        payload: { path: ["entityId"], equals: grant.id },
      };
      await waitFor(
        async () => (await prisma.webhookDelivery.count({ where })) > 0,
        10_000
      );
    }
  });

  it("writes nothing for a refused duplicate", async () => {
    const url = `${BRANDING_URL}/clients/${clientUuid}/grants`;
    await fetchJson("POST", url, owner.token, { userId: grantee.userId });
    const { clientId } = await prisma.oAuthClient.findUniqueOrThrow({
      where: { id: clientUuid },
    });
    const where = { entityType: "BrandingGrant", entityName: clientId };
    const before = await prisma.auditLogEntry.count({ where });
    const res = await fetchJson("POST", url, owner.token, {
      userId: grantee.userId,
    });
    expect(res.status).toBe(409);
    expect(await prisma.auditLogEntry.count({ where })).toBe(before);
  });
});

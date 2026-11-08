// @module-tag int
// @module-tag auth
// @module-tag audit
import { DEFAULT_ORGANIZATION_ID } from "../../../../../../definitions/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../support/http.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../support/webhooks.js";
import {
  BRANDING_URL,
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
  grantBranding,
  storeTestImage,
} from "../../../../../support/branding.js";

describe("DELETE /v1/admin/clients/:id branding side effects", () => {
  let owner: Awaited<ReturnType<typeof brandingPrincipal>>;
  let grantee: Awaited<ReturnType<typeof brandingPrincipal>>;
  let endpointId: string;
  const clientIds: string[] = [];

  beforeAll(async () => {
    [owner, grantee] = await Promise.all([
      brandingPrincipal(["branding.write", "clients.delete"]),
      brandingPrincipal(["branding.write"]),
    ]);
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      {
        eventTypes: ["auth.branding.deleted", "auth.branding.grant-revoked"],
      }
    );
    endpointId = endpoint.id;
  });

  afterAll(async () => {
    await deleteBrandingClients(clientIds);
  });

  const deliveries = async (eventType: string, entityId: string) => {
    const where = {
      webhookEndpointId: endpointId,
      eventType,
      payload: { path: ["entityId"], equals: entityId },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) > 0,
      10_000
    );
    return await prisma.webhookDelivery.findMany({ where });
  };

  it("deletes the profile and revokes the grants, audited and emitted, and releases the profile's images", async () => {
    const client = await createBrandingClient(owner.userId);
    clientIds.push(client.id);
    const image = await storeTestImage("logo");
    const put = await fetchJson(
      "PUT",
      `${BRANDING_URL}/clients/${client.id}`,
      owner.token,
      { appName: "Doomed", logo: { sha256: image.sha256 } }
    );
    expect(put.status).toBe(200);
    await grantBranding(client.id, grantee.userId);
    const profile = await prisma.brandingProfile.findUniqueOrThrow({
      where: { clientId: client.id },
    });
    const grant = await prisma.brandingGrant.findFirstOrThrow({
      where: { clientId: client.id, userId: grantee.userId },
    });
    const deleteAfter = async () =>
      (await prisma.object.findUniqueOrThrow({ where: { id: image.objectId } }))
        .deleteAfter;
    expect(await deleteAfter()).toBeNull();

    const response = await fetchJson(
      "DELETE",
      `${CORE_URL}/v1/admin/clients/${client.id}`,
      owner.token
    );
    expect(response.status).toBe(204);

    expect(
      await prisma.auditLogEntry.findMany({
        where: {
          entityType: { in: ["BrandingProfile", "BrandingGrant"] },
          entityId: { in: [profile.id, grant.id] },
          action: "DELETE",
        },
        orderBy: { entityType: "asc" },
      })
    ).toMatchObject([
      {
        entityType: "BrandingGrant",
        entityName: client.clientId,
        userId: owner.userId,
        metadata: {
          clientId: client.clientId,
          userId: grantee.userId,
          reason: "client_deleted",
        },
      },
      {
        entityType: "BrandingProfile",
        entityName: client.clientId,
        userId: owner.userId,
        metadata: {
          before: { appName: "Doomed", logo: image.objectId },
          after: null,
          reason: "client_deleted",
        },
      },
    ]);
    const [deleted] = await deliveries("auth.branding.deleted", profile.id);
    expect(deleted.payload).toMatchObject({
      data: { clientId: client.clientId },
    });
    const [revoked] = await deliveries("auth.branding.grant-revoked", grant.id);
    expect(revoked.payload).toMatchObject({
      data: {
        clientId: client.clientId,
        userId: grantee.userId,
        revokedBy: owner.userId,
      },
    });
    expect(await deleteAfter()).not.toBeNull();
  });

  it("writes no branding entries for a client without branding", async () => {
    const client = await createBrandingClient(owner.userId);
    clientIds.push(client.id);
    const response = await fetchJson(
      "DELETE",
      `${CORE_URL}/v1/admin/clients/${client.id}`,
      owner.token
    );
    expect(response.status).toBe(204);
    expect(
      await prisma.auditLogEntry.count({
        where: {
          entityType: { in: ["BrandingProfile", "BrandingGrant"] },
          entityName: client.clientId,
        },
      })
    ).toBe(0);
  });
});

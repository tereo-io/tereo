// @module-tag int
// @module-tag auth
// @module-tag audit
import { DEFAULT_ORGANIZATION_ID } from "../../../../../../../definitions/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../support/http.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../../support/webhooks.js";
import {
  BRANDING_URL,
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
} from "../../../../../../support/branding.js";

describe("/v1/admin/branding/clients/:id side effects", () => {
  let owner: Awaited<ReturnType<typeof brandingPrincipal>>;
  let endpointId: string;
  const clientIds: string[] = [];

  beforeAll(async () => {
    owner = await brandingPrincipal(["branding.write"]);
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.branding.updated", "auth.branding.deleted"] }
    );
    endpointId = endpoint.id;
  });

  afterAll(async () => {
    await deleteBrandingClients(clientIds);
  });

  // emitTx → core.outbox → reaper → fan-out creates the delivery.
  const deliveries = async (eventType: string, profileId: string) => {
    const where = {
      webhookEndpointId: endpointId,
      eventType,
      payload: { path: ["entityId"], equals: profileId },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) > 0,
      10_000
    );
    return await prisma.webhookDelivery.findMany({ where });
  };

  const audits = (profileId: string) =>
    prisma.auditLogEntry.findMany({
      where: { entityType: "BrandingProfile", entityId: profileId },
      orderBy: { createdAt: "asc" },
    });

  it("PUT writes one audit entry with before and after, and auth.branding.updated", async () => {
    const client = await createBrandingClient(owner.userId);
    clientIds.push(client.id);
    const url = `${BRANDING_URL}/clients/${client.id}`;

    expect(
      (await fetchJson("PUT", url, owner.token, { appName: "One" })).status
    ).toBe(200);
    const profile = await prisma.brandingProfile.findUniqueOrThrow({
      where: { clientId: client.id },
    });
    expect(
      (
        await fetchJson("PUT", url, owner.token, {
          appName: "Two",
          headline: "Hi",
        })
      ).status
    ).toBe(200);

    const entries = await audits(profile.id);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      action: "CREATE",
      userId: owner.userId,
      entityName: client.clientId,
      metadata: { before: null, after: { appName: "One" } },
    });
    expect(entries[1]).toMatchObject({
      action: "UPDATE",
      metadata: {
        before: { appName: "One", headline: null },
        after: { appName: "Two", headline: "Hi" },
      },
    });

    const events = await deliveries("auth.branding.updated", profile.id);
    expect(events.map((e) => (e.payload as { data: unknown }).data)).toEqual(
      expect.arrayContaining([
        { clientId: client.clientId, changedSlots: ["appName"] },
        { clientId: client.clientId, changedSlots: ["appName", "headline"] },
      ])
    );
  });

  it("DELETE writes an audit entry and auth.branding.deleted", async () => {
    const client = await createBrandingClient(owner.userId);
    clientIds.push(client.id);
    const url = `${BRANDING_URL}/clients/${client.id}`;
    await fetchJson("PUT", url, owner.token, { appName: "Bye" });
    const profile = await prisma.brandingProfile.findUniqueOrThrow({
      where: { clientId: client.id },
    });

    expect((await fetchJson("DELETE", url, owner.token)).status).toBe(204);

    const entries = await audits(profile.id);
    expect(entries.at(-1)).toMatchObject({
      action: "DELETE",
      metadata: { before: { appName: "Bye" }, after: null },
    });
    const [event] = await deliveries("auth.branding.deleted", profile.id);
    expect(event.payload).toMatchObject({
      entityType: "BrandingProfile",
      data: { clientId: client.clientId },
    });
  });
});

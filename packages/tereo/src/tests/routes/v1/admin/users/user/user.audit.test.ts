// @module-tag int
// @module-tag auth
// @module-tag audit

import { ensureDefaultOrganization } from "../../../../../../utils/defaultOrganization.js";
import { DEFAULT_ORGANIZATION_ID } from "../../../../../../definitions/index.js";
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { createTestUser } from "../../../../../support/auth/users.js";
import { BASE_URL } from "../../../../../support/auth/constants.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../support/webhooks.js";

describe("PATCH /v1/admin/users/:id", () => {
  let writer: string;
  let endpointId: string;

  beforeAll(async () => {
    await ensureDefaultOrganization();
    writer = await getTestPrincipalToken({ permissions: ["users.write"] });
    endpointId = (
      await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["auth.user.updated"] }
      )
    ).id;
  });

  const patch = (id: string, body: unknown) =>
    fetchJson("PATCH", `${BASE_URL}/v1/admin/users/${id}`, writer, body);

  const deliveries = (userId: string) =>
    prisma.webhookDelivery.findMany({
      where: {
        webhookEndpointId: endpointId,
        eventType: "auth.user.updated",
        payload: { path: ["entityId"], equals: userId },
      },
    });

  it.each([
    ["deactivating", true, false],
    ["reactivating", false, true],
  ])(
    "%s with a rename writes one audit entry and one auth.user.updated",
    async (_label, from, to) => {
      const user = await createTestUser({ isActive: from });
      const name = `Renamed ${user.id}`;

      const res = await patch(user.id, { isActive: to, name });
      expect(res.status).toBe(200);

      const entries = await prisma.auditLogEntry.findMany({
        where: { entityType: "User", entityId: user.id, action: "UPDATE" },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].changes).toMatchObject({
        isActive: { old: from, new: to },
        name: { old: user.name, new: name },
      });

      // Deliveries fan out in emission order: once a later change's is in,
      // the combined change's are too.
      const later = `${name} again`;
      await patch(user.id, { name: later });
      await waitFor(
        async () =>
          (await deliveries(user.id)).some((d) =>
            JSON.stringify(d.payload).includes(later)
          ),
        10_000
      );
      expect(await deliveries(user.id)).toHaveLength(2);
    }
  );
});

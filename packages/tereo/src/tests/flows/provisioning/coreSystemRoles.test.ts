// @module-tag int
// @module-tag provisioning
import { getTestPrincipalToken } from "../../support/principals.js";
import { CORE_SERVICE_ID } from "../../../definitions/index.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { fetchJson } from "../../support/http.js";
import { randomBytes } from "crypto";

const ROOT = CORE_URL;

let adminToken: string;

const rand = () => `x${randomBytes(5).toString("hex")}`;

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${ROOT}${path}`, token, body);

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({
    permissions: [
      "services.read",
      "services.write",
      "services.approve",
      "roles.read",
      "roles.write",
      // What the roles approved below grant: an approver grants only what
      // they hold.
      "webhooks.emit",
      "file-service.buckets.read",
      "file-service.objects.delete",
    ],
  });
});

describe("core", () => {
  it("keeps system roles read-only and lets admins duplicate them", async () => {
    const role = await prisma.role.findFirstOrThrow({
      where: { serviceId: CORE_SERVICE_ID, name: "webhook_publisher" },
    });
    expect(
      (
        await api("PATCH", `/v1/admin/roles/${role.id}`, adminToken, {
          displayName: "Renamed",
        })
      ).status
    ).toBe(403);
    expect(
      (
        await api("PUT", `/v1/admin/roles/${role.id}/permissions`, adminToken, {
          permissionIds: [],
        })
      ).status
    ).toBe(403);

    const copy = await api(
      "POST",
      `/v1/admin/roles/${role.id}/duplicate`,
      adminToken,
      {
        name: `publisher-copy-${rand()}`,
      }
    );
    expect(copy.status).toBe(201);
    expect(copy.body.isSystem).toBe(false);
    expect(copy.body.permissions.map((p: { name: string }) => p.name)).toEqual([
      "webhooks.emit",
    ]);
  });
});

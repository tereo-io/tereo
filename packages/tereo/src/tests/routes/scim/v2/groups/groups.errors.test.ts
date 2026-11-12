// @module-tag int
// @module-tag auth
import { ensureTestOrganization } from "../../../../support/principals.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tag } from "../../../../support/scimUsers.js";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createScimConnection,
  pushGroup,
  scimFetch,
  setGroupsTarget,
} from "../../../../support/scim.js";

describe("SCIM Groups errors", () => {
  it("is 403 on every route when groups are not enabled", async () => {
    const c = await createScimConnection();
    const id = randomUUID();
    for (const [method, path, body] of [
      ["GET", "/scim/v2/Groups", undefined],
      ["POST", "/scim/v2/Groups", { displayName: "x" }],
      ["GET", `/scim/v2/Groups/${id}`, undefined],
      ["DELETE", `/scim/v2/Groups/${id}`, undefined],
    ] as const) {
      const r = await scimFetch(c.token, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "403",
      });
    }
  });

  it("is 400 when the target organization is archived", async () => {
    const orgId = await ensureTestOrganization(`scim-arch-${tag()}`);
    const c = await createScimConnection({ organizationId: orgId });
    await setGroupsTarget(c.connectionId, {
      kind: "organization",
      organizationId: orgId,
    });
    await prisma.organization.update({
      where: { id: orgId },
      data: { archivedAt: new Date() },
    });
    const r = await pushGroup(c.token, { displayName: `A ${tag()}` });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ status: "400" });
  });

  it("rejects a missing, blank or 256-character displayName", async () => {
    const c = await createScimConnection();
    await setGroupsTarget(c.connectionId, { kind: "global" });
    for (const body of [
      {},
      { displayName: "   " },
      { displayName: "a".repeat(256) },
    ]) {
      const r = await scimFetch(c.token, "POST", "/scim/v2/Groups", body);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ scimType: "invalidValue" });
    }
  });

  it("rejects 1,001 members with tooMany", async () => {
    const c = await createScimConnection();
    await setGroupsTarget(c.connectionId, { kind: "global" });
    const members = Array.from({ length: 1001 }, () => ({
      value: randomUUID(),
    }));
    const displayName = `M ${tag()}`;
    const r = await pushGroup(c.token, { displayName, members });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ status: "400", scimType: "tooMany" });
    expect(await prisma.group.count({ where: { name: displayName } })).toBe(0);
    expect(
      await prisma.scimGroup.count({
        where: { connectionId: c.connectionId },
      })
    ).toBe(0);
  });
});

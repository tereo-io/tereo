// @module-tag int
// @module-tag auth

import { SYSTEM_USER_ID } from "../../../../../../../definitions/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../../support/http.js";
import { randomBytes } from "node:crypto";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../../support/principals.js";
import {
  createScimConnection,
  pushGroup,
  setGroupsTarget,
} from "../../../../../../support/scim.js";

const BASE = `${CORE_URL}/v1/admin/identity-providers`;

let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const newProvider = async () => {
  const id = randomBytes(5).toString("hex");
  return await prisma.identityProvider.create({
    data: {
      slug: `p-${id}`,
      displayName: "SCIM IdP",
      kind: "oidc",
      issuer: "https://idp.test",
      clientId: "c",
      clientSecret: "s",
      createdBy: SYSTEM_USER_ID,
    },
  });
};

const audit = (entityType: string, entityId: string, action: string) =>
  prisma.auditLogEntry.findFirstOrThrow({
    where: { entityType, entityId, action: action as "CREATE" },
  });

describe("/v1/admin/identity-providers/:id/scim", () => {
  it("is 404 before the connection exists", async () => {
    const provider = await newProvider();
    const res = await fetchJson(
      "GET",
      `${BASE}/${provider.id}/scim`,
      adminToken
    );
    expect(res.status).toBe(404);
  });

  it("creates the connection and reports its base URL", async () => {
    const provider = await newProvider();
    const put = await fetchJson(
      "PUT",
      `${BASE}/${provider.id}/scim`,
      adminToken,
      {
        isActive: true,
      }
    );
    expect(put.status).toBe(201);
    expect(put.body.baseUrl).toMatch(/\/scim\/v2$/);
    expect(put.body.isActive).toBe(true);
    expect(put.body.managedUserCount).toBe(0);
    expect(put.body.tokens).toEqual([]);

    const entry = await audit("ScimConnection", put.body.id, "CREATE");
    expect(entry.entityName).toBe("SCIM IdP");
  });

  it("sets isActive and a second create is a 200", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    await fetchJson("PUT", url, adminToken, { isActive: true });
    const off = await fetchJson("PUT", url, adminToken, { isActive: false });
    expect(off.status).toBe(200);
    const got = await fetchJson("GET", url, adminToken);
    expect(got.body.isActive).toBe(false);
    const entry = await audit("ScimConnection", got.body.id, "UPDATE");
    expect(entry.changes).toEqual({ isActive: { old: true, new: false } });
    const on = await fetchJson("PUT", url, adminToken, { isActive: true });
    expect(on.status).toBe(200);
    expect(on.body.isActive).toBe(true);
  });

  it("rejects a body without isActive", async () => {
    const provider = await newProvider();
    const res = await fetchJson(
      "PUT",
      `${BASE}/${provider.id}/scim`,
      adminToken,
      {}
    );
    expect(res.status).toBe(400);
  });

  it("a PUT with only groupsTarget leaves a disabled connection disabled and changes the target", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    await fetchJson("PUT", url, adminToken, { isActive: true });
    await fetchJson("PUT", url, adminToken, { isActive: false });
    const res = await fetchJson("PUT", url, adminToken, {
      groupsTarget: { kind: "global" },
    });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(res.body.groupsTarget).toEqual({ kind: "global" });
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        entityType: "ScimConnection",
        entityId: res.body.id,
        action: "UPDATE",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.changes).toEqual({
      groupsTarget: { old: { kind: "none" }, new: { kind: "global" } },
    });
  });

  it("rejects an unknown top-level key", async () => {
    const provider = await newProvider();
    const res = await fetchJson(
      "PUT",
      `${BASE}/${provider.id}/scim`,
      adminToken,
      { isActive: true, surprise: 1 }
    );
    expect(res.status).toBe(400);
  });

  it("deletes the connection and audits it", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    const put = await fetchJson("PUT", url, adminToken, { isActive: true });
    const del = await fetchJson("DELETE", url, adminToken);
    expect(del.status).toBe(204);
    expect((await fetchJson("GET", url, adminToken)).status).toBe(404);
    await audit("ScimConnection", put.body.id, "DELETE");
  });

  it("refuses to delete while it manages a user", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    const put = await fetchJson("PUT", url, adminToken, { isActive: true });
    const user = await prisma.user.create({
      data: {
        email: `u-${randomBytes(5).toString("hex")}@scim.test`,
        name: "U",
      },
    });
    await prisma.scimUser.create({
      data: {
        connectionId: put.body.id,
        userId: user.id,
        userName: user.email,
        userNameKey: user.email,
        idpActive: true,
        adminHold: false,
      },
    });
    const del = await fetchJson("DELETE", url, adminToken);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe("scim_users_exist");
    const got = await fetchJson("GET", url, adminToken);
    expect(got.body.managedUserCount).toBe(1);
  });

  it("counts deleted resources but not unlinked users, and deletes over only unlinked ones", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    const put = await fetchJson("PUT", url, adminToken, { isActive: true });
    const row = async (state: { deletedAt?: Date; unlinkedAt?: Date }) => {
      const user = await prisma.user.create({
        data: {
          email: `u-${randomBytes(5).toString("hex")}@scim.test`,
          name: "U",
        },
      });
      return await prisma.scimUser.create({
        data: {
          connectionId: put.body.id,
          userId: user.id,
          userName: user.email,
          userNameKey: user.email,
          idpActive: false,
          ...state,
        },
      });
    };
    const deleted = await row({ deletedAt: new Date() });
    await row({ unlinkedAt: new Date() });
    await row({ deletedAt: new Date(), unlinkedAt: new Date() });

    expect(
      (await fetchJson("GET", url, adminToken)).body.managedUserCount
    ).toBe(1);
    const refused = await fetchJson("DELETE", url, adminToken);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("scim_users_exist");

    await prisma.scimUser.update({
      where: { id: deleted.id },
      data: { unlinkedAt: new Date() },
    });
    expect((await fetchJson("DELETE", url, adminToken)).status).toBe(204);
    expect(
      await prisma.scimUser.count({ where: { connectionId: put.body.id } })
    ).toBe(0);
    expect((await fetchJson("GET", url, adminToken)).status).toBe(404);
  });

  it("is 404 for an unknown provider", async () => {
    const res = await fetchJson(
      "PUT",
      `${BASE}/00000000-0000-7000-8000-00000000dead/scim`,
      adminToken,
      { isActive: true }
    );
    expect(res.status).toBe(404);
  });

  it("reports a none target and no managed groups by default", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    const put = await fetchJson("PUT", url, adminToken, { isActive: true });
    expect(put.body.groupsTarget).toEqual({ kind: "none" });
    expect(put.body.managedGroupCount).toBe(0);
    const got = await fetchJson("GET", url, adminToken);
    expect(got.body.groupsTarget).toEqual({ kind: "none" });
    expect(got.body.managedGroupCount).toBe(0);
  });

  it("sets global and organization targets and audits old and new", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    await fetchJson("PUT", url, adminToken, { isActive: true });
    const organizationId = await ensureTestOrganization(
      `gt-${randomBytes(4).toString("hex")}`
    );

    const global = await fetchJson("PUT", url, adminToken, {
      isActive: true,
      groupsTarget: { kind: "global" },
    });
    expect(global.status).toBe(200);
    expect(global.body.groupsTarget).toEqual({ kind: "global" });

    const org = await fetchJson("PUT", url, adminToken, {
      isActive: false,
      groupsTarget: { kind: "organization", organizationId },
    });
    expect(org.status).toBe(200);
    expect(org.body.groupsTarget).toEqual({
      kind: "organization",
      organizationId,
    });
    const row = await prisma.scimConnection.findUniqueOrThrow({
      where: { id: org.body.id },
    });
    expect(row.groupsOrganizationId).toBe(organizationId);

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        entityType: "ScimConnection",
        entityId: org.body.id,
        action: "UPDATE",
      },
      orderBy: { createdAt: "asc" },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].changes).toEqual({
      groupsTarget: { old: { kind: "none" }, new: { kind: "global" } },
    });
    expect(entries[1].changes).toEqual({
      isActive: { old: true, new: false },
      groupsTarget: {
        old: { kind: "global" },
        new: { kind: "organization", organizationId },
      },
    });
  });

  it("writes no entry for a target equal to the stored one", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    const put = await fetchJson("PUT", url, adminToken, { isActive: true });
    await fetchJson("PUT", url, adminToken, {
      isActive: true,
      groupsTarget: { kind: "none" },
    });
    expect(
      await prisma.auditLogEntry.count({
        where: { entityId: put.body.id, action: "UPDATE" },
      })
    ).toBe(0);
  });

  it("rejects an unknown or archived organization", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    await fetchJson("PUT", url, adminToken, { isActive: true });
    const unknown = await fetchJson("PUT", url, adminToken, {
      isActive: true,
      groupsTarget: {
        kind: "organization",
        organizationId: "00000000-0000-7000-8000-00000000dead",
      },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("unknown_organization");

    const organizationId = await ensureTestOrganization(
      `gt-${randomBytes(4).toString("hex")}`
    );
    await prisma.organization.update({
      where: { id: organizationId },
      data: { isActive: false, archivedAt: new Date() },
    });
    const archived = await fetchJson("PUT", url, adminToken, {
      isActive: true,
      groupsTarget: { kind: "organization", organizationId },
    });
    expect(archived.status).toBe(400);
    expect(archived.body.error).toBe("unknown_organization");
  });

  it("rejects a malformed groups target", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    await fetchJson("PUT", url, adminToken, { isActive: true });
    const bodies = [
      { kind: "organization" },
      {
        kind: "global",
        organizationId: "00000000-0000-7000-8000-00000000dead",
      },
      { kind: "organization", organizationId: "nope" },
      { kind: "everyone" },
    ];
    for (const groupsTarget of bodies) {
      const res = await fetchJson("PUT", url, adminToken, {
        isActive: true,
        groupsTarget,
      });
      expect(res.status).toBe(400);
    }
  });

  it("pins the target to the scope of linked groups", async () => {
    const c = await createScimConnection();
    const url = `${BASE}/${c.providerId}/scim`;
    const other = await ensureTestOrganization(
      `gt-${randomBytes(4).toString("hex")}`
    );
    await setGroupsTarget(c.connectionId, {
      kind: "organization",
      organizationId: c.organizationId,
    });
    const pushed = await pushGroup(c.token, {
      displayName: `G ${randomBytes(4).toString("hex")}`,
    });
    expect(pushed.status).toBe(201);

    const put = (groupsTarget: unknown) =>
      fetchJson("PUT", url, adminToken, { isActive: true, groupsTarget });
    const toOther = await put({ kind: "organization", organizationId: other });
    expect(toOther.status).toBe(409);
    expect(toOther.body.error).toBe("scim_groups_exist");
    expect((await put({ kind: "global" })).status).toBe(409);

    const none = await put({ kind: "none" });
    expect(none.status).toBe(200);
    expect(none.body.managedGroupCount).toBe(1);
    const back = await put({
      kind: "organization",
      organizationId: c.organizationId,
    });
    expect(back.status).toBe(200);
    expect(back.body.groupsTarget).toEqual({
      kind: "organization",
      organizationId: c.organizationId,
    });
  });

  it("deletes a connection with linked groups and leaves them local", async () => {
    const c = await createScimConnection();
    await setGroupsTarget(c.connectionId, { kind: "global" });
    const pushed = await pushGroup(c.token, {
      displayName: `G ${randomBytes(4).toString("hex")}`,
    });
    expect(pushed.status).toBe(201);
    const member = await prisma.user.create({
      data: {
        email: `m-${randomBytes(5).toString("hex")}@scim.test`,
        name: "M",
      },
    });
    await prisma.groupMember.create({
      data: {
        groupId: pushed.body.id,
        userId: member.id,
        addedBy: member.id,
      },
    });
    await prisma.scimGroupSkippedMember.create({
      data: {
        scimGroupId: (
          await prisma.scimGroup.findUniqueOrThrow({
            where: { groupId: pushed.body.id },
          })
        ).id,
        userId: member.id,
        reason: "not_org_member",
      },
    });
    const second = await pushGroup(c.token, {
      displayName: `A ${randomBytes(4).toString("hex")}`,
    });
    expect(second.status).toBe(201);
    await prisma.group.update({
      where: { id: second.body.id },
      data: { archivedAt: new Date() },
    });

    const del = await fetchJson(
      "DELETE",
      `${BASE}/${c.providerId}/scim`,
      adminToken
    );
    expect(del.status).toBe(204);

    const group = await prisma.group.findUniqueOrThrow({
      where: { id: pushed.body.id },
      include: { members: true, scimLink: true },
    });
    expect(group.definitionSource).toBe("local");
    expect(group.membershipSource).toBe("local");
    expect(group.scimLink).toBeNull();
    expect(group.members.map((m) => m.userId)).toEqual([member.id]);
    await audit("ScimConnection", c.connectionId, "DELETE");
    const archived = await prisma.group.findUniqueOrThrow({
      where: { id: second.body.id },
      include: { scimLink: true },
    });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.definitionSource).toBe("local");
    expect(archived.scimLink).toBeNull();
    expect(
      await prisma.scimGroupSkippedMember.count({
        where: { userId: member.id },
      })
    ).toBe(0);
    for (const groupId of [pushed.body.id, second.body.id]) {
      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityId: groupId, entityType: "Group", action: "UPDATE" },
        orderBy: { createdAt: "desc" },
      });
      expect(entry.metadata).toMatchObject({
        action: "scim_unlinked",
        reason: "connection_deleted",
        scimConnectionId: c.connectionId,
      });
      const events = await prisma.outbox.findMany({
        where: { payload: { path: ["entityId"], equals: groupId } },
      });
      expect(JSON.stringify(events.map((e) => e.payload))).toContain(
        "auth.group.updated"
      );
    }
  });

  it("creates a connection with a groups target, audits it, and validates the organization", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    const organizationId = await ensureTestOrganization(
      `gt-${randomBytes(4).toString("hex")}`
    );
    const target = { kind: "organization", organizationId };
    const created = await fetchJson("PUT", url, adminToken, {
      isActive: true,
      groupsTarget: target,
    });
    expect(created.status).toBe(201);
    expect(created.body.groupsTarget).toEqual(target);
    const entry = await audit("ScimConnection", created.body.id, "CREATE");
    expect(entry.changes).toEqual({
      groupsTarget: { old: { kind: "none" }, new: target },
    });

    const other = await newProvider();
    const bad = await fetchJson("PUT", `${BASE}/${other.id}/scim`, adminToken, {
      isActive: true,
      groupsTarget: {
        kind: "organization",
        organizationId: "00000000-0000-7000-8000-00000000dead",
      },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("unknown_organization");
    expect(
      await prisma.scimConnection.count({ where: { providerId: other.id } })
    ).toBe(0);
  });
});

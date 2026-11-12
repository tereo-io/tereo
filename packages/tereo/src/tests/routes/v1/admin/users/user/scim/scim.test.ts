// @module-tag int
// @module-tag auth
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { makeUser, manage, tag } from "../../../../../../support/scimUsers.js";
import { createScimConnection } from "../../../../../../support/scim.js";
import { BASE_URL } from "../../../../../../support/auth/constants.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../support/http.js";
import { beforeAll, describe, expect, it } from "vitest";

const unlink = (id: string, token: string) =>
  fetchJson("DELETE", `${BASE_URL}/v1/admin/users/${id}/scim`, token);

const patch = (id: string, token: string, body: unknown) =>
  fetchJson("PATCH", `${BASE_URL}/v1/admin/users/${id}`, token, body);

let writer: string;
let reader: string;

beforeAll(async () => {
  writer = await getTestPrincipalToken({
    permissions: ["users.read", "users.write"],
  });
  reader = await getTestPrincipalToken({ permissions: ["users.read"] });
});

/** A user the IdP deactivated and deleted. */
const deletedManagedUser = async () => {
  const c = await createScimConnection();
  const user = await makeUser(`m-${tag()}@${c.domain}`, { isActive: false });
  const link = await manage(c.connectionId, user.id, user.email, {
    deletedAt: new Date(),
  });
  await prisma.scimUser.update({
    where: { id: link.id },
    data: { idpActive: false },
  });
  return { c, user, link };
};

describe("DELETE /v1/admin/users/:id/scim", () => {
  it("keeps the row as an exclusion, with an audit entry, and leaves the user as is", async () => {
    const { c, user, link } = await deletedManagedUser();
    await prisma.scimUser.update({
      where: { id: link.id },
      data: { externalId: `ext-${tag()}` },
    });
    const r = await unlink(user.id, writer);
    expect(r.status).toBe(204);
    const row = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(row.unlinkedAt).not.toBeNull();
    expect(row.externalId).toBeNull();
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    ).toEqual(user);
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        entityType: "User",
        entityId: user.id,
        metadata: { path: ["action"], equals: "scim_unlinked" },
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "UPDATE",
      metadata: { scimConnectionId: c.connectionId, providerId: c.providerId },
    });
  });

  it("needs users.write", async () => {
    const { user } = await deletedManagedUser();
    expect((await unlink(user.id, reader)).status).toBe(403);
    expect(await prisma.scimUser.count({ where: { userId: user.id } })).toBe(1);
  });

  it("answers 404 for a user with no link", async () => {
    const user = await makeUser(`u-${tag()}@unmanaged.test`);
    expect((await unlink(user.id, writer)).status).toBe(404);
  });

  it("answers 404 for a user already unlinked, and writes nothing", async () => {
    const { user } = await deletedManagedUser();
    expect((await unlink(user.id, writer)).status).toBe(204);
    const before = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect((await unlink(user.id, writer)).status).toBe(404);
    expect(
      await prisma.scimUser.findUniqueOrThrow({ where: { userId: user.id } })
    ).toEqual(before);
  });

  it("shows the user as excluded from SCIM rather than managed", async () => {
    const { c, user } = await deletedManagedUser();
    const get = () =>
      fetchJson("GET", `${BASE_URL}/v1/admin/users/${user.id}`, writer);
    const managed = await get();
    expect(managed.body.managedBy).toMatchObject({
      kind: "scim",
      id: c.providerId,
    });
    expect(managed.body.scimExcluded).toBeNull();
    await unlink(user.id, writer);
    const excluded = await get();
    expect(excluded.body.managedBy).toBeNull();
    expect(excluded.body.scimExcluded).toEqual({
      id: c.providerId,
      name: "SCIM IdP",
    });
  });

  it("lets the admin rename and reactivate the user afterwards", async () => {
    const { user } = await deletedManagedUser();
    expect((await patch(user.id, writer, { name: "Local" })).status).toBe(409);
    expect((await unlink(user.id, writer)).status).toBe(204);
    const r = await patch(user.id, writer, { name: "Local", isActive: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "Local", isActive: true });
    const row = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect((await patch(user.id, writer, { isActive: false })).status).toBe(
      200
    );
    expect(
      await prisma.scimUser.findUniqueOrThrow({ where: { userId: user.id } })
    ).toEqual(row);
    const managedBy = await fetchJson(
      "GET",
      `${BASE_URL}/v1/admin/users/${user.id}`,
      writer
    );
    expect(managedBy.body.managedBy).toBeNull();
  });
});

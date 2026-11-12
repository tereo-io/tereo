// @module-tag int
// @module-tag auth
import { getTestPrincipalToken } from "../../../../../../../support/principals.js";
import { createScimConnection } from "../../../../../../../support/scim.js";
import { BASE_URL } from "../../../../../../../support/auth/constants.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../../support/http.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  makeUser,
  manage,
  tag,
} from "../../../../../../../support/scimUsers.js";

const release = (id: string, token: string) =>
  fetchJson("PUT", `${BASE_URL}/v1/admin/users/${id}/scim/release`, token);

let admin: string;
let writer: string;
let reader: string;

beforeAll(async () => {
  admin = await getTestPrincipalToken({ permissions: ["admin"] });
  writer = await getTestPrincipalToken({
    permissions: ["users.read", "users.write"],
  });
  reader = await getTestPrincipalToken({ permissions: ["users.read"] });
});

const excludedUser = async () => {
  const c = await createScimConnection();
  const user = await makeUser(`x-${tag()}@${c.domain}`);
  await manage(c.connectionId, user.id, user.email, { unlinkedAt: new Date() });
  return { c, user };
};

const rows = (userId: string) => prisma.scimUser.count({ where: { userId } });

describe("PUT /v1/admin/users/:id/scim/release", () => {
  it("removes the exclusion with an audit entry", async () => {
    const { c, user } = await excludedUser();
    const r = await release(user.id, admin);
    expect(r.status).toBe(204);
    expect(await rows(user.id)).toBe(0);
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        entityType: "User",
        entityId: user.id,
        metadata: { path: ["action"], equals: "scim_released" },
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "UPDATE",
      metadata: { scimConnectionId: c.connectionId, providerId: c.providerId },
    });
  });

  it("answers 404 for a user with no row or a managed one", async () => {
    const free = await makeUser(`u-${tag()}@unmanaged.test`);
    expect((await release(free.id, admin)).status).toBe(404);
    const c = await createScimConnection();
    const managed = await makeUser(`m-${tag()}@${c.domain}`);
    await manage(c.connectionId, managed.id, managed.email);
    expect((await release(managed.id, admin)).status).toBe(404);
    expect(await rows(managed.id)).toBe(1);
  });

  it("needs a global admin on top of users.write", async () => {
    const { user } = await excludedUser();
    expect((await release(user.id, reader)).status).toBe(403);
    expect((await release(user.id, writer)).status).toBe(403);
    expect(await rows(user.id)).toBe(1);
  });
});

// @module-tag int
// @module-tag auth
import { createTestClient } from "../../../../../support/auth/clients.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  REDIRECT_URI,
  sessionLifecycleHelpers,
} from "../../../../../support/auth/sessionLifecycle.js";
import {
  makeUser,
  manage,
  signedInManagedUser,
  tag,
} from "../../../../../support/scimUsers.js";
import {
  createScimConnection,
  scimFetch,
} from "../../../../../support/scim.js";

let client: Awaited<ReturnType<typeof createTestClient>>;
const { login, refresh } = sessionLifecycleHelpers(() => client);

beforeAll(async () => {
  client = await createTestClient({ redirectUris: [REDIRECT_URI] });
});

const del = (token: string, id: string) =>
  scimFetch(token, "DELETE", `/scim/v2/Users/${id}`);

const managedUser = async (
  c: { connectionId: string; domain: string },
  opts: { isActive?: boolean } = {}
) => {
  const user = await makeUser(`m-${tag()}@${c.domain}`, opts);
  const link = await manage(c.connectionId, user.id, user.email);
  if (opts.isActive === false) {
    await prisma.scimUser.update({
      where: { id: link.id },
      data: { idpActive: false },
    });
  }
  return user;
};

const withLink = (id: string) =>
  prisma.user.findUnique({ where: { id }, include: { scimLink: true } });

describe("DELETE /scim/v2/Users/:id", () => {
  it("answers 204, deactivates, and keeps the user and link rows", async () => {
    const c = await createScimConnection();
    const user = await managedUser(c);
    const { status, body } = await del(c.token, user.id);
    expect(status).toBe(204);
    expect(body).toBeNull();

    const after = await withLink(user.id);
    expect(after).toMatchObject({
      isActive: false,
      scimLink: { idpActive: false, adminHold: false },
    });
    expect(after?.scimLink?.deletedAt).toBeInstanceOf(Date);

    const entries = await prisma.auditLogEntry.findMany({
      where: { entityType: "User", entityId: user.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      changes: { isActive: { old: true, new: false } },
      metadata: { action: "scim_deleted", scimConnectionId: c.connectionId },
    });
  });

  it("refuses a refresh token issued before the DELETE", async () => {
    const c = await createScimConnection();
    const { user, tokens } = await signedInManagedUser(c, login);
    expect((await del(c.token, user.id)).status).toBe(204);
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
  });

  it("then answers 404 to GET and to a second DELETE", async () => {
    const c = await createScimConnection();
    const user = await managedUser(c);
    expect((await del(c.token, user.id)).status).toBe(204);
    expect(
      (await scimFetch(c.token, "GET", `/scim/v2/Users/${user.id}`)).status
    ).toBe(404);
    const again = await del(c.token, user.id);
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject({ status: "404" });
  });

  it("deletes an inactive user with one entry and no state change", async () => {
    const c = await createScimConnection();
    const user = await managedUser(c, { isActive: false });
    expect((await del(c.token, user.id)).status).toBe(204);
    const after = await withLink(user.id);
    expect(after).toMatchObject({
      isActive: false,
      scimLink: { idpActive: false },
    });
    expect(after?.scimLink?.deletedAt).toBeInstanceOf(Date);
    const entries = await prisma.auditLogEntry.findMany({
      where: { entityType: "User", entityId: user.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toMatchObject({ action: "scim_deleted" });
  });

  it("adopts an unmanaged visible user, then deletes them", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`free-${tag()}@${c.domain}`);
    expect((await del(c.token, user.id)).status).toBe(204);
    const after = await withLink(user.id);
    expect(after).toMatchObject({
      isActive: false,
      scimLink: {
        connectionId: c.connectionId,
        idpActive: false,
        adminHold: false,
      },
    });
    expect(after?.scimLink?.deletedAt).toBeInstanceOf(Date);
  });

  it("answers 404 for a user the connection cannot see, changing nothing", async () => {
    const c = await createScimConnection();
    const other = await createScimConnection();
    const theirs = await managedUser(other);
    const outside = await makeUser(`x-${tag()}@outside-${tag()}.test`);
    for (const u of [theirs, outside]) {
      const before = await withLink(u.id);
      expect((await del(c.token, u.id)).status).toBe(404);
      expect(await withLink(u.id)).toEqual(before);
    }
  });
});

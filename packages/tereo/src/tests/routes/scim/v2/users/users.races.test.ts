// @module-tag int
// @module-tag auth
// @module-tag race
import { createScimConnection, scimFetch } from "../../../../support/scim.js";
import { holdLocks, waitForLockWait } from "../../../../support/dbLocks.js";
import { oktaCreateUser } from "../../../../fixtures/scim/okta.js";
import { makeUser, tag } from "../../../../support/scimUsers.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, expect, it } from "vitest";

const body = (email: string) => ({
  ...oktaCreateUser,
  userName: email,
  emails: [{ primary: true, type: "work", value: email }],
});

const post = (token: string, email: string) =>
  scimFetch(token, "POST", "/scim/v2/Users", body(email));

describe("POST /scim/v2/Users races", () => {
  it("creates one user from two concurrent POSTs for a new email", async () => {
    const c = await createScimConnection();
    const email = `race-${tag()}@${c.domain}`;
    const results = await Promise.all([
      post(c.token, email),
      post(c.token, email),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const conflict = results.find((r) => r.status === 409);
    expect(conflict?.body).toMatchObject({ scimType: "uniqueness" });
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it("links an existing user once from two concurrent adoptions", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`race-${tag()}@${c.domain}`);
    const results = await Promise.all([
      post(c.token, user.email),
      post(c.token, user.email),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.scimUser.count({ where: { userId: user.id } })).toBe(1);
    const adopted = await prisma.auditLogEntry.count({
      where: {
        entityId: user.id,
        metadata: { path: ["action"], equals: "scim_adopted" },
      },
    });
    expect(adopted).toBe(1);
  });

  it("refuses an adoption when the user's email changed while it waited for the lock", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`moving-${tag()}@${c.domain}`);
    const moved = `moved-${tag()}@${c.domain}`;
    const release = await holdLocks((tx) =>
      tx.user.update({ where: { id: user.id }, data: { email: moved } })
    );
    const pending = post(c.token, user.email);
    await waitForLockWait("%FOR UPDATE%");
    await release();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ scimType: "uniqueness" });
    expect(await prisma.scimUser.count({ where: { userId: user.id } })).toBe(0);
  });
});

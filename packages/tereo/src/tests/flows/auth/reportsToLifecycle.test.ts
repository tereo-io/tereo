// @module-tag int
// @module-tag auth
import { createScimConnection, scimFetch } from "../../support/scim.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestGuest } from "../../support/auth/guests.js";
import { createTestUser } from "../../support/auth/users.js";
import { oktaCreateUser } from "../../fixtures/scim/okta.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { prisma } from "../../../utils/db/prisma.js";
import { fetchJson } from "../../support/http.js";
import { tag } from "../../support/scimUsers.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../support/principals.js";

const userIds: string[] = [];
let admin: string;

const call = (method: string, path: string, body?: unknown) =>
  fetchJson(method, `${BASE_URL}/v1/admin/users/${path}`, admin, body);

const reportsToIdOf = async (id: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id } })).reportsToId;
const directReportsOf = async (id: string) =>
  (
    await prisma.user.findMany({
      where: { reportsToId: id },
      select: { id: true },
    })
  )
    .map((u) => u.id)
    .sort();

beforeAll(async () => {
  admin = await getTestPrincipalToken({
    permissions: ["users.read", "users.write", "users.reports.write"],
  });
});

afterAll(async () => {
  await prisma.user.updateMany({
    where: { id: { in: userIds } },
    data: { reportsToId: null },
  });
});

describe("reports-to across the user lifecycle", () => {
  it("deactivation, reactivation, SCIM DELETE and guest promotion keep every link", async () => {
    const above = (await createTestUser()).id;
    const a = (await createTestUser()).id;
    const b = (await createTestUser()).id;
    const c = await createScimConnection();
    const email = `rt-${tag()}@${c.domain}`;
    const scim = await scimFetch(c.token, "POST", "/scim/v2/Users", {
      ...oktaCreateUser,
      userName: email,
      emails: [{ primary: true, type: "work", value: email }],
      externalId: `ext-${tag()}`,
    });
    expect(scim.status).toBe(201);
    const managed = scim.body.id as string;
    const { user: guest } = await createTestGuest({
      organizationId: await ensureTestOrganization("reports-to-lifecycle"),
    });
    userIds.push(above, a, b, managed, guest.id);

    for (const [id, to] of [
      [b, above],
      [a, b],
      [managed, b],
      [guest.id, b],
    ]) {
      expect(
        (await call("PUT", `${id}/reports-to`, { userId: to })).status
      ).toBe(200);
    }
    const reportsOfB = [a, managed, guest.id].sort();
    const unchanged = async () => {
      expect(await reportsToIdOf(a)).toBe(b);
      expect(await reportsToIdOf(b)).toBe(above);
      expect(await directReportsOf(b)).toEqual(reportsOfB);
    };

    for (const id of [a, b]) {
      expect((await call("PATCH", id, { isActive: false })).status).toBe(200);
      await unchanged();
    }
    for (const id of [a, b]) {
      expect((await call("PATCH", id, { isActive: true })).status).toBe(200);
      await unchanged();
    }

    const deleted = await scimFetch(
      c.token,
      "DELETE",
      `/scim/v2/Users/${managed}`
    );
    expect(deleted.status).toBe(204);
    expect(await reportsToIdOf(managed)).toBe(b);
    await unchanged();

    expect((await call("POST", `${guest.id}/promote`)).status).toBe(200);
    expect(await reportsToIdOf(guest.id)).toBe(b);
    await unchanged();
  });
});

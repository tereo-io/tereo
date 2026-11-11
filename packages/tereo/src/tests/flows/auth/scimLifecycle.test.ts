// @module-tag int
// @module-tag auth
import { createScimConnection, scimFetch } from "../../support/scim.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { oktaCreateUser } from "../../fixtures/scim/okta.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { fetchJson } from "../../support/http.js";
import { tag } from "../../support/scimUsers.js";

const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

let admin: string;

beforeAll(async () => {
  admin = await getTestPrincipalToken({
    permissions: ["users.read", "users.write"],
  });
});

const createBody = (email: string) => ({
  ...oktaCreateUser,
  userName: email,
  emails: [{ primary: true, type: "work", value: email }],
  externalId: `ext-${tag()}`,
});

const setActive = (token: string, id: string, active: boolean) =>
  scimFetch(token, "PATCH", `/scim/v2/Users/${id}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "replace", path: "active", value: active }],
  });

const adminPatch = (id: string, body: unknown) =>
  fetchJson("PATCH", `${BASE_URL}/v1/admin/users/${id}`, admin, body);

const state = async (userId: string) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { scimLink: true },
  });
  const link = user.scimLink;
  // users.is_active = idp_active AND NOT admin_hold, after every step.
  expect(user.isActive).toBe(
    link !== null && link.idpActive && !link.adminHold
  );
  return {
    isActive: user.isActive,
    idpActive: link?.idpActive,
    adminHold: link?.adminHold,
    deleted: link?.deletedAt !== null,
  };
};

describe("SCIM user lifecycle", () => {
  it("create, deactivate, delete, then POST again revives and reactivates", async () => {
    const c = await createScimConnection();
    const email = `life-${tag()}@${c.domain}`;
    const body = createBody(email);

    const created = await scimFetch(c.token, "POST", "/scim/v2/Users", body);
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(await state(id)).toMatchObject({ isActive: true, deleted: false });

    expect((await setActive(c.token, id, false)).status).toBe(200);
    expect(await state(id)).toMatchObject({
      isActive: false,
      idpActive: false,
    });

    const deleted = await scimFetch(c.token, "DELETE", `/scim/v2/Users/${id}`);
    expect(deleted.status).toBe(204);
    expect(await state(id)).toMatchObject({ isActive: false, deleted: true });

    const revived = await scimFetch(c.token, "POST", "/scim/v2/Users", body);
    expect(revived.status).toBe(201);
    expect(revived.body).toMatchObject({ id, active: true });
    expect(await state(id)).toMatchObject({
      isActive: true,
      idpActive: true,
      adminHold: false,
      deleted: false,
    });
  });

  it("a revive without active reactivates, unless an admin holds the user", async () => {
    const c = await createScimConnection();
    const revive = async (hold: boolean) => {
      const body = createBody(`rev-${tag()}@${c.domain}`);
      const { active: _, ...withoutActive } = body;
      const created = await scimFetch(c.token, "POST", "/scim/v2/Users", body);
      const id = created.body.id as string;
      if (hold) {
        expect((await adminPatch(id, { isActive: false })).status).toBe(200);
      }
      const del = await scimFetch(c.token, "DELETE", `/scim/v2/Users/${id}`);
      expect(del.status).toBe(204);
      const again = await scimFetch(
        c.token,
        "POST",
        "/scim/v2/Users",
        withoutActive
      );
      expect(again.status).toBe(201);
      expect(again.body).toMatchObject({ id, active: !hold });
      return await state(id);
    };
    expect(await revive(false)).toMatchObject({
      isActive: true,
      idpActive: true,
      deleted: false,
    });
    expect(await revive(true)).toMatchObject({
      isActive: false,
      idpActive: true,
      adminHold: true,
      deleted: false,
    });
  });

  it("creates a user inactive when the IdP says active:false", async () => {
    const c = await createScimConnection();
    const email = `off-${tag()}@${c.domain}`;
    const created = await scimFetch(c.token, "POST", "/scim/v2/Users", {
      ...createBody(email),
      active: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.active).toBe(false);
    expect(await state(created.body.id as string)).toMatchObject({
      isActive: false,
      idpActive: false,
      adminHold: false,
    });
  });

  it("an admin hold survives a later active:true and lifts on admin reactivation", async () => {
    const c = await createScimConnection();
    const email = `hold-${tag()}@${c.domain}`;
    const created = await scimFetch(
      c.token,
      "POST",
      "/scim/v2/Users",
      createBody(email)
    );
    const id = created.body.id as string;

    expect((await adminPatch(id, { isActive: false })).status).toBe(200);
    expect(await state(id)).toMatchObject({
      isActive: false,
      idpActive: true,
      adminHold: true,
    });

    const again = await setActive(c.token, id, true);
    expect(again.status).toBe(200);
    expect(again.body.active).toBe(false);
    expect(await state(id)).toMatchObject({ isActive: false, adminHold: true });

    // The IdP turns them off and on again: still held.
    expect((await setActive(c.token, id, false)).status).toBe(200);
    expect((await adminPatch(id, { isActive: true })).body).toMatchObject({
      error: "managed_by_scim",
    });
    expect((await setActive(c.token, id, true)).body.active).toBe(false);

    const lifted = await adminPatch(id, { isActive: true });
    expect(lifted.status).toBe(200);
    expect(await state(id)).toMatchObject({
      isActive: true,
      idpActive: true,
      adminHold: false,
    });
  });
});

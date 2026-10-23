// @module-tag int
// @module-tag auth

import { createTestRole, createTestUser } from "../../support/auth/users.js";
import { TEST_SERVICE, makeServiceOf } from "../../support/testService.js";
import { createTestClient } from "../../support/auth/clients.js";
import { generateUniqueId } from "../../support/auth/crypto.js";
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestOrganization,
  ensureTestUser,
  getTestPrincipalToken,
} from "../../support/principals.js";

const userRef = (user: { id: string; email: string; name: string | null }) => ({
  id: user.id,
  email: user.email,
  name: user.name,
});

const ORG = "embedded-refs-org";

describe("Admin responses name the ids they return", () => {
  let adminId: string;
  let adminToken: string;
  let admin: { id: string; email: string; name: string | null };

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await axios.request({
      method,
      url: `${BASE_URL}${path}`,
      headers: { Authorization: `Bearer ${adminToken}` },
      data: body,
      validateStatus: () => true,
    });
    return { status: res.status, body: res.data };
  };

  beforeAll(async () => {
    adminId = randomUUID();
    adminToken = await getTestPrincipalToken({
      userId: adminId,
      permissions: ["admin"],
    });
    admin = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
  });

  describe("roles", () => {
    it("embed the declaring service of a system role, and null for a custom one", async () => {
      const system = await createTestRole({ isSystem: true });
      const custom = await createTestRole();

      const got = await api("GET", `/v1/admin/roles/${system.id}`);
      expect(got.status).toBe(200);
      expect(got.body.serviceId).toBe(TEST_SERVICE.id);
      expect(got.body.service).toEqual({
        id: TEST_SERVICE.id,
        slug: TEST_SERVICE.slug,
        name: TEST_SERVICE.name,
      });
      expect(
        (await api("GET", `/v1/admin/roles/${custom.id}`)).body.service
      ).toBe(null);

      const listed = await api(
        "GET",
        `/v1/admin/roles?filter[name]=${system.name}&filter[name_op]=equals`
      );
      expect(listed.body.data).toHaveLength(1);
      expect(listed.body.data[0].service).toMatchObject({
        slug: TEST_SERVICE.slug,
      });

      const created = await api("POST", "/v1/admin/roles", {
        name: `embedded-${generateUniqueId()}`,
        displayName: "Embedded",
      });
      expect(created.status).toBe(201);
      expect(created.body.service).toBeNull();
    });

    it("name the organization each assignment is scoped to", async () => {
      const role = await createTestRole();
      const user = await createTestUser();
      const organizationId = await ensureTestOrganization(ORG);
      await prisma.userRole.createMany({
        data: [
          { userId: user.id, roleId: role.id },
          { userId: user.id, roleId: role.id, organizationId },
        ],
      });

      const res = await api("GET", `/v1/admin/roles/${role.id}/users`);
      expect(res.status).toBe(200);
      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      const scoped = res.body.users.find(
        (u: { organizationId: string | null }) => u.organizationId
      );
      const global = res.body.users.find(
        (u: { organizationId: string | null }) => !u.organizationId
      );
      expect(scoped.organization).toEqual({
        id: org.id,
        name: org.name,
        slug: org.slug,
      });
      expect(global.organization).toBeNull();
    });
  });

  describe("services", () => {
    it("embed the service-account user and the creator", async () => {
      const id = generateUniqueId();
      const created = await api("POST", "/v1/admin/services", {
        name: `Refs ${id} Service`,
      });
      expect(created.status).toBe(201);
      const account = await prisma.user.findUniqueOrThrow({
        where: { id: created.body.serviceAccountUserId },
      });
      expect(created.body.serviceAccountUser).toEqual(userRef(account));
      expect(created.body.creator).toEqual(userRef(admin));
      expect(created.body.createdBy).toBe(adminId);

      const got = await api("GET", `/v1/admin/services/${created.body.id}`);
      expect(got.body.serviceAccountUser).toEqual(userRef(account));
      expect(got.body.creator).toEqual(userRef(admin));

      const listed = await api(
        "GET",
        `/v1/admin/services?filter[slug]=${created.body.slug}`
      );
      expect(listed.status).toBe(200);
      expect(listed.body.data).toHaveLength(1);
      expect(listed.body.data[0].serviceAccountUser).toEqual(userRef(account));
      expect(listed.body.data[0].creator).toEqual(userRef(admin));
    });
  });

  describe("clients", () => {
    it("expose the organization, and every write returns the relations a read does", async () => {
      const created = await api("POST", "/v1/admin/clients", {
        name: `Refs ${generateUniqueId()}`,
        clientType: "confidential",
        grantTypes: ["authorization_code"],
        redirectUris: ["https://example.com/callback"],
      });
      expect(created.status).toBe(201);
      expect(created.body.clientSecret).toEqual(expect.any(String));
      expect(created.body.owner).toMatchObject(userRef(admin));
      expect(created.body.service).toBeNull();
      expect(created.body.organizationId).toBeNull();
      expect(created.body.organization).toBeNull();

      const organizationId = await ensureTestOrganization(ORG);
      await prisma.oAuthClient.update({
        where: { id: created.body.id },
        data: { organizationId },
      });
      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      const orgRef = { id: org.id, name: org.name, slug: org.slug };

      const got = await api("GET", `/v1/admin/clients/${created.body.id}`);
      expect(got.body.organizationId).toBe(organizationId);
      expect(got.body.organization).toEqual(orgRef);

      const patched = await api(
        "PATCH",
        `/v1/admin/clients/${created.body.id}`,
        {
          name: "Renamed",
        }
      );
      expect(patched.status).toBe(200);
      expect(patched.body.organization).toEqual(orgRef);
      expect(patched.body.owner).toEqual(got.body.owner);
      expect(patched.body.serviceAccountUser).toEqual(
        got.body.serviceAccountUser
      );
      expect(patched.body.service).toBeNull();

      const regenerated = await api(
        "POST",
        `/v1/admin/clients/${created.body.id}/regenerate-secret`
      );
      expect(regenerated.status).toBe(200);
      expect(regenerated.body.clientSecret).toEqual(expect.any(String));
      expect(regenerated.body.organization).toEqual(orgRef);
      expect(regenerated.body.owner).toEqual(got.body.owner);
      expect(regenerated.body.serviceAccountUser).toEqual(
        got.body.serviceAccountUser
      );

      const listed = await api(
        "GET",
        `/v1/admin/clients?filter[clientId]=${created.body.clientId}`
      );
      expect(listed.body.data[0].organization).toEqual(orgRef);
    });

    it("name the service-account user on update and regenerate-secret", async () => {
      const client = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
      });
      const account = await prisma.user.findFirstOrThrow({
        where: { oauthClientId: client.id },
      });
      const expected = { ...userRef(account), userType: "service_account" };

      const patched = await api("PATCH", `/v1/admin/clients/${client.id}`, {
        name: "Renamed",
      });
      expect(patched.status).toBe(200);
      expect(patched.body.serviceAccountUser).toEqual(expected);
      expect(patched.body.owner).toMatchObject({ id: client.ownerId });

      const regenerated = await api(
        "POST",
        `/v1/admin/clients/${client.id}/regenerate-secret`
      );
      expect(regenerated.status).toBe(200);
      expect(regenerated.body.serviceAccountUser).toEqual(expected);
    });

    it("name a service's client's service", async () => {
      const client = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
      });
      const slug = await makeServiceOf(client.id);
      const got = await api("GET", `/v1/admin/clients/${client.id}`);
      expect(got.body.service).toMatchObject({ slug, name: slug });
    });
  });

  describe("users by id", () => {
    it("lists the users of a set of ids in one request", async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of ids) await ensureTestUser(id);

      const res = await api(
        "GET",
        `/v1/admin/users?filter[id]=${ids.join(",")}&filter[id_op]=in&limit=${ids.length}`
      );
      expect(res.status).toBe(200);
      expect(res.body.data.map((u: { id: string }) => u.id).sort()).toEqual(
        [...ids].sort()
      );

      const one = await api("GET", `/v1/admin/users?filter[id]=${ids[0]}`);
      expect(one.body.data.map((u: { id: string }) => u.id)).toEqual([ids[0]]);
    });

    it("refuses more than 100 ids, or one that is not a UUID", async () => {
      const ids = Array.from({ length: 101 }, () => randomUUID());
      const tooMany = await api(
        "GET",
        `/v1/admin/users?filter[id]=${ids.join(",")}&filter[id_op]=in`
      );
      expect(tooMany.status).toBe(400);
      expect(tooMany.body.error).toBe("invalid_request");
      expect(tooMany.body.error_description).toMatch(
        /^Invalid request query\. /
      );

      const bad = await api(
        "GET",
        `/v1/admin/users?filter[id]=${SYSTEM_USER_ID},nope&filter[id_op]=in`
      );
      expect(bad.status).toBe(400);
    });
  });
});

// @module-tag int
// @module-tag auth

import { BASE_URL, HTTP_STATUS } from "../../support/auth/constants.js";
import { createTestClient } from "../../support/auth/clients.js";
import { makeServiceOf } from "../../support/testService.js";
import { browserLogin } from "../../support/browserLogin.js";
import { LOGIN_CLIENT } from "../../../definitions/index.js";
import { describe, it, expect, beforeAll } from "vitest";
import { decodeJwt } from "../../support/auth/tokens.js";
import { prisma } from "../../../utils/db/prisma.js";
import {
  checkUserPermission,
  getAccessTokenForUser,
} from "../../support/auth/login.js";
import {
  createTestUser,
  createAdminUser,
  createTestRole,
  createTestPermission,
} from "../../support/auth/users.js";

let adminToken: string;

beforeAll(async () => {
  const adminUser = await createAdminUser();
  // Through core's UI: a delegated token could not grant the test
  // service's permissions, which no core scope's ceiling covers.
  adminToken = await getAccessTokenForUser(
    adminUser,
    await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: LOGIN_CLIENT.clientId },
    }),
    "openid profile email"
  );
});

describe("permission resolution across the role archive lifecycle", () => {
  it("should stop granting when the role is archived and stay excluded after restore until reactivated", async () => {
    const resolutionClient = await createTestClient({
      clientType: "confidential",
    });
    // check-permission answers a client of no organization only if it is a
    // service's.
    await makeServiceOf(resolutionClient.id);
    const user = await createTestUser();
    const role = await createTestRole();
    const permission = await createTestPermission();
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });

    expect(
      await checkUserPermission(resolutionClient, user.id, permission.name)
    ).toBe(true);

    // Deactivate: resolution excludes inactive roles
    const deactivate = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isActive: false }),
    });
    expect(deactivate.status).toBe(HTTP_STATUS.OK);
    expect(
      await checkUserPermission(resolutionClient, user.id, permission.name)
    ).toBe(false);

    // Archive: still excluded
    const archive = await fetch(
      `${BASE_URL}/v1/admin/roles/${role.id}/archive`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    expect(archive.status).toBe(HTTP_STATUS.NO_CONTENT);
    expect(
      await checkUserPermission(resolutionClient, user.id, permission.name)
    ).toBe(false);

    // Restore: comes back deactivated, so STILL excluded
    const restore = await fetch(
      `${BASE_URL}/v1/admin/roles/${role.id}/restore`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    expect(restore.status).toBe(HTTP_STATUS.OK);
    expect(
      await checkUserPermission(resolutionClient, user.id, permission.name)
    ).toBe(false);

    // Explicit reactivation brings the grant back
    const reactivate = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isActive: true }),
    });
    expect(reactivate.status).toBe(HTTP_STATUS.OK);
    expect(
      await checkUserPermission(resolutionClient, user.id, permission.name)
    ).toBe(true);
  });

  it("should stop granting permanently after role hard delete", async () => {
    const resolutionClient = await createTestClient({
      clientType: "confidential",
    });
    // check-permission answers a client of no organization only if it is a
    // service's.
    await makeServiceOf(resolutionClient.id);
    const user = await createTestUser();
    const role = await createTestRole();
    const permission = await createTestPermission();
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });

    expect(
      await checkUserPermission(resolutionClient, user.id, permission.name)
    ).toBe(true);

    const deleteResponse = await fetch(
      `${BASE_URL}/v1/admin/roles/${role.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    expect(deleteResponse.status).toBe(HTTP_STATUS.NO_CONTENT);

    expect(
      await checkUserPermission(resolutionClient, user.id, permission.name)
    ).toBe(false);
  });
});

describe("a human's access after the role changes", () => {
  const REDIRECT_URI = "http://localhost:3000/role-change-callback";

  const login = async () => {
    const client = await createTestClient({ redirectUris: [REDIRECT_URI] });
    const user = await createTestUser();
    const role = await createTestRole();
    const rolesRead = await prisma.permission.findFirstOrThrow({
      where: { name: "roles.read", retiredAt: null },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: rolesRead.id },
    });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });

    const { code, verifier } = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid offline_access core:admin",
      email: user.email,
      password: user.plainPassword,
    });
    const token = async (params: Record<string, string>) => {
      const res = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: client.clientId, ...params }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        access_token: string;
        refresh_token: string;
      };
    };
    const tokens = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    const refresh = () =>
      token({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      });
    return { role, tokens, refresh };
  };

  const listRoles = async (accessToken: string) =>
    (
      await fetch(`${BASE_URL}/v1/admin/roles`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    ).status;

  it("loses a permission the role drops on the token it already holds, and on refresh", async () => {
    const { role, tokens, refresh } = await login();
    expect(await listRoles(tokens.access_token)).toBe(HTTP_STATUS.OK);

    const cleared = await fetch(
      `${BASE_URL}/v1/admin/roles/${role.id}/permissions`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ permissionIds: [] }),
      }
    );
    expect(cleared.status).toBe(HTTP_STATUS.OK);

    expect(await listRoles(tokens.access_token)).toBe(HTTP_STATUS.FORBIDDEN);
    const refreshed = await refresh();
    expect(decodeJwt(refreshed.access_token)).not.toHaveProperty("permissions");
    expect(await listRoles(refreshed.access_token)).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("loses the role's permissions when the role is deleted", async () => {
    const { role, tokens, refresh } = await login();
    expect(await listRoles(tokens.access_token)).toBe(HTTP_STATUS.OK);

    const deleted = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(deleted.status).toBe(HTTP_STATUS.NO_CONTENT);

    expect(await listRoles(tokens.access_token)).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await listRoles((await refresh()).access_token)).toBe(
      HTTP_STATUS.FORBIDDEN
    );
  });
});

describe("a service client's tokens after the role changes", () => {
  /** A client_credentials client holding a role, with one live token. */
  const clientHolding = async () => {
    const client = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
    const account = await prisma.user.findFirstOrThrow({
      where: { oauthClientId: client.id },
    });
    const role = await createTestRole();
    await prisma.userRole.create({
      data: { userId: account.id, roleId: role.id },
    });
    const token = await prisma.accessToken.create({
      data: {
        jti: crypto.randomUUID(),
        clientId: client.id,
        userId: account.id,
        scopes: [],
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const revoked = async () =>
      (
        await prisma.accessToken.findUniqueOrThrow({
          where: { id: token.id },
        })
      ).revokedAt !== null;
    return { role, revoked };
  };

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${BASE_URL}/v1/admin/roles/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const auditedRevocations = async (
    roleId: string,
    action: "UPDATE" | "DELETE"
  ) => {
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityType: "Role", entityId: roleId, action },
      orderBy: { createdAt: "desc" },
    });
    return (entry.metadata as { accessTokensRevoked?: number })
      .accessTokensRevoked;
  };

  it("are revoked, and counted, when the role is deactivated", async () => {
    const { role, revoked } = await clientHolding();
    const res = await send("PATCH", role.id, { isActive: false });
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(await revoked()).toBe(true);
    expect(await auditedRevocations(role.id, "UPDATE")).toBe(1);
  });

  it("are revoked, and counted, when its permissions change", async () => {
    const { role, revoked } = await clientHolding();
    const res = await send("PUT", `${role.id}/permissions`, {
      permissionIds: [],
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(await revoked()).toBe(true);
    expect(await auditedRevocations(role.id, "UPDATE")).toBe(1);
  });

  it("are revoked, and counted, when the role is deleted", async () => {
    const { role, revoked } = await clientHolding();
    const res = await send("DELETE", role.id);
    expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
    expect(await revoked()).toBe(true);
    expect(await auditedRevocations(role.id, "DELETE")).toBe(1);
  });
});

describe("resolution", () => {
  it("stops granting a retired permission, which stays on the role", async () => {
    const resolutionClient = await createTestClient({
      clientType: "confidential",
    });
    // check-permission answers a client of no organization only if it is a
    // service's.
    await makeServiceOf(resolutionClient.id);
    const user = await createTestUser();
    const role = await createTestRole();
    const permission = await createTestPermission();
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });

    expect(
      await checkUserPermission(resolutionClient, user.id, permission.name)
    ).toBe(true);

    await prisma.permission.update({
      where: { id: permission.id },
      data: { retiredAt: new Date() },
    });
    expect(
      await checkUserPermission(resolutionClient, user.id, permission.name)
    ).toBe(false);
    expect(
      await prisma.rolePermission.count({ where: { roleId: role.id } })
    ).toBe(1);

    // Re-declared: grants again.
    await prisma.permission.update({
      where: { id: permission.id },
      data: { retiredAt: null },
    });
    expect(
      await checkUserPermission(resolutionClient, user.id, permission.name)
    ).toBe(true);
  });
});

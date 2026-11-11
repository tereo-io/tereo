// @module-tag int
// @module-tag auth
// @module-tag race

import { generateUniqueId } from "../../../../../../../support/auth/crypto.js";
import { ensurePermission } from "../../../../../../../support/testService.js";
import { createTestRole } from "../../../../../../../support/auth/users.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORE_URL } from "../../../../../../../support/coreUrl.js";
import {
  startFakeOidcProvider,
  FakeOidcProvider,
} from "../../../../../../../support/fakeOidcProvider.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../../../support/principals.js";
import {
  holdLocks,
  waitForLockWait,
} from "../../../../../../../support/dbLocks.js";

const BASE = `${CORE_URL}/v1/admin/identity-providers`;

let fake: FakeOidcProvider;
let writeToken: string;
let orgId: string;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
  writeToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  orgId = await ensureTestOrganization(`idp-org-${generateUniqueId()}`);
});

afterAll(async () => {
  await fake.close();
});

const call = (method: string, path: string, body: unknown) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${writeToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("PATCH /v1/admin/identity-providers/:id/domains/:domainId and a concurrent role change", () => {
  it("does not put back, unchecked, a default role removed while it waited", async () => {
    const created = await call("POST", "", {
      slug: `p-${generateUniqueId().toLowerCase()}`.slice(0, 40),
      displayName: "Fake IdP",
      kind: "oidc",
      issuer: fake.issuer,
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
    });
    expect(created.status).toBe(201);
    const provider = (await created.json()) as { id: string };
    const domainRes = await call("POST", `/${provider.id}/domains`, {
      domain: `race-${generateUniqueId().toLowerCase()}.com`,
      organizationId: orgId,
      autoAccept: false,
      ssoOnly: false,
      roleIds: [],
    });
    expect(domainRes.status).toBe(201);
    const domain = (await domainRes.json()) as { id: string };

    // A role the caller could not hand out, given to the domain by someone
    // who could.
    const permission = await prisma.permission.update({
      where: {
        id: (
          await ensurePermission(
            `idp.test.r${generateUniqueId().toLowerCase()}`
          )
        ).id,
      },
      data: { orgAssignable: true },
    });
    const role = await createTestRole();
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    const held = { domainId: domain.id, roleId: role.id };
    await prisma.identityProviderDomainRole.create({ data: held });

    const release = await holdLocks(
      (tx) =>
        tx.$queryRaw`SELECT "id" FROM "auth"."identity_providers" WHERE "id" = ${provider.id}::uuid FOR UPDATE`
    );
    const pending = call("PATCH", `/${provider.id}/domains/${domain.id}`, {
      roleIds: [role.id],
    });
    await waitForLockWait(`%"auth"."identity_providers"%`);
    await prisma.identityProviderDomainRole.deleteMany({ where: held });
    await release();

    expect((await pending).status).toBe(403);
    expect(await prisma.identityProviderDomainRole.count({ where: held })).toBe(
      0
    );
  });
});

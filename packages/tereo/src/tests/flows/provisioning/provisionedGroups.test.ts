// @module-tag int
// @module-tag provisioning
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { adminApi, deleteGroups, groupSlug } from "../../support/groups.js";
import type { ProvisioningSet } from "../../../utils/provisioning/load.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { fetchJson } from "../../support/http.js";
import { randomUUID } from "node:crypto";
import env from "../../../env.js";
import {
  applyProvisioning,
  deprovisionMissing,
} from "../../../utils/provisioning/index.js";
import {
  removeRoles,
  provisionRand as rand,
} from "../../support/provisioning.js";

const HOUR = 60 * 60 * 1000;
const roleName = `prov-role-${rand()}`;
const slug = groupSlug("prov-flow");

const set = (withGroup: boolean): ProvisioningSet => ({
  documents: [
    {
      file: "groups.json",
      version: "1.0.0",
      service: null,
      clients: [],
      roles: [
        {
          name: roleName,
          displayName: "Flow reader",
          orgAssignable: false,
          requires2fa: false,
          guestAssignable: false,
          permissions: ["roles.read"],
        },
      ],
      ...(withGroup && {
        groups: [{ slug, name: "Flow", roles: [roleName] }],
      }),
    },
  ],
});

const permissionsOf = async (token: string): Promise<string[]> => {
  const res = await fetchJson("GET", `${CORE_URL}/v1/account/me`, token);
  expect(res.status).toBe(200);
  return res.body.permissions;
};

beforeAll(async () => {
  // Events are written in this process, outside the server.
  await ensureDefaultOrganization();
});

afterAll(async () => {
  const groups = await prisma.group.findMany({
    where: { slug },
    select: { id: true },
  });
  await deleteGroups(groups.map((g) => g.id));
  await removeRoles([roleName]);
});

describe("provisioned groups", () => {
  it("grant through members an admin adds, retire after the grace and come back with them", async () => {
    await applyProvisioning(set(true));
    const group = await prisma.group.findFirstOrThrow({
      where: { slug, organizationId: null },
    });

    const adminToken = await getTestPrincipalToken({
      permissions: ["groups.write", "roles.read"],
    });
    const memberId = randomUUID();
    const memberToken = await getTestPrincipalToken({
      userId: memberId,
      permissions: [],
    });
    expect(await permissionsOf(memberToken)).not.toContain("roles.read");

    const added = await adminApi(
      "POST",
      `/groups/${group.id}/members`,
      adminToken,
      { userIds: [memberId] }
    );
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(await permissionsOf(memberToken)).toContain("roles.read");

    const now = new Date();
    await applyProvisioning(set(false), now);
    // Within the grace, the group still grants.
    expect(await permissionsOf(memberToken)).toContain("roles.read");

    const grace = env.REGISTRY_RETIREMENT_GRACE_HOURS * HOUR;
    const retired = await deprovisionMissing(
      new Date(now.getTime() + grace + HOUR)
    );
    expect(retired.groups).toBeGreaterThanOrEqual(1);
    const archived = await prisma.group.findUniqueOrThrow({
      where: { id: group.id },
    });
    expect(archived.archivedAt).not.toBeNull();
    expect(await permissionsOf(memberToken)).not.toContain("roles.read");

    const back = await applyProvisioning(set(true));
    expect(back.groups).toEqual([`group:${slug}`]);
    const restored = await prisma.group.findUniqueOrThrow({
      where: { id: group.id },
      include: { members: { select: { userId: true } } },
    });
    expect(restored.archivedAt).toBeNull();
    expect(restored.unprovisionedAt).toBeNull();
    expect(restored.members).toEqual([{ userId: memberId }]);
    expect(await permissionsOf(memberToken)).toContain("roles.read");
  });
});

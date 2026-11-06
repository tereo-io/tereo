// @module-tag int
// @module-tag provisioning
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { removeRoles, provisionRand } from "../../support/provisioning.js";
import type { LoadedDocument } from "../../../utils/provisioning/load.js";
import { applyProvisioning } from "../../../utils/provisioning/index.js";
import { getGuestDefaultRoleIds } from "../../../utils/guestRoles.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";

const names: string[] = [];

const guestRole = (name: string): LoadedDocument["roles"][number] => {
  names.push(name);
  return {
    name,
    displayName: name,
    orgAssignable: true,
    requires2fa: false,
    guestAssignable: true,
    permissions: ["file-service.objects.read"],
  };
};

const set = (roles: LoadedDocument["roles"], defaultRoles?: string[]) => ({
  documents: [
    {
      file: "guests.json",
      version: "1.0.0",
      service: null,
      clients: [],
      roles,
      ...(defaultRoles && { guests: { defaultRoles } }),
    },
  ],
});

beforeAll(async () => {
  await ensureDefaultOrganization();
});

afterAll(async () => {
  await prisma.systemSetting.deleteMany({
    where: { key: "guestDefaultRoles" },
  });
  await removeRoles(names);
});

describe("applyProvisioning: guests", () => {
  it("persists guestAssignable and stores then replaces the default roles", async () => {
    const a = `guest-a-${provisionRand()}`;
    const b = `guest-b-${provisionRand()}`;
    await applyProvisioning(set([guestRole(a), guestRole(b)], [a]));

    const rows = await prisma.role.findMany({
      where: { name: { in: [a, b] } },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.guestAssignable)).toBe(true);
    const idOf = (n: string) => rows.find((r) => r.name === n)!.id;
    expect(await getGuestDefaultRoleIds()).toEqual([idOf(a)]);

    await applyProvisioning(set([guestRole(a), guestRole(b)], [b]));
    expect(await getGuestDefaultRoleIds()).toEqual([idOf(b)]);
  });
});

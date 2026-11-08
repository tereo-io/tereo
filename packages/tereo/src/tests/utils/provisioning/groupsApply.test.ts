// @module-tag int
// @module-tag provisioning
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { ensureTestOrganization, testOrgId } from "../../support/principals.js";
import { deleteGroups, groupSlug, PROVISIONING } from "../../support/groups.js";
import type { CustomRoleEntry } from "../../../utils/provisioning/schema.js";
import { applyProvisioning } from "../../../utils/provisioning/index.js";
import { ProvisioningError } from "../../../utils/provisioning/load.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser } from "../../support/auth/users.js";
import { addMembers } from "../../../utils/groups.js";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import type {
  LoadedDocument,
  ProvisioningSet,
} from "../../../utils/provisioning/load.js";
import {
  CORE_SERVICE_ID,
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../definitions/index.js";
import {
  removeRoles,
  provisionRand as rand,
} from "../../support/provisioning.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../support/webhooks.js";

type GroupSpec = NonNullable<LoadedDocument["groups"]>[number];

const roleNames: string[] = [];
const slugs: string[] = [];
let orgId: string;

const customRole = (
  permissions: string[],
  extra: Partial<CustomRoleEntry> = {}
): CustomRoleEntry => {
  const name = `prov-role-${rand()}`;
  roleNames.push(name);
  return {
    name,
    displayName: name,
    orgAssignable: false,
    requires2fa: false,
    guestAssignable: false,
    permissions,
    ...extra,
  };
};

const groupSpec = (extra: Partial<GroupSpec> = {}): GroupSpec => {
  const slug = extra.slug ?? groupSlug("prov");
  slugs.push(slug);
  return { slug, name: `Group ${slug}`, roles: [], ...extra };
};

const setOf = (
  roles: CustomRoleEntry[],
  groups: GroupSpec[]
): ProvisioningSet => ({
  documents: [
    {
      file: "groups.json",
      version: "1.0.0",
      service: null,
      clients: [],
      roles,
      groups,
    },
  ],
});

const groupRow = (slug: string, organizationId: string | null = null) =>
  prisma.group.findFirstOrThrow({
    where: { slug, organizationId },
    include: { roles: { include: { role: true } } },
  });

const roleNamesOf = (row: Awaited<ReturnType<typeof groupRow>>) =>
  row.roles.map((r) => r.role.name).sort();

const problemsOf = async (set: ProvisioningSet): Promise<string[]> => {
  const err = await applyProvisioning(set).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProvisioningError);
  return (err as ProvisioningError).problems;
};

beforeAll(async () => {
  // Events are written in this process, outside the server.
  await ensureDefaultOrganization();
  orgId = await ensureTestOrganization(testOrgId("prov-groups"));
});

afterAll(async () => {
  const groups = await prisma.group.findMany({
    where: { slug: { in: slugs } },
    select: { id: true },
  });
  await deleteGroups(groups.map((g) => g.id));
  await removeRoles(roleNames);
});

describe("applyGroups", () => {
  it("creates a global group holding a set role and a core role", async () => {
    const role = customRole(["roles.read"]);
    const group = groupSpec({
      description: "Front-line",
      roles: [role.name, "webhook_publisher"],
    });
    const result = await applyProvisioning(setOf([role], [group]));
    expect(result.groups).toEqual([`group:${group.slug}`]);

    const row = await groupRow(group.slug);
    expect(row).toMatchObject({
      name: group.name,
      description: "Front-line",
      organizationId: null,
      definitionSource: "provisioned",
      createdBy: SYSTEM_USER_ID,
      unprovisionedAt: null,
    });
    expect(roleNamesOf(row)).toEqual([role.name, "webhook_publisher"].sort());

    const again = await applyProvisioning(setOf([role], [group]));
    expect(again.groups).toEqual([]);
  });

  it("creates an organization's group with an org-assignable custom role", async () => {
    const role = customRole(["file-service.objects.read"], {
      orgAssignable: true,
    });
    const group = groupSpec({ organizationId: orgId, roles: [role.name] });
    const result = await applyProvisioning(setOf([role], [group]));
    expect(result.groups).toEqual([`group:${orgId}/${group.slug}`]);
    expect(roleNamesOf(await groupRow(group.slug, orgId))).toEqual([role.name]);
  });

  it("updates name, description and roles, leaving members alone", async () => {
    const first = customRole(["roles.read"]);
    const second = customRole(["users.read"]);
    const group = groupSpec({ description: "Old", roles: [first.name] });
    await applyProvisioning(setOf([first, second], [group]));
    const { id } = await groupRow(group.slug);
    const member = await createTestUser();
    await prisma.$transaction((tx) =>
      addMembers(PROVISIONING, id, [member.id], tx)
    );

    const changed = {
      ...group,
      name: "Renamed",
      description: undefined,
      roles: [second.name],
    };
    const result = await applyProvisioning(setOf([first, second], [changed]));
    expect(result.groups).toEqual([`group:${group.slug}`]);

    const row = await groupRow(group.slug);
    expect(row.name).toBe("Renamed");
    expect(row.description).toBeNull();
    expect(roleNamesOf(row)).toEqual([second.name]);
    expect(
      await prisma.groupMember.findMany({
        where: { groupId: id },
        select: { userId: true },
      })
    ).toEqual([{ userId: member.id }]);
  });

  it("re-applies an unchanged group without touching it or locking its members", async () => {
    const role = customRole(["roles.read"]);
    const group = groupSpec({ roles: [role.name] });
    await applyProvisioning(setOf([role], [group]));
    const before = await groupRow(group.slug);
    const member = await createTestUser();
    await prisma.$transaction((tx) =>
      addMembers(PROVISIONING, before.id, [member.id], tx)
    );
    const auditCount = () =>
      prisma.auditLogEntry.count({
        where: { entityType: "Group", entityId: before.id },
      });
    const auditBefore = await auditCount();

    // A member's authority lock held elsewhere: a role change would wait on it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await db.users.lockAuthority(member.id, tx);
        locked();
        await held;
      },
      { timeout: 30_000 }
    );
    await lockTaken;
    try {
      const outcome = await Promise.race([
        applyProvisioning(setOf([role], [group])),
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 5_000)
        ),
      ]);
      expect(outcome).not.toBe("blocked");
      expect(outcome).toMatchObject({ groups: [] });
    } finally {
      release();
      await holder;
    }

    const after = await groupRow(group.slug);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.roles).toEqual(before.roles);
    expect(await auditCount()).toBe(auditBefore);
  });

  it("refuses a slug a hand-made group holds in that scope", async () => {
    const slug = groupSlug("hand");
    slugs.push(slug);
    await prisma.group.create({
      data: {
        slug,
        name: "Hand-made",
        definitionSource: "local",
        createdBy: SYSTEM_USER_ID,
      },
    });
    const problems = await problemsOf(setOf([], [groupSpec({ slug })]));
    expect(problems).toEqual([
      `groups.json: groups[${slug}]: a group with slug "${slug}" already exists here and was not created from the provisioning file`,
    ]);
    // In another scope the slug is free.
    const elsewhere = await applyProvisioning(
      setOf([], [groupSpec({ slug, organizationId: orgId })])
    );
    expect(elsewhere.groups).toEqual([`group:${orgId}/${slug}`]);
  });

  it("refuses an organization that is missing or archived", async () => {
    const archivedOrg = await ensureTestOrganization(
      testOrgId(`arch-${rand()}`)
    );
    await prisma.organization.update({
      where: { id: archivedOrg },
      data: { archivedAt: new Date() },
    });
    const missingOrg = randomUUID();
    const archived = groupSpec({ organizationId: archivedOrg });
    const missing = groupSpec({ organizationId: missingOrg });
    const problems = await problemsOf(setOf([], [archived, missing]));
    expect(problems).toEqual([
      `groups.json: groups[${archived.slug}]: organization "${archivedOrg}" does not exist or is archived`,
      `groups.json: groups[${missing.slug}]: organization "${missingOrg}" does not exist or is archived`,
    ]);
  });

  it("refuses moving a group to another organization", async () => {
    const group = groupSpec();
    await applyProvisioning(setOf([], [group]));
    const problems = await problemsOf(
      setOf([], [{ ...group, organizationId: orgId }])
    );
    expect(problems).toEqual([
      `groups.json: groups[${group.slug}]: organizationId cannot change from none; the group stays where it was created`,
    ]);
  });

  it("marks a dropped group unprovisioned, and clears it when it returns", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.group.updated"] }
    );
    const group = groupSpec();
    await applyProvisioning(setOf([], [group]));
    const { id } = await groupRow(group.slug);
    const delivered = (unprovisionedAt: string | null) =>
      waitFor(async () => {
        const deliveries = await prisma.webhookDelivery.findMany({
          where: {
            webhookEndpointId: endpoint.id,
            eventType: "auth.group.updated",
            payload: { path: ["entityId"], equals: id },
          },
        });
        return deliveries.some(
          (d) =>
            (d.payload as { data: Record<string, unknown> }).data
              .unprovisionedAt === unprovisionedAt
        );
      }, 10_000);

    const now = new Date();
    const dropped = await applyProvisioning(setOf([], []), now);
    expect(dropped.unprovisioned).toContain(`group:${group.slug}`);
    expect((await groupRow(group.slug)).unprovisionedAt).toEqual(now);
    const audit = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityType: "Group", entityId: id, action: "UPDATE" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(audit.metadata).toMatchObject({ action: "unprovisioned" });
    await delivered(now.toISOString());

    const back = await applyProvisioning(setOf([], [group]));
    expect(back.groups).toEqual([`group:${group.slug}`]);
    expect((await groupRow(group.slug)).unprovisionedAt).toBeNull();
    await delivered(null);
  });

  it("refuses a role the database no longer holds live", async () => {
    const core = { name: "webhook_publisher", serviceId: CORE_SERVICE_ID };
    const group = groupSpec({ roles: ["webhook_publisher"] });
    // Retired behind core's back: the apply refuses rather than drop it.
    await prisma.role.updateMany({
      where: core,
      data: { retiredAt: new Date() },
    });
    try {
      expect(await problemsOf(setOf([], [group]))).toEqual([
        `groups.json: groups[${group.slug}]: roles "webhook_publisher" does not exist in the database, or is archived or retired`,
      ]);
    } finally {
      await prisma.role.updateMany({ where: core, data: { retiredAt: null } });
    }
  });
});

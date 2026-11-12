// @module-tag int
// @module-tag auth
import { makeUser, manage, tag } from "../../../../support/scimUsers.js";
import { groupSlug, joinOrg } from "../../../../support/groups.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createScimConnection,
  pushGroup,
  setGroupsTarget,
} from "../../../../support/scim.js";

const orgConnection = async () => {
  const c = await createScimConnection();
  await setGroupsTarget(c.connectionId, {
    kind: "organization",
    organizationId: c.organizationId,
  });
  return c;
};

describe("POST /scim/v2/Groups", () => {
  it("creates a SCIM-owned group in the target organization", async () => {
    const c = await orgConnection();
    const name = `Eng ${tag()}`;
    const { status, body } = await pushGroup(c.token, {
      displayName: name,
      externalId: "ext-1",
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({
      displayName: name,
      externalId: "ext-1",
      meta: { resourceType: "Group" },
    });
    expect(body.meta.location).toMatch(new RegExp(`/Groups/${body.id}$`));

    const group = await prisma.group.findUniqueOrThrow({
      where: { id: body.id },
      include: { roles: true, scimLink: true },
    });
    expect(group).toMatchObject({
      definitionSource: "scim",
      membershipSource: "scim",
      organizationId: c.organizationId,
    });
    expect(group.roles).toHaveLength(0);
    expect(group.scimLink).toMatchObject({
      connectionId: c.connectionId,
      externalId: "ext-1",
    });
  });

  it("answers with a Location header", async () => {
    const c = await orgConnection();
    const response = await fetch(
      `${(await import("../../../../support/coreUrl.js")).CORE_URL}/scim/v2/Groups`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.token}`,
          "Content-Type": "application/scim+json",
        },
        body: JSON.stringify({ displayName: `Loc ${tag()}` }),
      }
    );
    const body = (await response.json()) as { id: string };
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toMatch(
      new RegExp(`/scim/v2/Groups/${body.id}$`)
    );
    expect(response.headers.get("content-type")).toContain(
      "application/scim+json"
    );
  });

  it("suffixes the slug when the same name is pushed twice", async () => {
    const c = await orgConnection();
    const name = `Engineering${tag()}`;
    const a = await pushGroup(c.token, { displayName: name });
    const b = await pushGroup(c.token, { displayName: name });
    const slugs = await Promise.all(
      [a, b].map(
        async (r) =>
          (await prisma.group.findUniqueOrThrow({ where: { id: r.body.id } }))
            .slug
      )
    );
    expect(slugs).toEqual([name.toLowerCase(), `${name.toLowerCase()}-2`]);
  });

  it("leaves a local group with the same slug untouched", async () => {
    const c = await orgConnection();
    const label = `clash${tag()}`;
    const local = await prisma.group.create({
      data: {
        organizationId: c.organizationId,
        slug: label,
        name: "Local",
        definitionSource: "local",
        createdBy: (await makeUser(`l-${tag()}@${c.domain}`)).id,
      },
    });
    const { status, body } = await pushGroup(c.token, { displayName: label });
    expect(status).toBe(201);
    const created = await prisma.group.findUniqueOrThrow({
      where: { id: body.id },
    });
    expect(created.slug).toBe(`${label}-2`);
    const after = await prisma.group.findUniqueOrThrow({
      where: { id: local.id },
    });
    expect(after).toMatchObject({
      name: "Local",
      definitionSource: "local",
      membershipSource: "local",
    });
    expect(groupSlug("x")).toBeTruthy();
  });

  it("adds managed org members, records managed non-members as skipped, ignores unknown ids", async () => {
    const c = await orgConnection();
    const member = await makeUser(`in-${tag()}@${c.domain}`);
    await joinOrg(c.organizationId, member.id);
    await manage(c.connectionId, member.id, member.email);
    const outsider = await makeUser(`out-${tag()}@${c.domain}`);
    await manage(c.connectionId, outsider.id, outsider.email);

    const { status, body } = await pushGroup(c.token, {
      displayName: `Mem ${tag()}`,
      members: [
        { value: member.id },
        { value: outsider.id },
        { value: randomUUID() },
        { value: "not-a-uuid" },
      ],
    });
    expect(status).toBe(201);
    expect(body.members.map((m: { value: string }) => m.value)).toEqual([
      member.id,
    ]);
    const link = await prisma.scimGroup.findUniqueOrThrow({
      where: { groupId: body.id },
      include: { skipped: true },
    });
    expect(link.skipped.map((s) => s.userId)).toEqual([outsider.id]);
    const rows = await prisma.groupMember.findMany({
      where: { groupId: body.id },
    });
    expect(rows.map((r) => r.userId)).toEqual([member.id]);
  });

  it("creates a global group for a global target", async () => {
    const c = await createScimConnection();
    await setGroupsTarget(c.connectionId, { kind: "global" });
    const { status, body } = await pushGroup(c.token, {
      displayName: `Glob ${tag()}`,
    });
    expect(status).toBe(201);
    const group = await prisma.group.findUniqueOrThrow({
      where: { id: body.id },
    });
    expect(group.organizationId).toBeNull();
  });
});

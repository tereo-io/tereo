// @module-tag int
// @module-tag auth
// @module-tag race

import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../../support/http.js";
import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createScimConnection,
  pushGroup,
  scimFetch,
  setGroupsTarget,
} from "../../../../../../support/scim.js";

const BASE = `${CORE_URL}/v1/admin/identity-providers`;

let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
});

describe("SCIM groups target races", () => {
  it("serialises a target change to none with a concurrent group create", async () => {
    for (let i = 0; i < 5; i++) {
      const c = await createScimConnection();
      await setGroupsTarget(c.connectionId, { kind: "global" });
      const [put, post] = await Promise.all([
        fetchJson("PUT", `${BASE}/${c.providerId}/scim`, adminToken, {
          isActive: true,
          groupsTarget: { kind: "none" },
        }),
        pushGroup(c.token, {
          displayName: `R ${randomBytes(4).toString("hex")}`,
        }),
      ]);
      expect(put.status).toBe(200);
      expect([201, 403]).toContain(post.status);
      const linked = await prisma.scimGroup.count({
        where: { connectionId: c.connectionId },
      });
      expect(linked).toBe(post.status === 201 ? 1 : 0);
      expect(put.body.groupsTarget).toEqual({ kind: "none" });
    }
  });

  it("does not fail a connection delete when a SCIM group delete wins a group", async () => {
    for (let i = 0; i < 5; i++) {
      const c = await createScimConnection();
      await setGroupsTarget(c.connectionId, { kind: "global" });
      const names = [0, 1].map(() => `D ${randomBytes(4).toString("hex")}`);
      const groups = [];
      for (const displayName of names) {
        const pushed = await pushGroup(c.token, { displayName });
        expect(pushed.status).toBe(201);
        groups.push(pushed.body.id as string);
      }
      const [del, scimDel] = await Promise.all([
        fetchJson("DELETE", `${BASE}/${c.providerId}/scim`, adminToken),
        scimFetch(c.token, "DELETE", `/scim/v2/Groups/${groups[0]}`),
      ]);
      expect(del.status).toBe(204);
      expect(scimDel.status).toBeLessThan(500);
      expect(
        await prisma.scimConnection.count({ where: { id: c.connectionId } })
      ).toBe(0);
      for (const id of groups) {
        const group = await prisma.group.findUniqueOrThrow({
          where: { id },
          include: { scimLink: true },
        });
        expect(group.definitionSource).toBe("local");
        expect(group.scimLink).toBeNull();
      }
    }
  });

  it("re-reads the linked groups after waiting on their locks", async () => {
    const c = await createScimConnection();
    await setGroupsTarget(c.connectionId, { kind: "global" });
    const pushed = await pushGroup(c.token, {
      displayName: `L ${randomBytes(4).toString("hex")}`,
    });
    const groupId = pushed.body.id as string;

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "auth"."groups" WHERE id = ${groupId}::uuid FOR UPDATE`;
      locked();
      await released;
      await tx.scimGroup.delete({ where: { groupId } });
      await tx.group.update({
        where: { id: groupId },
        data: { definitionSource: "local", membershipSource: "local" },
      });
    });
    await lockTaken;
    const deleting = fetchJson(
      "DELETE",
      `${BASE}/${c.providerId}/scim`,
      adminToken
    );
    await new Promise((r) => setTimeout(r, 750));
    release();
    await holder;
    expect((await deleting).status).toBe(204);
    expect(
      await prisma.scimConnection.count({ where: { id: c.connectionId } })
    ).toBe(0);
  });
});

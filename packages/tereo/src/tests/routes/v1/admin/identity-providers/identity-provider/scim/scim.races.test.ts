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
});

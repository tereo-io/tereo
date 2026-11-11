// @module-tag int
// @module-tag auth
// @module-tag race
import { holdLocks, waitForLockWait } from "../../../support/dbLocks.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { browserLogin } from "../../../support/browserLogin.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import {
  createTestOrganization,
  addTestOrgMember,
} from "../../../support/auth/organizations.js";
import {
  getAccessTokenForUser,
  json,
  postForm,
  loginAndExchange,
} from "../../../support/auth/login.js";
import {
  createTestUser,
  createAdminUser,
} from "../../../support/auth/users.js";

const SCOPE = "openid profile email offline_access";
const REDIRECT_URI = "http://localhost:3000/callback";

type Client = Awaited<ReturnType<typeof createTestClient>>;

let publicClient: Client;
let user: Awaited<ReturnType<typeof createTestUser>>;

beforeAll(async () => {
  publicClient = await createTestClient({ redirectUris: [REDIRECT_URI] });
  user = await createTestUser();
});

describe("POST /oauth/token", () => {
  describe("Single-use grants", () => {
    it("redeems a code once when two exchanges race", async () => {
      const { code, verifier } = await browserLogin({
        clientId: publicClient.clientId,
        redirectUri: REDIRECT_URI,
        scope: SCOPE,
        email: user.email,
        password: user.plainPassword,
      });
      const exchange = () =>
        postForm("/oauth/token", {
          grant_type: "authorization_code",
          client_id: publicClient.clientId,
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        });
      const statuses = (await Promise.all([exchange(), exchange()]))
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([200, 400]);
    });

    it("rotates a refresh token once when two refreshes race", async () => {
      const tokens = await loginAndExchange(
        publicClient,
        user,
        REDIRECT_URI,
        SCOPE
      );
      const refresh = () =>
        postForm("/oauth/token", {
          grant_type: "refresh_token",
          client_id: publicClient.clientId,
          refresh_token: tokens.refresh_token,
        });
      const statuses = (await Promise.all([refresh(), refresh()]))
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([200, 400]);
    });
  });

  describe("An organization deactivated while a token is being issued", () => {
    let adminToken: string;

    beforeAll(async () => {
      adminToken = await getAccessTokenForUser(
        await createAdminUser(),
        publicClient
      );
    });

    it("issues no token for a code once the deactivation commits ahead of it", async () => {
      const org = await createTestOrganization(adminToken);
      const member = await createTestUser();
      await addTestOrgMember(adminToken, org.id, member.id);
      const { code, verifier } = await browserLogin({
        clientId: publicClient.clientId,
        redirectUri: REDIRECT_URI,
        scope: SCOPE,
        email: member.email,
        password: member.plainPassword,
      });

      // A deactivation that holds the member's row, as a session end does,
      // and has not committed: the exchange's first look still finds the
      // organization active.
      const commit = await holdLocks(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "auth"."users" WHERE id = ${member.id}::uuid FOR UPDATE`;
        await tx.organization.update({
          where: { id: org.id },
          data: { isActive: false },
        });
      });
      const pending = postForm("/oauth/token", {
        grant_type: "authorization_code",
        client_id: publicClient.clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      await waitForLockWait('%"auth"."users"%FOR SHARE%');
      await commit();

      const res = await pending;
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("invalid_grant");
      expect(
        await prisma.accessToken.count({ where: { organizationId: org.id } })
      ).toBe(0);
    });

    it("mints no client_credentials token across the deactivation", async () => {
      const org = await createTestOrganization(adminToken);
      const service = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
      });
      await prisma.oAuthClient.update({
        where: { id: service.id },
        data: { organizationId: org.id },
      });

      const commit = await holdLocks((tx) =>
        tx.organization.update({
          where: { id: org.id },
          data: { isActive: false },
        })
      );
      const pending = postForm(
        "/oauth/token",
        { grant_type: "client_credentials" },
        {
          Authorization: `Basic ${Buffer.from(`${service.clientId}:${service.plainSecret}`).toString("base64")}`,
        }
      );
      // Either the mint waits for the deactivation, or it has answered.
      await Promise.race([
        pending,
        waitForLockWait('%"auth"."organizations"%FOR SHARE%'),
      ]);
      await commit();

      const res = await pending;
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("unauthorized_client");
      expect(
        await prisma.accessToken.count({ where: { organizationId: org.id } })
      ).toBe(0);
    });
  });
});

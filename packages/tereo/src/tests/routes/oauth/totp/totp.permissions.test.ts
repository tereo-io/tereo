// @module-tag int
// @module-tag auth
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createTestClient } from "../../../support/auth/clients.js";
import { generateTotpCode } from "../../../support/auth/crypto.js";
import { createTestUser } from "../../../support/auth/users.js";
import { prisma } from "../../../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
} from "../../../support/auth/constants.js";
import {
  loginToTotpSetup,
  startTotpSetup,
  createUserRequiringTotpSetup,
} from "../../../support/auth/totpSetup.js";

interface TotpSetupResponse {
  secret?: string;
  qrCodeUri?: string;
  setupToken?: string;
  expiresAt?: string;
  error?: string;
  error_description?: string;
}

interface TotpSetupVerifyResponse {
  success?: boolean;
  recoveryCodes?: string[];
  message?: string;
  error?: string;
  error_description?: string;
}

describe("/oauth/totp", () => {
  describe("OAuth TOTP Endpoints", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;
    let testUser: Awaited<ReturnType<typeof createTestUser>>;

    beforeAll(async () => {
      testClient = await createTestClient();
      testUser = await createTestUser();
    });

    describe("POST /oauth/totp/setup", () => {
      it("refuses a bare user_id, as the setup endpoint used to accept", async () => {
        const response = await startTotpSetup({
          user_id: testUser.id,
          client_id: testClient.clientId,
          redirect_uri: "http://localhost:3000/callback",
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(
          await prisma.totpSetupSession.count({
            where: { userId: testUser.id },
          })
        ).toBe(0);
      });

      it("refuses a forged grant", async () => {
        const response = await startTotpSetup(
          { setup_grant: "forged-grant-value" },
          `tereo_2fa_setup_grant_${testClient.clientId}=forged-grant-value`
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        const data = (await response.json()) as TotpSetupResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_SETUP_GRANT);
      });

      it("refuses a grant presented without its cookie, leaving it usable", async () => {
        const user = await createUserRequiringTotpSetup();
        const login = await loginToTotpSetup(user, testClient);

        const withoutCookie = await startTotpSetup({
          setup_grant: login.setupGrant,
        });
        expect(withoutCookie.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(((await withoutCookie.json()) as TotpSetupResponse).error).toBe(
          OAUTH_ERRORS.INVALID_SETUP_GRANT
        );

        const withCookie = await startTotpSetup(
          { setup_grant: login.setupGrant },
          login.grantCookie
        );
        expect(withCookie.status).toBe(HTTP_STATUS.OK);
      });

      it("refuses a grant reused after it started a setup", async () => {
        const user = await createUserRequiringTotpSetup();
        const login = await loginToTotpSetup(user, testClient);

        const first = await startTotpSetup(
          { setup_grant: login.setupGrant },
          login.grantCookie
        );
        expect(first.status).toBe(HTTP_STATUS.OK);

        const second = await startTotpSetup(
          { setup_grant: login.setupGrant },
          login.grantCookie
        );
        expect(second.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(((await second.json()) as TotpSetupResponse).error).toBe(
          OAUTH_ERRORS.INVALID_SETUP_GRANT
        );
      });

      it("refuses an expired grant", async () => {
        const user = await createUserRequiringTotpSetup();
        const login = await loginToTotpSetup(user, testClient);
        await prisma.totpSetupGrant.updateMany({
          where: { userId: user.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });

        const response = await startTotpSetup(
          { setup_grant: login.setupGrant },
          login.grantCookie
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(((await response.json()) as TotpSetupResponse).error).toBe(
          "setup_expired"
        );
        expect(
          await prisma.totpSetupSession.count({ where: { userId: user.id } })
        ).toBe(0);
      });

      it("sets up the grant's user, never one named in the body", async () => {
        const userA = await createUserRequiringTotpSetup();
        const userB = await createUserRequiringTotpSetup();
        const login = await loginToTotpSetup(userA, testClient);

        const response = await startTotpSetup(
          { setup_grant: login.setupGrant, user_id: userB.id },
          login.grantCookie
        );
        const data = (await response.json()) as TotpSetupResponse;
        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.qrCodeUri).toContain(encodeURIComponent(userA.email));
        expect(data.qrCodeUri).not.toContain(encodeURIComponent(userB.email));

        const verify = await fetch(`${BASE_URL}/oauth/totp/setup/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            setup_token: data.setupToken,
            totp_code: generateTotpCode(data.secret!),
          }),
        });
        expect(verify.status).toBe(HTTP_STATUS.OK);

        const [a, b] = await Promise.all([
          prisma.user.findUniqueOrThrow({ where: { id: userA.id } }),
          prisma.user.findUniqueOrThrow({ where: { id: userB.id } }),
        ]);
        expect(a.totpEnabled).toBe(true);
        expect(b.totpEnabled).toBe(false);
      });

      it("refuses user A's grant presented with user B's cookie", async () => {
        const userA = await createUserRequiringTotpSetup();
        const userB = await createUserRequiringTotpSetup();
        const loginA = await loginToTotpSetup(userA, testClient);
        const loginB = await loginToTotpSetup(userB, testClient);

        const response = await startTotpSetup(
          { setup_grant: loginA.setupGrant },
          loginB.grantCookie
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(((await response.json()) as TotpSetupResponse).error).toBe(
          OAUTH_ERRORS.INVALID_SETUP_GRANT
        );
      });
    });

    describe("TOTP setup under the disabled policy", () => {
      const setPolicy = (value: string) =>
        prisma.systemSetting.upsert({
          where: { key: "totpPolicy" },
          update: { value },
          create: { key: "totpPolicy", value },
        });

      const startSetup = async () => {
        const user = await createUserRequiringTotpSetup();
        const login = await loginToTotpSetup(user, testClient);
        return { user, login };
      };

      afterEach(async () => {
        await setPolicy("optional");
      });

      it("refuses POST /oauth/totp/setup with 403 totp_disabled", async () => {
        const { login } = await startSetup();
        await setPolicy("disabled");

        const response = await startTotpSetup(
          { setup_grant: login.setupGrant },
          login.grantCookie
        );

        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
        const data = (await response.json()) as TotpSetupResponse;
        expect(data.error).toBe("totp_disabled");
      });

      it("refuses POST /oauth/totp/setup/verify for a setup started before the policy changed", async () => {
        const { user, login } = await startSetup();
        const setup = (await (
          await startTotpSetup(
            { setup_grant: login.setupGrant },
            login.grantCookie
          )
        ).json()) as TotpSetupResponse;
        expect(setup.setupToken).toBeDefined();

        await setPolicy("disabled");

        const response = await fetch(`${BASE_URL}/oauth/totp/setup/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            setup_token: setup.setupToken,
            totp_code: generateTotpCode(setup.secret!),
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
        const data = (await response.json()) as TotpSetupVerifyResponse;
        expect(data.error).toBe("totp_disabled");
        const stored = await prisma.user.findUniqueOrThrow({
          where: { id: user.id },
        });
        expect(stored.totpEnabled).toBe(false);
      });
    });
  });
});

// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestUser, enableTotp } from "../../support/auth/users.js";
import { loginAndExchange, postForm } from "../../support/auth/login.js";
import { DEFAULT_ORGANIZATION_ID } from "../../../definitions/index.js";
import { BASE_URL, HTTP_STATUS } from "../../support/auth/constants.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { createTestClient } from "../../support/auth/clients.js";
import { createTestGuest } from "../../support/auth/guests.js";
import { prisma } from "../../../utils/db/prisma.js";
import { waitFor } from "../../support/webhooks.js";
import { fetchJson } from "../../support/http.js";
import { randomBytes } from "node:crypto";
import env from "../../../env.js";
import jwt from "jsonwebtoken";
import {
  startNotificationDeliveryWorker,
  stopNotificationDeliveryWorker,
} from "../../../jobs/notificationDelivery.js";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../../jobs/notificationQueues.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../../support/fakeSmtpServer.js";
import {
  cleanNotifications,
  createNotificationConnection,
} from "../../support/notifications.js";
import {
  absorbCookies,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../../support/browserLogin.js";

const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPE = "openid offline_access";
const NEW_PASSWORD = "BrandNewPassword123!";

describe("password reset, end to end", () => {
  const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;
  let smtp: FakeSmtpServer;
  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    await ensureDefaultOrganization();
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
    smtp = await startFakeSmtpServer();
    await startNotificationDeliveryWorker();
    client = await createTestClient({ redirectUris: [REDIRECT_URI] });
  });
  beforeEach(async () => {
    smtp.messages.length = 0;
    await cleanNotifications();
    await createNotificationConnection({
      isDefault: true,
      settings: {
        host: "127.0.0.1",
        port: smtp.port,
        security: "none",
        defaultFrom: { address: "billing@acme.com" },
        allowedSenders: ["@acme.com"],
      },
    });
  });
  afterAll(async () => {
    await stopNotificationDeliveryWorker();
    await getNotificationQueue("email")
      .obliterate({ force: true })
      .catch(() => {});
    await closeNotificationQueues();
    await cleanNotifications();
    await smtp.close();
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = allowPrivateHosts;
  });

  /** Asks for a reset and reads the token out of the mail that arrives. */
  const requestResetToken = async (email: string) => {
    const res = await fetch(`${BASE_URL}/v1/password-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(202);
    const mails = () => smtp.messages.filter((m) => m.rcpt.includes(email));
    await waitFor(async () => mails().length >= 1, 10_000, 50);
    const token = /#token=([\w-]+)/.exec(mails()[0].parsed.text ?? "")?.[1];
    expect(token).toBeTruthy();
    return token!;
  };

  const redeem = (token: string, password = NEW_PASSWORD) =>
    fetch(`${BASE_URL}/v1/password-setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });

  /** The password step of `/oauth/authorize`: where it sends the browser next. */
  const passwordStep = async (email: string, password: string) => {
    const jar: CookieJar = new Map();
    const pkce = newPkce();
    const params = {
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      state: pkce.state,
      scope: SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    };
    const start = await fetch(
      `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
      { redirect: "manual" }
    );
    absorbCookies(jar, start);
    const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({ ...params, email, password }),
    });
    expect(submit.status).toBe(HTTP_STATUS.OK);
    const { redirect_url } = (await submit.json()) as { redirect_url: string };
    return new URL(redirect_url);
  };

  it("reset, then sign in with TOTP still required, other sessions ended", async () => {
    const user = await createTestUser();
    const before = await loginAndExchange(client, user, REDIRECT_URI, SCOPE);
    await enableTotp(user.id);

    const token = await requestResetToken(user.email);
    expect((await redeem(token)).status).toBe(HTTP_STATUS.NO_CONTENT);

    const refresh = await postForm("/oauth/token", {
      grant_type: "refresh_token",
      client_id: client.clientId,
      refresh_token: before.refresh_token,
    });
    expect(refresh.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(((await refresh.json()) as { error: string }).error).toBe(
      "invalid_grant"
    );

    const next = await passwordStep(user.email, NEW_PASSWORD);
    expect(next.pathname).toBe("/login/2fa");
  });

  it("a guest with passwordChangeRequired who resets signs in without the forced change", async () => {
    const { user: guest } = await createTestGuest({
      organizationId: DEFAULT_ORGANIZATION_ID,
    });
    await prisma.user.update({
      where: { id: guest.id },
      data: { passwordChangeRequired: true },
    });
    await prisma.passwordChangeGrant.create({
      data: {
        tokenHash: `grant-${guest.id}`,
        cookieSecretHash: `cookie-${guest.id}`,
        userId: guest.id,
        clientId: client.id,
        redirectUri: REDIRECT_URI,
        scopes: ["openid"],
        codeChallenge: "c",
        codeChallengeMethod: "S256",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const token = await requestResetToken(guest.email);
    expect((await redeem(token)).status).toBe(HTTP_STATUS.NO_CONTENT);

    expect(
      await prisma.passwordChangeGrant.count({ where: { userId: guest.id } })
    ).toBe(0);
    const next = await passwordStep(guest.email, NEW_PASSWORD);
    expect(next.pathname).not.toBe("/login/change-password");
    expect(next.searchParams.has("change_grant")).toBe(false);
    const signedIn = await loginAndExchange(
      client,
      { email: guest.email, plainPassword: NEW_PASSWORD },
      REDIRECT_URI,
      SCOPE
    );
    expect(signedIn.access_token).toBeTruthy();
  });

  it("a provider-only user resets and signs in with a password", async () => {
    const user = await prisma.user.create({
      data: {
        email: `provider-only-${randomBytes(5).toString("hex")}@test.local`,
        name: "Provider Only",
        passwordHash: null,
      },
    });

    const token = await requestResetToken(user.email);
    expect((await redeem(token)).status).toBe(HTTP_STATUS.NO_CONTENT);

    const signedIn = await loginAndExchange(
      client,
      { email: user.email, plainPassword: NEW_PASSWORD },
      REDIRECT_URI,
      SCOPE
    );
    expect(signedIn.access_token).toBeTruthy();
  });

  it("an admin email change retires a reset link; the new address's own link verifies it", async () => {
    const admin = await getTestPrincipalToken({
      permissions: ["users.write", "users.admin"],
    });
    const user = await createTestUser();
    const resetToken = await requestResetToken(user.email);
    const newEmail = `moved-${randomBytes(5).toString("hex")}@test.local`;

    const patched = await fetchJson(
      "PATCH",
      `${BASE_URL}/v1/admin/users/${user.id}`,
      admin,
      { email: newEmail }
    );
    expect(patched.status).toBe(HTTP_STATUS.OK);
    expect(patched.body.emailVerified).toBe(false);

    expect((await redeem(resetToken)).status).toBe(HTTP_STATUS.NOT_FOUND);

    const toNew = () => smtp.messages.filter((m) => m.rcpt.includes(newEmail));
    await waitFor(async () => toNew().length >= 1, 10_000, 50);
    const verifyToken = /\/verify-email#token=([\w-]+)/.exec(
      toNew()[0].parsed.text ?? ""
    )?.[1];
    expect(verifyToken).toBeTruthy();
    const confirmed = await fetch(`${BASE_URL}/v1/email-verification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: verifyToken }),
    });
    expect(confirmed.status).toBe(HTTP_STATUS.NO_CONTENT);

    const tokens = await loginAndExchange(
      client,
      { email: newEmail, plainPassword: user.plainPassword },
      REDIRECT_URI,
      "openid email"
    );
    const idClaims = jwt.decode(tokens.id_token!) as Record<string, unknown>;
    expect(idClaims.email).toBe(newEmail);
    expect(idClaims.email_verified).toBe(true);
    const userinfo = await fetch(`${BASE_URL}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(userinfo.status).toBe(HTTP_STATUS.OK);
    expect(await userinfo.json()).toMatchObject({
      email: newEmail,
      email_verified: true,
    });
  });
});

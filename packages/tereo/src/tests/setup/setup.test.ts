import { announceSetupIfPending, issueSetupToken } from "../../utils/setup.js";
import { prisma } from "../../utils/db/prisma.js";
import { logger } from "../../utils/logger.js";
import env from "../../env.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  generateUniqueId,
  getAccessTokenForUser,
} from "../auth/utils/test-helpers.js";
import {
  DEFAULT_ORGANIZATION_ID,
  LOGIN_CLIENT,
} from "../../definitions/index.js";
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";

/**
 * First-boot setup against the suite's server. The suite runs with setup
 * complete; each case here puts it back to pending, and the original state
 * and default organization are restored afterwards.
 */

const request = (body: unknown) =>
  axios.post(`${BASE_URL}/v1/setup`, body, { validateStatus: () => true });

const status = async () =>
  (await axios.get(`${BASE_URL}/v1/setup/status`)).data as {
    setupComplete: boolean;
  };

const PASSWORD = "SetupPassword123!";

const setupBody = (token: string) => {
  const id = generateUniqueId()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return {
    token,
    admin: {
      email: `setup-admin-${id}@test.local`,
      name: "Setup Admin",
      password: PASSWORD,
    },
    organization: {
      name: `Acme ${id}`,
      slug: `acme-${id}`.slice(0, 100),
      code: id.slice(-6).toUpperCase(),
    },
  };
};

describe("First-boot setup", () => {
  let instance: {
    setupCompletedAt: Date | null;
    setupCompletedBy: string | null;
  };
  let org: { name: string; slug: string; code: string };

  beforeAll(async () => {
    instance = await prisma.instance.findUniqueOrThrow({ where: { id: 1 } });
    org = await prisma.organization.findUniqueOrThrow({
      where: { id: DEFAULT_ORGANIZATION_ID },
    });
  });

  beforeEach(async () => {
    await prisma.instance.update({
      where: { id: 1 },
      data: { setupCompletedAt: null, setupCompletedBy: null },
    });
    await prisma.setupToken.deleteMany({});
  });

  afterAll(async () => {
    await prisma.setupToken.deleteMany({});
    await prisma.instance.update({
      where: { id: 1 },
      data: {
        setupCompletedAt: instance.setupCompletedAt,
        setupCompletedBy: instance.setupCompletedBy,
      },
    });
    await prisma.organization.update({
      where: { id: DEFAULT_ORGANIZATION_ID },
      data: { name: org.name, slug: org.slug, code: org.code },
    });
  });

  it("reports pending setup", async () => {
    expect(await status()).toEqual({ setupComplete: false });
  });

  it("creates the admin and names the default organization", async () => {
    const token = await issueSetupToken();
    const body = setupBody(token);

    const response = await request(body);

    expect(response.status).toBe(HTTP_STATUS.CREATED);
    expect(response.data.user.email).toBe(body.admin.email);
    expect(response.data.organization).toEqual({
      id: DEFAULT_ORGANIZATION_ID,
      ...body.organization,
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: body.admin.email },
      include: {
        userRoles: { include: { role: true } },
        organizationMembers: true,
      },
    });
    expect(user.userType).toBe("human");
    expect(user.userRoles.map((ur) => ur.role.name).sort()).toEqual([
      "admin",
      "platform_admin",
    ]);
    expect(user.organizationMembers).toEqual([
      expect.objectContaining({
        organizationId: DEFAULT_ORGANIZATION_ID,
        memberRole: "owner",
      }),
    ]);

    const after = await prisma.instance.findUniqueOrThrow({ where: { id: 1 } });
    expect(after.setupCompletedAt).not.toBeNull();
    expect(after.setupCompletedBy).toBe(user.id);
    expect(await prisma.setupToken.count()).toBe(0);
    expect(await status()).toEqual({ setupComplete: true });

    const audit = await prisma.auditLogEntry.findMany({
      where: { userId: user.id, entityType: { in: ["User", "Organization"] } },
    });
    expect(audit.map((e) => `${e.action} ${e.entityType}`).sort()).toEqual([
      "CREATE User",
      "UPDATE Organization",
    ]);
  });

  it("lets the new admin sign in and use the admin API", async () => {
    const body = setupBody(await issueSetupToken());
    expect((await request(body)).status).toBe(HTTP_STATUS.CREATED);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: body.admin.email },
    });
    // The admin signs in through the UI, whose tokens core's API admits.
    const client = await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: LOGIN_CLIENT.clientId },
    });
    const accessToken = await getAccessTokenForUser(
      { id: user.id, email: user.email, plainPassword: PASSWORD },
      client,
      "openid profile email"
    );

    const users = await axios.get(`${BASE_URL}/v1/admin/users`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      validateStatus: () => true,
    });
    expect(users.status).toBe(HTTP_STATUS.OK);
  });

  it("returns 404 once setup is complete", async () => {
    expect((await request(setupBody(await issueSetupToken()))).status).toBe(
      HTTP_STATUS.CREATED
    );

    const again = await request(setupBody(await issueSetupToken()));
    expect(again.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("accepts a token typed in lowercase without dashes", async () => {
    const token = (await issueSetupToken()).replace(/-/g, "").toLowerCase();
    expect((await request(setupBody(token))).status).toBe(HTTP_STATUS.CREATED);
  });

  it("rejects a wrong token", async () => {
    await issueSetupToken();
    const response = await request(setupBody("AAAA-BBBB-CCCC"));
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await status()).toEqual({ setupComplete: false });
  });

  it("refuses further attempts from an address after ten wrong tokens", async () => {
    const token = await issueSetupToken();
    const from = (ip: string, body: unknown) =>
      axios.post(`${BASE_URL}/v1/setup`, body, {
        headers: { "X-Forwarded-For": ip },
        validateStatus: () => true,
      });

    for (let i = 0; i < 10; i++) {
      const response = await from("198.51.100.20", setupBody("AAAA-BBBB-CCCC"));
      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }
    const limited = await from("198.51.100.20", setupBody(token));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.data.error).toBe("too_many_requests");
    expect(await status()).toEqual({ setupComplete: false });

    // Counted per address: another one still gets its attempts.
    expect((await from("198.51.100.21", setupBody(token))).status).toBe(
      HTTP_STATUS.CREATED
    );
  });

  it("rejects an expired token", async () => {
    const token = await issueSetupToken();
    await prisma.setupToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await request(setupBody(token))).status).toBe(
      HTTP_STATUS.UNAUTHORIZED
    );
  });

  it("rejects an invalid body", async () => {
    const body = setupBody(await issueSetupToken());
    body.admin.password = "short";
    expect((await request(body)).status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it("rejects an email that is taken, leaving setup pending", async () => {
    const body = setupBody(await issueSetupToken());
    body.admin.email = "test-client-owner@test.local";

    expect((await request(body)).status).toBe(HTTP_STATUS.CONFLICT);
    expect(await status()).toEqual({ setupComplete: false });
    expect(await prisma.setupToken.count()).toBe(1);
  });

  it("lets only one of two concurrent attempts through", async () => {
    const [a, b] = await Promise.all([
      request(setupBody(await issueSetupToken())),
      request(setupBody(await issueSetupToken())),
    ]);
    expect([a.status, b.status].sort()).toEqual([
      HTTP_STATUS.CREATED,
      HTTP_STATUS.NOT_FOUND,
    ]);
  });

  it("logs a generated token once, in the message, and it completes setup", async () => {
    const warn = vi.spyOn(logger, "warn");
    await announceSetupIfPending();
    const calls = [...warn.mock.calls] as unknown as [object, string][];
    warn.mockRestore();
    expect(calls).toHaveLength(1);
    const [fields, message] = calls[0];
    const token = message.split("with this token: ")[1];
    expect(token).toBeTruthy();
    expect(JSON.stringify(fields)).not.toContain(token);

    const response = await request(setupBody(token));
    expect(response.status).toBe(HTTP_STATUS.CREATED);
  });

  describe("with SETUP_TOKEN", () => {
    const TOKEN = "deploy-supplied-setup-token-0123456789";
    const original = env.SETUP_TOKEN;

    beforeEach(() => {
      env.SETUP_TOKEN = TOKEN;
    });
    afterAll(() => {
      env.SETUP_TOKEN = original;
    });

    it("uses SETUP_TOKEN as the setup token and does not log it", async () => {
      const warn = vi.spyOn(logger, "warn");
      await announceSetupIfPending();
      const calls = [...warn.mock.calls];
      warn.mockRestore();
      expect(calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(calls)).not.toContain(TOKEN);

      const response = await request(setupBody(TOKEN));
      expect(response.status).toBe(HTTP_STATUS.CREATED);
    });

    it("accepts SETUP_TOKEN across restarts until setup completes", async () => {
      await announceSetupIfPending();
      await announceSetupIfPending();
      expect(await prisma.setupToken.count()).toBe(1);
      expect((await request(setupBody(TOKEN))).status).toBe(
        HTTP_STATUS.CREATED
      );
      expect(await prisma.setupToken.count()).toBe(0);
    });

    it("stops accepting a previous SETUP_TOKEN after it changes", async () => {
      await announceSetupIfPending();
      const next = "another-deploy-supplied-token-9876543210";
      env.SETUP_TOKEN = next;
      await announceSetupIfPending();

      expect((await request(setupBody(TOKEN))).status).toBe(
        HTTP_STATUS.UNAUTHORIZED
      );
      expect((await request(setupBody(next))).status).toBe(HTTP_STATUS.CREATED);
    });

    it("stops accepting a SETUP_TOKEN once it is unset", async () => {
      await announceSetupIfPending();
      env.SETUP_TOKEN = undefined;
      await announceSetupIfPending();

      expect((await request(setupBody(TOKEN))).status).toBe(
        HTTP_STATUS.UNAUTHORIZED
      );
      expect(await prisma.setupToken.count()).toBe(1);
    });
  });
});

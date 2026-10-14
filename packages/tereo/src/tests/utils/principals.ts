import { ensurePermission, ensureTestService } from "./testService.js";
import { generateAccessToken } from "../../utils/tokens.js";
import { LOGIN_CLIENT } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { createHash, randomUUID } from "crypto";

/**
 * Real users and real access tokens for tests. Each token is a signed JWT
 * with a stored `access_tokens` row, verified by `requireAuth` exactly as in
 * production; permissions come from a role assigned to the user.
 *
 * A user's permissions are the union of their roles, so asking for two
 * different permission sets for the same user gives that user both. Use a
 * distinct user (the default is a fresh one) when a test needs a narrower set.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Organization id for a test label. UUIDs pass through; any other label
 * ("other-org-1") maps to a stable UUID so tests can name orgs freely.
 */
export const testOrgId = (label: string): string => {
  if (UUID_RE.test(label)) return label.toLowerCase();
  const h = sha(`test-org:${label}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export const ensureTestUser = async (id: string): Promise<string> => {
  await prisma.user.upsert({
    where: { id },
    update: {},
    create: {
      id,
      email: `test-user-${id}@example.com`,
      name: `Test User ${id}`,
      passwordHash: "!",
    },
  });
  return id;
};

export const ensureTestOrganization = async (
  label: string
): Promise<string> => {
  const id = testOrgId(label);
  const h = sha(`test-org-code:${id}`);
  await prisma.organization.upsert({
    where: { id },
    update: {},
    create: {
      id,
      name: `Test Org ${label}`,
      slug: `test-${id}`,
      code: h.slice(0, 6).toUpperCase(),
    },
  });
  return id;
};

/**
 * Make the user a member of the organization. Tokens minted here carry an
 * organization without one; a bucket grant in it needs the membership.
 */
export const ensureTestMembership = async (
  userId: string,
  organization: string
): Promise<void> => {
  const organizationId = await ensureTestOrganization(organization);
  await ensureTestUser(userId);
  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId, userId } },
    update: {},
    create: { organizationId, userId },
  });
};

const ensureRole = async (permissions: string[]): Promise<string> => {
  const names = [...new Set(permissions)].sort();
  const roleName = `test-perms-${sha(names.join(",")).slice(0, 16)}`;
  const find = () =>
    prisma.role.findFirst({ where: { name: roleName, serviceId: null } });
  const existing = await find();
  if (existing) return existing.id;

  const permissionIds: string[] = [];
  for (const name of names) {
    permissionIds.push((await ensurePermission(name)).id);
  }
  try {
    const role = await prisma.role.create({
      data: {
        name: roleName,
        displayName: `Test: ${names.join(", ")}`,
        rolePermissions: {
          create: permissionIds.map((permissionId) => ({ permissionId })),
        },
      },
    });
    return role.id;
  } catch (err) {
    // Another test file created the same role first.
    const raced = await find();
    if (raced) return raced.id;
    throw err;
  }
};

const assignRole = async (userId: string, roleId: string) => {
  const assigned = await prisma.userRole.findFirst({
    where: { userId, roleId, organizationId: null },
  });
  if (!assigned) {
    await prisma.userRole.create({ data: { userId, roleId } });
  }
};

let testClient: { id: string; clientId: string } | null = null;

/** The seeded login client; test tokens are issued to it. */
const getTestClient = async () => {
  if (!testClient) {
    testClient = await prisma.oAuthClient.findFirstOrThrow({
      where: { clientId: LOGIN_CLIENT.clientId },
      select: { id: true, clientId: true },
    });
  }
  return testClient;
};

export interface TestPrincipalOptions {
  /** Existing or fixture user id. Defaults to a new user. */
  userId?: string;
  /** Organization id or label; `null` for a token with no organization. */
  organizationId?: string | null;
  permissions: string[];
}

const tokenCache = new Map<string, Promise<string>>();

/**
 * A bearer token for a real user holding `permissions`. Tokens are cached per
 * (user, organization, permissions) within a test file.
 */
export const getTestPrincipalToken = (
  options: TestPrincipalOptions
): Promise<string> => {
  const userId = options.userId ?? randomUUID();
  const key = JSON.stringify([
    userId,
    options.organizationId ?? null,
    [...options.permissions].sort(),
  ]);
  let token = tokenCache.get(key);
  if (!token) {
    token = mintToken({ ...options, userId });
    tokenCache.set(key, token);
  }
  return token;
};

const mintToken = async (
  options: TestPrincipalOptions & { userId: string }
): Promise<string> => {
  const userId = await ensureTestUser(options.userId);
  const organizationId =
    options.organizationId == null
      ? undefined
      : await ensureTestOrganization(options.organizationId);
  if (options.permissions.length > 0) {
    await assignRole(userId, await ensureRole(options.permissions));
  }

  const client = await getTestClient();
  const { token, jti, expiresAt } = generateAccessToken({
    subject: userId,
    clientId: client.clientId,
    scopes: ["openid"],
    organizationId,
  });
  await prisma.accessToken.create({
    data: {
      jti,
      clientId: client.id,
      userId,
      organizationId: organizationId ?? null,
      scopes: ["openid"],
      expiresAt,
    },
  });
  return token;
};

/**
 * Users and organizations the suites reference by fixed id without holding a
 * token for them — grant targets, audit subjects. Created by globalSetup.
 */
export const FIXTURE_USER_IDS = [
  "00000000-0000-7001-0000-000000000001",
  "00000000-0000-7001-0000-000000000002",
  "00000000-0000-7001-0000-000000000003",
  "00000000-0000-7001-0000-000000000004",
  "00000000-0000-7001-0000-000000000005",
  "00000000-0000-7001-0000-000000000006",
  "00000000-0000-7001-8000-000000000001",
  "00000000-0000-7001-8000-000000000002",
];

export const FIXTURE_ORGANIZATION_IDS = [
  "00000000-0000-7002-0000-000000000001",
  "00000000-0000-7002-8000-000000000001",
  "00000000-0000-7002-8000-000000000002",
];

export const seedTestFixtures = async () => {
  await ensureTestService();
  for (const id of FIXTURE_USER_IDS) await ensureTestUser(id);
  for (const id of FIXTURE_ORGANIZATION_IDS) await ensureTestOrganization(id);
};

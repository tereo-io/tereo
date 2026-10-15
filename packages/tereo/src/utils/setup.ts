import { ConflictError, NotFoundError, UnauthorizedError } from "./errors.js";
import { computeChanges, logAuditTx } from "./outbox.js";
import { createHash, randomInt } from "crypto";
import { hashPassword } from "./crypto.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import env from "../env.js";
import {
  CORE_SERVICE_ID,
  DEFAULT_ORGANIZATION_ID,
} from "../definitions/index.js";

/**
 * First-boot setup. While no admin exists, every process start issues a
 * one-time token and prints it to the log; `POST /v1/setup` with a token creates
 * the first admin and names the default organization. Completing setup
 * deletes every outstanding token.
 */

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
// Crockford base32: no I, L, O or U, so a token read off a log survives
// transcription.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUPS = 3;
const GROUP_LENGTH = 4;

/** Uppercase, drop separators, map the letters Crockford reads as digits. */
const normalizeToken = (token: string) =>
  token
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");

// Marks a token that came from SETUP_TOKEN: generated ones expire in a day.
const ENV_TOKEN_EXPIRY = new Date("9999-12-31T23:59:59Z");

const hashToken = (token: string) =>
  createHash("sha256").update(normalizeToken(token)).digest("hex");

export const isSetupComplete = async (): Promise<boolean> => {
  const instance = await prisma.instance.findUnique({ where: { id: 1 } });
  return instance?.setupCompletedAt != null;
};

/** A fresh setup token, valid for 24 hours. Expired ones are removed. */
export const issueSetupToken = async (): Promise<string> => {
  const token = Array.from({ length: GROUPS }, () =>
    Array.from(
      { length: GROUP_LENGTH },
      () => ALPHABET[randomInt(ALPHABET.length)]
    ).join("")
  ).join("-");
  await prisma.setupToken.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  await prisma.setupToken.create({
    data: {
      hash: hashToken(token),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    },
  });
  return token;
};

/** At startup: print a setup token if setup is still pending. */
export const announceSetupIfPending = async (): Promise<void> => {
  if (await isSetupComplete()) return;
  if (env.SETUP_TOKEN) {
    const hash = hashToken(env.SETUP_TOKEN);
    await prisma.$transaction([
      prisma.setupToken.deleteMany({ where: { hash: { not: hash } } }),
      prisma.setupToken.upsert({
        where: { hash },
        create: { hash, expiresAt: ENV_TOKEN_EXPIRY },
        update: { expiresAt: ENV_TOKEN_EXPIRY },
      }),
    ]);
    logger.warn(
      { setupUrl: `${env.UI_BASE_URL}/setup` },
      "Core is not set up; use the token from SETUP_TOKEN"
    );
    return;
  }
  await prisma.setupToken.deleteMany({
    where: { expiresAt: { gte: ENV_TOKEN_EXPIRY } },
  });
  const token = await issueSetupToken();
  const url = `${env.UI_BASE_URL}/setup`;
  logger.warn(
    { setupUrl: url, setupToken: token },
    `Core is not set up. Complete setup at ${url} with this token: ${token}`
  );
};

export interface CompleteSetupInput {
  token: string;
  admin: { email: string; name: string; password: string };
  organization: { name: string; slug: string; code: string };
}

const ADMIN_ROLES = ["admin", "platform_admin"];

export const completeSetup = async (input: CompleteSetupInput) => {
  const passwordHash = await hashPassword(input.admin.password);

  const result = await prisma.$transaction(async (tx) => {
    // Serializes concurrent attempts: the second waits, then sees setup done.
    const [instance] = await tx.$queryRaw<
      { setup_completed_at: Date | null }[]
    >`SELECT "setup_completed_at" FROM "core"."instance" WHERE "id" = 1 FOR UPDATE`;
    if (!instance || instance.setup_completed_at) {
      throw new NotFoundError("Setup is already complete");
    }

    const token = await tx.setupToken.findUnique({
      where: { hash: hashToken(input.token) },
    });
    if (!token || token.expiresAt <= new Date()) {
      throw new UnauthorizedError("Invalid or expired setup token");
    }

    const { admin, organization } = input;
    if (await tx.user.findUnique({ where: { email: admin.email } })) {
      throw new ConflictError("A user with this email already exists");
    }
    const clash = await tx.organization.findFirst({
      where: {
        id: { not: DEFAULT_ORGANIZATION_ID },
        OR: [{ slug: organization.slug }, { code: organization.code }],
      },
    });
    if (clash) {
      throw new ConflictError(
        "An organization with this slug or code already exists"
      );
    }

    const roles = await tx.role.findMany({
      where: {
        name: { in: ADMIN_ROLES },
        serviceId: CORE_SERVICE_ID,
        retiredAt: null,
      },
    });
    if (roles.length !== ADMIN_ROLES.length) {
      throw new Error(
        `Roles ${ADMIN_ROLES.join(", ")} not found — core registers them on start`
      );
    }

    const user = await tx.user.create({
      data: {
        email: admin.email,
        name: admin.name,
        passwordHash,
        userType: "human",
        isActive: true,
        userRoles: { create: roles.map((role) => ({ roleId: role.id })) },
      },
    });

    const before = await tx.organization.findUniqueOrThrow({
      where: { id: DEFAULT_ORGANIZATION_ID },
    });
    const org = await tx.organization.update({
      where: { id: DEFAULT_ORGANIZATION_ID },
      data: {
        name: organization.name,
        slug: organization.slug,
        code: organization.code,
        members: {
          create: { userId: user.id, memberRole: "owner" },
        },
      },
    });

    await tx.instance.update({
      where: { id: 1 },
      data: { setupCompletedAt: new Date(), setupCompletedBy: user.id },
    });
    await tx.setupToken.deleteMany({});

    const auth = { userId: user.id, email: user.email };
    await logAuditTx(tx, {
      auth,
      action: "CREATE",
      entityType: "User",
      entityId: user.id,
      entityName: user.email,
      metadata: { email: user.email, name: user.name, via: "setup" },
    });
    await logAuditTx(tx, {
      auth,
      organizationId: org.id,
      action: "UPDATE",
      entityType: "Organization",
      entityId: org.id,
      entityName: org.name,
      changes: computeChanges(
        { name: before.name, slug: before.slug, code: before.code },
        { name: org.name, slug: org.slug, code: org.code }
      ),
      metadata: { via: "setup" },
    });

    return { user, organization: org };
  });

  logger.info(
    { userId: result.user.id, organizationId: result.organization.id },
    "Setup complete"
  );
  return result;
};

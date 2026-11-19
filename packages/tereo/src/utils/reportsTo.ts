import { assertNotSystemUser } from "../routes/v1/admin/users/user/guards.js";
import { formatReportsTo, type ReportsToUser } from "./transformers.js";
import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { computeChanges, emitTx, logAuditTx } from "./outbox.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { globalGrantablePermissions } from "./grants.js";
import type { Actor, UserRow } from "./userLifecycle.js";
import { hasPermission } from "./permissions.js";
import type { ReportRow } from "./db/reports.js";
import type { Prisma } from "./db/prisma.js";
import db from "./db/index.js";
import {
  BadRequestError,
  ForbiddenError,
  UnprocessableEntityError,
} from "./errors.js";

type Tx = Prisma.TransactionClient;

export type ReportsToView = {
  userId: string;
  reportsTo: ReportsToUser | null;
};

export type ReportsLimits = { maxUsers: number; maxDepth: number };

/** How far below a user the hierarchy is read; past it, the read is refused. */
export const REPORTS_LIMITS: ReportsLimits = {
  maxUsers: 10_000,
  maxDepth: 64,
};

const limitExceeded = (limits: ReportsLimits) =>
  new UnprocessableEntityError(
    "reports_limit_exceeded",
    `More than ${limits.maxUsers.toLocaleString("en-US")} users or ${limits.maxDepth} levels report to this user`
  );

const MANAGES_ORGS = "organizations.write";

const notAllowed = (message: string) =>
  new BadRequestError("reports_to_not_allowed", message);

/**
 * Refuses placing `userId` under another user unless the caller holds every
 * permission held by `userId` and by everyone below them: apps may let a user
 * see the records of everyone who reports to them, so placing a user under
 * someone hands that someone a view of their whole subtree. Counted as
 * `assertHoldsTargetPermissions` counts a target (guards.ts): every scope,
 * deactivated roles included, and an organization owner or admin membership
 * as `organizations.write`. Takes no authority locks, only the hierarchy's.
 */
const assertMayPlace = async (
  actor: Actor,
  userId: string,
  limits: ReportsLimits,
  tx: Tx
) => {
  const below = await db.reports.listBelow(
    userId,
    { transitive: true, ...limits },
    tx
  );
  if (below.overLimit) throw limitExceeded(limits);
  const ids = [userId, ...below.rows.map((r) => r.id)];
  const held = await db.roles.getUsersPermissionsAnywhere(ids, tx, {
    includeInactiveRoles: true,
    ignoreGuestFloor: true,
  });
  const managesOrgs = await db.organizations.hasManagingMembership(ids, tx);
  if (held.length === 0 && !managesOrgs) return;

  const callerPermissions = await globalGrantablePermissions(actor, tx);
  const lacking = held.filter((p) => !hasPermission(callerPermissions, p));
  if (lacking.length > 0) {
    throw new ForbiddenError(
      `You cannot place under another user a user, or someone reporting to them, holding permissions you do not: ${lacking.join(", ")}`
    );
  }
  if (managesOrgs && !hasPermission(callerPermissions, MANAGES_ORGS)) {
    throw new ForbiddenError(
      `You cannot place under another user an organization owner or admin, or someone reporting to them, without ${MANAGES_ORGS}`
    );
  }
};

/** Direct reports, or everyone below; refused, never cut, past the limits. */
export const listReports = async (
  userId: string,
  opts: { transitive: boolean },
  limits: ReportsLimits = REPORTS_LIMITS
): Promise<ReportRow[]> => {
  const below = await db.reports.listBelow(userId, { ...opts, ...limits });
  if (below.overLimit) throw limitExceeded(limits);
  return below.rows;
};

const auditChangeTx = async (
  tx: Tx,
  actor: Actor,
  user: UserRow,
  reportsToId: string | null
) => {
  await logAuditTx(tx, {
    auth: actor,
    action: "UPDATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    changes: computeChanges({ reportsToId: user.reportsToId }, { reportsToId }),
    metadata: { action: "reports_to_changed" },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.user.reports-to-changed",
    entityType: "User",
    entityId: user.id,
    data: {
      userId: user.id,
      email: user.email,
      reportsToId,
      previousReportsToId: user.reportsToId,
    },
  });
};

export const setReportsTo = async (
  actor: Actor,
  userId: string,
  reportsToId: string,
  limits: ReportsLimits = REPORTS_LIMITS
): Promise<ReportsToView> =>
  await db.$transaction(
    async (tx) => {
      await db.reports.lockHierarchy(tx);
      const user = await db.users.get(userId, tx);
      assertNotSystemUser(userId);
      const manager = await db.users.getFromBody(reportsToId, tx);
      if (user.userType === "service_account") {
        throw notAllowed("A service account cannot report to anyone");
      }
      if (
        manager.id === SYSTEM_USER_ID ||
        manager.userType === "service_account" ||
        manager.userType === "guest"
      ) {
        throw notAllowed(
          "No one can report to the system user, a service account or a guest"
        );
      }
      if (
        reportsToId === userId ||
        (await db.reports.chainAbove(reportsToId, tx)).includes(userId)
      ) {
        throw new BadRequestError(
          "reports_to_cycle",
          "The user cannot report to themselves or to someone who reports to them"
        );
      }
      const view = { userId, reportsTo: formatReportsTo(manager) };
      if (user.reportsToId === reportsToId) return view;

      await assertMayPlace(actor, userId, limits, tx);
      await db.reports.setReportsTo(userId, reportsToId, tx);
      await auditChangeTx(tx, actor, user, reportsToId);
      return view;
    },
    { timeout: 30_000 }
  );

export const clearReportsTo = async (
  actor: Actor,
  userId: string
): Promise<void> => {
  await db.$transaction(async (tx) => {
    await db.reports.lockHierarchy(tx);
    const user = await db.users.get(userId, tx);
    assertNotSystemUser(userId);
    if (user.reportsToId === null) return;
    await db.reports.setReportsTo(userId, null, tx);
    await auditChangeTx(tx, actor, user, null);
  });
};

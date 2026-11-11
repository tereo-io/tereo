/**
 * The user lifecycle shared by the admin API, sign-in provisioning and SCIM:
 * profile changes, deactivation, reactivation and creation into an
 * organization.
 */
import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { recordSessionsRevoked } from "./sessionEvents.js";
import { assertAdminRemains } from "./adminGuard.js";
import { formatUser } from "./transformers.js";
import type { Prisma } from "./db/prisma.js";
import { isUsableAccount } from "./users.js";
import { ConflictError } from "./errors.js";
import db from "./db/index.js";
import {
  retireAllLinks,
  issueVerifyLink,
  retirePasswordLinks,
} from "./userLinks.js";
import {
  endDeactivatedUserSessions,
  endUserSessions,
  type Caller,
} from "./sessions.js";
import {
  computeChanges,
  emitTx,
  logAuditTx,
  type AuditLogInput,
} from "./outbox.js";

type Tx = Prisma.TransactionClient;

export type Actor = AuditLogInput["auth"];

export type UserRow = Awaited<ReturnType<typeof db.users.get>>;

const auditUserUpdatedTx = async (
  tx: Tx,
  actor: Actor,
  existing: UserRow,
  updated: UserRow,
  metadata: Record<string, unknown> = {}
): Promise<void> => {
  await logAuditTx(tx, {
    auth: actor,
    action: "UPDATE",
    entityType: "User",
    entityId: updated.id,
    entityName: updated.email,
    // Never the rows themselves: they carry the password hash.
    changes: computeChanges(formatUser(existing), formatUser(updated)),
    ...(Object.keys(metadata).length > 0 && { metadata }),
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.user.updated",
    entityType: "User",
    entityId: updated.id,
    data: formatUser(updated) as unknown as Record<string, unknown>,
  });
};

export interface UserProfile {
  email?: string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  password?: string;
}

/**
 * One update of the user's row, with the profile and any change of
 * `isActive` audited together as one entry and one `auth.user.updated`.
 */
const changeUserTx = async (
  tx: Tx,
  actor: Actor,
  existing: UserRow,
  profile: UserProfile,
  opts: {
    isActive?: boolean;
    issueVerifyLinkAs?: string;
    auditMetadata?: Record<string, unknown>;
  } = {}
): Promise<UserRow> => {
  const id = existing.id;
  const newEmail =
    profile.email && profile.email !== existing.email ? profile.email : null;
  // The new address has proved nothing yet.
  const updated = await db.users.update(
    id,
    {
      ...profile,
      ...(opts.isActive !== undefined && { isActive: opts.isActive }),
    },
    tx,
    { unverify: newEmail !== null }
  );
  // An invite is matched by email: it must not follow the account to an
  // address the admin who issued it never saw.
  const invitesWithdrawn = newEmail
    ? await db.userIdentities.deleteInvitesForUser(id, tx)
    : 0;
  // Whoever holds a setup link or a forced-change grant must not keep a way
  // in past a new password, a new sign-in email or a deactivation.
  if (newEmail || opts.isActive === false) {
    await retireAllLinks(tx, id);
  } else if (profile.password) {
    await retirePasswordLinks(tx, id);
  }
  if (newEmail && isUsableAccount(updated)) {
    try {
      await issueVerifyLink(tx, {
        userId: id,
        createdBy: opts.issueVerifyLinkAs ?? actor.userId,
      });
    } catch (err) {
      // Without a connection the mail could never leave; an admin can
      // resend once one exists. The refusal comes before any write, so the
      // transaction carries on.
      if (!(
        err instanceof ConflictError && err.code === "email_not_configured"
      )) {
        throw err;
      }
    }
  }
  await auditUserUpdatedTx(tx, actor, existing, updated, {
    ...opts.auditMetadata,
    ...(profile.password && { passwordReset: true }),
    ...(invitesWithdrawn > 0 && { invitesWithdrawn }),
  });
  return updated;
};

export const updateUserProfileTx = async (
  tx: Tx,
  actor: Actor,
  existing: UserRow,
  profile: UserProfile,
  opts: {
    issueVerifyLinkAs?: string;
    auditMetadata?: Record<string, unknown>;
  } = {}
): Promise<UserRow> => changeUserTx(tx, actor, existing, profile, opts);

/**
 * `profile` is applied in the same update and audit entry as the
 * deactivation; `alsoInTx` runs after both.
 */
export const deactivateUser = async (
  actor: Actor,
  existing: UserRow,
  opts: {
    authorize?: (tx: Tx) => Promise<void>;
    alsoInTx?: (tx: Tx) => Promise<void>;
    profile?: UserProfile;
  } = {}
): Promise<UserRow> => {
  const id = existing.id;
  // Deactivation takes the authority and admin-remains locks before the
  // user's row, so it keeps its own transaction rather than running inside
  // endUserSessions, which locks the row before its callback. The user's
  // tokens fail requireAuth as soon as it commits; the sessions end right
  // after.
  const updated = await db.$transaction(
    async (tx) => {
      await opts.authorize?.(tx);
      await assertAdminRemains({ kind: "user", userId: id }, tx);
      const row = await changeUserTx(tx, actor, existing, opts.profile ?? {}, {
        isActive: false,
      });
      await opts.alsoInTx?.(tx);
      return row;
    },
    { timeout: 30_000 }
  );
  await endDeactivatedUserSessions(id, recordSessionsRevoked(actor, existing));
  return updated;
};

/**
 * `profile` is applied in the same update and audit entry as the
 * reactivation; `alsoInTx` runs after both, before the sign-out is recorded.
 */
export const reactivateUser = async (
  actor: Actor,
  existing: UserRow,
  opts: {
    authorize?: (tx: Tx) => Promise<void>;
    alsoInTx?: (tx: Tx) => Promise<void>;
    keepSession?: Caller | null;
    profile?: UserProfile;
  } = {}
): Promise<UserRow> => {
  const recordRevoked = recordSessionsRevoked(actor, existing);
  // A deactivation whose sign-out failed after it committed left sessions
  // that would otherwise come back to life with the account.
  let updated: UserRow | undefined;
  await endUserSessions(
    existing.id,
    opts.keepSession ?? null,
    async (tx, sessionIds, ssoSessionIds) => {
      updated = await changeUserTx(tx, actor, existing, opts.profile ?? {}, {
        isActive: true,
      });
      await opts.alsoInTx?.(tx);
      await recordRevoked(tx, sessionIds, ssoSessionIds);
    },
    opts.authorize
  );
  return updated as UserRow;
};

export const createUserInOrganizationTx = async (
  tx: Tx,
  actor: Actor,
  input: {
    email: string;
    name: string | null;
    firstName: string | null;
    lastName: string | null;
  },
  placement: { organizationId: string; roleIds: string[] },
  auditMetadata: Record<string, unknown>
): Promise<UserRow> => {
  const { organizationId: orgId, roleIds } = placement;
  const user = await db.users.createWithoutPassword(input, tx);
  await logAuditTx(tx, {
    auth: actor,
    action: "CREATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    metadata: {
      email: user.email,
      name: user.name,
      userType: user.userType,
      ...auditMetadata,
    },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.user.created",
    entityType: "User",
    entityId: user.id,
    data: formatUser(user) as unknown as Record<string, unknown>,
  });

  const member = await db.organizations.addMember(orgId, user.id, "member", tx);
  await logAuditTx(tx, {
    auth: actor,
    organizationId: orgId,
    action: "CREATE",
    entityType: "OrganizationMember",
    entityId: member.id,
    entityName: user.email,
    metadata: { userId: user.id, memberRole: member.memberRole },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.organization.member-added",
    entityType: "OrganizationMember",
    entityId: member.id,
    data: {
      organizationId: orgId,
      userId: user.id,
      email: user.email,
      memberRole: member.memberRole,
    },
  });

  if (roleIds.length > 0) {
    await db.organizations.setMemberRoles(orgId, user.id, roleIds, tx);
    await logAuditTx(tx, {
      auth: actor,
      organizationId: orgId,
      action: "UPDATE",
      entityType: "OrganizationMember",
      entityId: member.id,
      entityName: user.email,
      metadata: { action: "roles_changed", userId: user.id, roleIds },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.member-roles-changed",
      entityType: "OrganizationMember",
      entityId: member.id,
      data: {
        organizationId: orgId,
        userId: user.id,
        email: user.email,
        roleIds,
      },
    });
  }
  return user;
};

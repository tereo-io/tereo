import type { InviteGuestInput } from "../routes/v1/admin/guests/schemas.js";
import { AppError, BadRequestError, ConflictError } from "./errors.js";
import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { issuePasswordSetupLink } from "./passwordSetup.js";
import type { AuthContext } from "../middleware/auth.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { prisma, type Prisma } from "./db/prisma.js";
import { canActInOrganization } from "./users.js";
import { emitTx, logAuditTx } from "./outbox.js";
import { hasPermission } from "./permissions.js";
import { formatUser } from "./transformers.js";
import { normalizeEmail } from "./email.js";
import { hashPassword } from "./crypto.js";
import db from "./db/index.js";
import env from "../env.js";
import {
  OrgMemberRole,
  UserType,
} from "../../prisma/generated/client/index.js";
import {
  getGuestDefaultRoleIds,
  guestAssignableProblemsOf,
} from "./guestRoles.js";

type Tx = Prisma.TransactionClient;
type UserRow = Awaited<ReturnType<typeof db.users.get>>;
type Actor = Pick<AuthContext, "userId" | "email" | "organizationId">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const roleWithPermissions = {
  rolePermissions: {
    include: {
      permission: {
        select: { name: true, retiredAt: true, orgAssignable: true },
      },
    },
  },
} satisfies Prisma.RoleInclude;

/** A guest by id; any other user is 404 `not_a_guest`. */
export const getGuest = async (id: string, tx?: Tx): Promise<UserRow> => {
  const user = await db.users.get(id, tx);
  if (user.userType !== UserType.guest) {
    throw new AppError(404, "not_a_guest", "This user is not a guest");
  }
  return user;
};

/**
 * Guest writes reach only an organization the caller acts in: as a member, or
 * as a service account whose client belongs to it. organizations.write acts
 * in every organization.
 */
export const assertMayManageGuestsIn = async (
  auth: Pick<AuthContext, "userId" | "permissions">,
  organizationId: string | null
): Promise<void> => {
  if (hasPermission(auth.permissions, "organizations.write")) return;
  if (
    organizationId !== null &&
    (await canActInOrganization(auth.userId, organizationId))
  ) {
    return;
  }
  throw new AppError(
    403,
    "organization_not_permitted",
    "You can manage guests only in an organization you belong to"
  );
};

/** The organization a guest belongs to (exactly one). */
export const guestOrganizationId = async (
  userId: string,
  tx?: Tx
): Promise<string | null> => {
  const membership = await (tx ?? prisma).organizationMember.findFirst({
    where: { userId },
    select: { organizationId: true },
  });
  return membership?.organizationId ?? null;
};

/**
 * The roles named (custom roles by name, any role by id), each of which must
 * be guest-assignable now: flagged, and its live permissions within what a
 * guest may hold.
 */
const resolveGuestRoles = async (refs: string[], tx: Tx) => {
  const unique = [...new Set(refs)];
  if (unique.length === 0) return [];
  const ids = unique.filter((r) => UUID.test(r));
  const names = unique.filter((r) => !UUID.test(r));
  const roles = await tx.role.findMany({
    where: {
      archivedAt: null,
      retiredAt: null,
      OR: [{ id: { in: ids } }, { name: { in: names }, serviceId: null }],
    },
    include: roleWithPermissions,
  });
  const missing = unique.filter(
    (ref) => !roles.some((r) => r.id === ref.toLowerCase() || r.name === ref)
  );
  if (missing.length > 0) {
    throw new BadRequestError(
      "unknown_role",
      `Roles not found, archived or retired: ${missing.join(", ")}`
    );
  }
  const refused = roles.filter(
    (r) =>
      r.serviceId !== null ||
      !r.guestAssignable ||
      guestAssignableProblemsOf(r.rolePermissions.map((rp) => rp.permission))
        .length > 0
  );
  if (refused.length > 0) {
    throw new BadRequestError(
      "role_not_guest_assignable",
      `A guest can only hold guest-assignable roles: ${refused
        .map((r) => r.name)
        .join(", ")}`
    );
  }
  return roles;
};

/**
 * The configured defaults that are guest-assignable, live custom roles right
 * now. A default since archived, retired, deactivated or unflagged is skipped.
 */
const defaultGuestRoles = async (tx: Tx) => {
  const ids = await getGuestDefaultRoleIds(tx);
  if (ids.length === 0) return [];
  const roles = await tx.role.findMany({
    where: {
      id: { in: ids.filter((id) => UUID.test(id)) },
      serviceId: null,
      guestAssignable: true,
      isActive: true,
      archivedAt: null,
      retiredAt: null,
    },
    include: roleWithPermissions,
  });
  return roles.filter(
    (r) =>
      guestAssignableProblemsOf(r.rolePermissions.map((rp) => rp.permission))
        .length === 0
  );
};

/**
 * Adds roles to the guest's membership, keeping those held. Guest-assignable
 * roles skip "only what you hold": marking a role guest-assignable is the
 * grant decision. Returns the ids added and the access tokens revoked for a
 * role requiring 2FA.
 */
const addGuestRoles = async (
  tx: Tx,
  userId: string,
  organizationId: string,
  roles: { id: string; requires2fa: boolean }[]
) => {
  const held = (
    await db.organizations.getMemberRoles(organizationId, userId, tx)
  ).map((ur) => ur.roleId);
  const added = roles.filter((r) => !held.includes(r.id));
  if (added.length === 0) return { addedRoleIds: [], revokedJtis: [] };
  const addedRoleIds = added.map((r) => r.id);
  await db.organizations.setMemberRoles(
    organizationId,
    userId,
    [...held, ...addedRoleIds],
    tx,
    new Set(addedRoleIds)
  );
  // Permissions are read live: a token from a password-only login is
  // revoked, so its refresh meets the step-up.
  const revokedJtis = added.some((r) => r.requires2fa)
    ? await db.accessTokens.revokeWithoutMfa({ id: userId }, tx)
    : [];
  return { addedRoleIds, revokedJtis };
};

/**
 * Moves the account's expiry to `next` (null: never) and its live refresh
 * tokens with it. A token is capped at the account's expiry when issued, so
 * moving it later raises the capped ones to what they would have had: their
 * family's start plus JWT_REFRESH_TOKEN_TTL, still capped at `next`. Moving it
 * earlier lowers every token past `next`.
 */
export const setAccountExpiry = async (
  tx: Tx,
  user: { id: string; expiresAt: Date | null },
  next: Date | null,
  data: Prisma.UserUpdateInput = {}
): Promise<UserRow> => {
  // The row lock also holds back a token issue until the tokens are moved.
  const updated = await tx.user.update({
    where: { id: user.id },
    data: { ...data, expiresAt: next },
  });
  const previous = user.expiresAt;
  if (next !== null && (previous === null || next < previous)) {
    await tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: next } },
      data: { expiresAt: next },
    });
  } else if (previous !== null && (next === null || next > previous)) {
    const now = new Date();
    const capped = await tx.refreshToken.findMany({
      where: {
        userId: user.id,
        revokedAt: null,
        expiresAt: { gt: now, gte: previous },
      },
      select: { id: true, authCodeId: true, createdAt: true },
    });
    const familyIds = [
      ...new Set(capped.flatMap((t) => (t.authCodeId ? [t.authCodeId] : []))),
    ];
    // A rotated token inherits its family's expiry, so its lifetime runs
    // from the family's first token, not its own creation.
    const starts = new Map(
      (familyIds.length > 0
        ? await tx.refreshToken.groupBy({
            by: ["authCodeId"],
            where: { authCodeId: { in: familyIds } },
            _min: { createdAt: true },
          })
        : []
      ).map((g) => [g.authCodeId, g._min.createdAt])
    );
    for (const token of capped) {
      const start =
        (token.authCodeId && starts.get(token.authCodeId)) || token.createdAt;
      const familyEnd = new Date(
        start.getTime() + env.JWT_REFRESH_TOKEN_TTL * 1000
      );
      const expiresAt = next !== null && next < familyEnd ? next : familyEnd;
      if (expiresAt > previous) {
        await tx.refreshToken.update({
          where: { id: token.id },
          data: { expiresAt },
        });
      }
    }
  }
  return updated;
};

const applyInitialAccess = async (
  tx: Tx,
  auth: Actor,
  user: UserRow,
  access: InviteGuestInput["initialAccess"]
): Promise<{ user: UserRow; passwordSetupUrl?: string }> => {
  if (access.type === "password") {
    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(access.password),
        passwordChangeRequired: access.mustChange,
      },
    });
    // A link from an earlier invite would replace the password just set.
    await db.passwordSetupTokens.invalidateForUser(user.id, tx);
    return { user: updated };
  }
  const { url } = await issuePasswordSetupLink(tx, {
    userId: user.id,
    createdBy: auth.userId,
    notify: access.notify,
  });
  return { user, passwordSetupUrl: url };
};

export interface InviteGuestResult {
  user: UserRow;
  created: boolean;
  organizationId: string;
  passwordSetupUrl?: string;
  revokedJtis: string[];
}

/**
 * Invites a guest by email, or extends the guest the email already names in
 * the same organization: the later expiry wins, roles are only added, and
 * initial access applies only while they have no password. Concurrent
 * invites for one email run one at a time.
 */
export const inviteGuest = async (
  tx: Tx,
  auth: Actor & Pick<AuthContext, "permissions">,
  input: InviteGuestInput
): Promise<InviteGuestResult> => {
  const organizationId =
    input.organizationId ?? auth.organizationId ?? getDefaultOrganizationId();
  await assertMayManageGuestsIn(auth, organizationId);

  const email = normalizeEmail(input.email);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core:guest-invite:${email}`}, 0))`;
  const organization = await db.organizations.get(organizationId, tx);
  if (!organization.isActive) {
    throw new BadRequestError(
      "organization_inactive",
      "Guests cannot be invited to an inactive organization"
    );
  }

  const existing = await db.users.getByEmail(email, tx);
  if (existing) {
    return await extendInvitedGuest(tx, auth, existing, organizationId, input);
  }

  const roles = input.roles
    ? await resolveGuestRoles(input.roles, tx)
    : await defaultGuestRoles(tx);

  const created = await tx.user.create({
    data: {
      email,
      name: input.name,
      userType: UserType.guest,
      expiresAt: input.expiresAt,
      passwordHash: null,
    },
  });
  await db.organizations.addMember(
    organizationId,
    created.id,
    OrgMemberRole.member,
    tx
  );
  const { addedRoleIds } = await addGuestRoles(
    tx,
    created.id,
    organizationId,
    roles
  );
  const { user, passwordSetupUrl } = await applyInitialAccess(
    tx,
    auth,
    created,
    input.initialAccess
  );

  await logAuditTx(tx, {
    auth,
    organizationId,
    action: "CREATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    metadata: {
      action: "guest_invited",
      organizationId,
      roleIds: addedRoleIds,
      expiresAt: input.expiresAt.toISOString(),
      initialAccess: input.initialAccess.type,
    },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.guest.invited",
    entityType: "User",
    entityId: user.id,
    data: {
      ...(formatUser(user) as unknown as Record<string, unknown>),
      organizationId,
      roleIds: addedRoleIds,
    },
  });
  return {
    user,
    created: true,
    organizationId,
    passwordSetupUrl,
    revokedJtis: [],
  };
};

const extendInvitedGuest = async (
  tx: Tx,
  auth: Actor,
  found: UserRow,
  organizationId: string,
  input: InviteGuestInput
): Promise<InviteGuestResult> => {
  // Authority first, then the row, the order deactivation and promotion take
  // them in. Every check below reads the row as of the lock: one read before
  // it could let a deactivation, promotion or password set slip in between.
  await db.users.lockAuthority(found.id, tx);
  await db.users.lockForSignInChange(found.id, tx);
  const existing = await db.users.get(found.id, tx);
  if (
    existing.id === SYSTEM_USER_ID ||
    existing.userType === UserType.service_account ||
    !existing.isActive
  ) {
    throw new ConflictError(
      "This account cannot be invited as a guest",
      "user_not_invitable"
    );
  }
  if (existing.userType !== UserType.guest) {
    throw new AppError(
      409,
      "user_exists",
      "A user with this email exists; grant them access directly",
      { details: { userId: existing.id } }
    );
  }
  const memberOf = await guestOrganizationId(existing.id, tx);
  if (memberOf !== null && memberOf !== organizationId) {
    throw new ConflictError(
      "This guest belongs to another organization",
      "guest_in_other_organization"
    );
  }
  // A guest left with no organization joins the one inviting them.
  if (memberOf === null) {
    await db.organizations.addMember(
      organizationId,
      existing.id,
      OrgMemberRole.member,
      tx
    );
  }

  const roles = input.roles ? await resolveGuestRoles(input.roles, tx) : [];
  const { addedRoleIds, revokedJtis } = await addGuestRoles(
    tx,
    existing.id,
    organizationId,
    roles
  );

  const previous = existing.expiresAt;
  const expiresAt =
    previous && previous > input.expiresAt ? previous : input.expiresAt;
  let user =
    previous?.getTime() === expiresAt.getTime()
      ? existing
      : await setAccountExpiry(tx, existing, expiresAt);

  let passwordSetupUrl: string | undefined;
  if (user.passwordHash === null) {
    ({ user, passwordSetupUrl } = await applyInitialAccess(
      tx,
      auth,
      user,
      input.initialAccess
    ));
  }

  await logAuditTx(tx, {
    auth,
    organizationId,
    action: "UPDATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    metadata: {
      action: "guest_extended",
      previousExpiresAt: previous?.toISOString() ?? null,
      expiresAt: expiresAt.toISOString(),
      rolesAdded: addedRoleIds,
      ...(memberOf === null && { membershipAdded: true }),
      ...(passwordSetupUrl !== undefined && { passwordSetupLinkIssued: true }),
      ...(revokedJtis.length > 0 && {
        accessTokensRevoked: revokedJtis.length,
      }),
    },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.guest.extended",
    entityType: "User",
    entityId: user.id,
    data: {
      ...(formatUser(user) as unknown as Record<string, unknown>),
      organizationId,
      previousExpiresAt: previous?.toISOString() ?? null,
      rolesAdded: addedRoleIds,
    },
  });
  return {
    user,
    created: false,
    organizationId,
    passwordSetupUrl,
    revokedJtis,
  };
};

/** Sets a guest's expiry, earlier or later; one in the past ends access now. */
export const updateGuest = async (
  tx: Tx,
  auth: Actor & Pick<AuthContext, "permissions">,
  id: string,
  body: { expiresAt: Date; name?: string }
): Promise<UserRow> => {
  // Row-locked before the read, so a promotion committing first gives 404
  // not_a_guest rather than an expiry on a regular user.
  await db.users.lockForSignInChange(id, tx);
  const existing = await getGuest(id, tx);
  const organizationId = await guestOrganizationId(id, tx);
  await assertMayManageGuestsIn(auth, organizationId);
  const user = await setAccountExpiry(
    tx,
    existing,
    body.expiresAt,
    body.name !== undefined ? { name: body.name } : {}
  );
  await logAuditTx(tx, {
    auth,
    organizationId,
    action: "UPDATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    metadata: {
      action: "guest_extended",
      previousExpiresAt: existing.expiresAt?.toISOString() ?? null,
      expiresAt: body.expiresAt.toISOString(),
      ...(body.name !== undefined && { name: body.name }),
    },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.guest.extended",
    entityType: "User",
    entityId: user.id,
    data: {
      ...(formatUser(user) as unknown as Record<string, unknown>),
      organizationId,
      previousExpiresAt: existing.expiresAt?.toISOString() ?? null,
      rolesAdded: [],
    },
  });
  return user;
};

/**
 * Whether, once a regular user, `userId` must use 2FA: the instance policy
 * is `required`, or a live assignment of theirs is of a role requiring it.
 */
const regularUserRequires2fa = async (
  tx: Tx,
  userId: string
): Promise<boolean> => {
  const policy = await db.settings.getTotpPolicy();
  if (policy === "disabled") return false;
  if (policy === "required") return true;
  const required = await tx.userRole.count({
    where: {
      AND: [
        db.roles.liveAssignmentsWhere(userId, "memberships"),
        { role: { requires2fa: true } },
      ],
    },
  });
  return required > 0;
};

/**
 * Makes a guest a regular user: same id, membership, roles, password and
 * history, with no expiry. The caller has already passed the credential-reset
 * check, which took the authority lock. Returns the access tokens revoked
 * because the user now needs 2FA.
 */
export const promoteGuest = async (
  tx: Tx,
  auth: Actor,
  id: string
): Promise<{ user: UserRow; revokedJtis: string[] }> => {
  const existing = await getGuest(id, tx);
  const user = await setAccountExpiry(tx, existing, null, {
    userType: UserType.human,
  });
  // The policy and roles that skipped the guest now apply: a token from a
  // password-only login is revoked, so its refresh meets the step-up.
  const revokedJtis = (await regularUserRequires2fa(tx, id))
    ? await db.accessTokens.revokeWithoutMfa({ id }, tx)
    : [];
  const organizationId = await guestOrganizationId(id, tx);
  await logAuditTx(tx, {
    auth,
    organizationId,
    action: "UPDATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    metadata: {
      action: "guest_promoted",
      previousExpiresAt: existing.expiresAt?.toISOString() ?? null,
      ...(revokedJtis.length > 0 && {
        accessTokensRevoked: revokedJtis.length,
      }),
    },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.guest.promoted",
    entityType: "User",
    entityId: user.id,
    data: {
      ...(formatUser(user) as unknown as Record<string, unknown>),
      organizationId,
    },
  });
  return { user, revokedJtis };
};

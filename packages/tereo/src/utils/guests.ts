import type { InviteGuestInput } from "../routes/v1/admin/guests/schemas.js";
import { actingOrganizationIds, canActInOrganization } from "./users.js";
import { AppError, BadRequestError, ConflictError } from "./errors.js";
import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { revokeOrganizationGrantsTx } from "./bucketGrants.js";
import type { AuthContext } from "../middleware/auth.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { prisma, type Prisma } from "./db/prisma.js";
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
  issuePasswordSetupLink,
  retirePasswordLinks,
} from "./passwordSetup.js";
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

const notAGuest = () =>
  new AppError(404, "not_a_guest", "This user is not a guest");

/** A guest by id; any other user is 404 `not_a_guest`. */
export const getGuest = async (id: string, tx?: Tx): Promise<UserRow> => {
  const user = await db.users.get(id, tx);
  if (user.userType !== UserType.guest) throw notAGuest();
  return user;
};

type GuestManager = Pick<AuthContext, "userId" | "permissions">;

const managesAllGuests = (auth: GuestManager) =>
  hasPermission(auth.permissions, "organizations.write");

/**
 * A guest the caller may manage. The scope is checked before the user is
 * looked at: without organizations.write, a user who is not a guest, does
 * not exist, or is a guest outside the caller's organizations (or in none)
 * is the same 404 `not_a_guest`, so the answer reveals nothing about them.
 */
export const getManagedGuest = async (
  auth: GuestManager,
  id: string,
  tx?: Tx
): Promise<UserRow> => {
  if (managesAllGuests(auth)) return getGuest(id, tx);
  const organizationId = await guestOrganizationId(id, tx);
  if (
    organizationId === null ||
    !(await canActInOrganization(auth.userId, organizationId))
  ) {
    throw notAGuest();
  }
  const user = await (tx ?? prisma).user.findUnique({ where: { id } });
  if (user?.userType !== UserType.guest) throw notAGuest();
  return user;
};

/**
 * The guest endpoints (users.guests.*) reach only an organization the caller
 * acts in: as a member, or as a service account whose client belongs to it.
 * organizations.write acts in every organization.
 */
export const assertMayManageGuestsIn = async (
  auth: GuestManager,
  organizationId: string | null
): Promise<void> => {
  if (managesAllGuests(auth)) return;
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

/** `assertMayManageGuestsIn` for the organization guest `id` belongs to. */
export const assertMayManageGuest = async (
  auth: GuestManager,
  id: string,
  tx?: Tx
): Promise<void> =>
  assertMayManageGuestsIn(auth, await guestOrganizationId(id, tx));

/**
 * A filter on users to the guests the caller may see; undefined when they
 * see every guest.
 */
export const visibleGuestsWhere = async (
  auth: GuestManager
): Promise<Prisma.UserWhereInput | undefined> => {
  if (managesAllGuests(auth)) return undefined;
  const organizationIds = await actingOrganizationIds(auth.userId);
  return {
    organizationMembers: {
      some: {
        organizationId: { in: organizationIds },
        organization: { archivedAt: null },
      },
    },
  };
};

/**
 * Memberships that place a guest in an organization: those of organizations
 * not archived. A guest whose only membership is in an archived organization
 * belongs to none.
 */
export const liveGuestMembershipWhere = (
  userId: string
): Prisma.OrganizationMemberWhereInput => ({
  userId,
  organization: { archivedAt: null },
});

/** The organization a guest belongs to (at most one), or null. */
export const guestOrganizationId = async (
  userId: string,
  tx?: Tx
): Promise<string | null> => {
  const membership = await (tx ?? prisma).organizationMember.findFirst({
    where: liveGuestMembershipWhere(userId),
    select: { organizationId: true },
  });
  return membership?.organizationId ?? null;
};

/**
 * For an organization being restored: its guests who joined another
 * organization while it was archived leave it, so each keeps one. Their
 * roles and bucket grants in it go with the membership, as on removal.
 * Returns each released guest with the buckets whose grants were revoked.
 */
export const releaseRehomedGuestsTx = async (
  tx: Tx,
  auth: Actor,
  organizationId: string
): Promise<{ userId: string; revokedBuckets: string[] }[]> => {
  const members = await tx.organizationMember.findMany({
    where: {
      organizationId,
      user: {
        userType: UserType.guest,
        organizationMembers: {
          some: {
            organizationId: { not: organizationId },
            organization: { archivedAt: null },
          },
        },
      },
    },
    include: { user: { select: { email: true } } },
  });
  const released = [];
  for (const member of members) {
    await db.users.lockAuthority(member.userId, tx);
    await tx.userRole.deleteMany({
      where: { userId: member.userId, organizationId },
    });
    const revokedBuckets = await revokeOrganizationGrantsTx(
      tx,
      auth,
      organizationId,
      member.userId
    );
    await tx.organizationMember.delete({ where: { id: member.id } });
    await logAuditTx(tx, {
      auth,
      organizationId,
      action: "DELETE",
      entityType: "OrganizationMember",
      entityId: member.id,
      entityName: member.user.email,
      metadata: {
        userId: member.userId,
        memberRole: member.memberRole,
        reason: "guest_in_other_organization",
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.member-removed",
      entityType: "OrganizationMember",
      entityId: member.id,
      data: {
        organizationId,
        userId: member.userId,
        email: member.user.email,
        memberRole: member.memberRole,
      },
    });
    released.push({ userId: member.userId, revokedBuckets });
  }
  return released;
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
 * The audit entry and event of an organization membership being added, as
 * `POST /v1/admin/organizations/:id/members` writes them.
 */
const recordMemberAdded = async (
  tx: Tx,
  auth: Actor,
  member: Awaited<ReturnType<typeof db.organizations.addMember>>
) => {
  await logAuditTx(tx, {
    auth,
    organizationId: member.organizationId,
    action: "CREATE",
    entityType: "OrganizationMember",
    entityId: member.id,
    entityName: member.user.email,
    metadata: { userId: member.userId, memberRole: member.memberRole },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.organization.member-added",
    entityType: "OrganizationMember",
    entityId: member.id,
    data: {
      organizationId: member.organizationId,
      userId: member.userId,
      email: member.user.email,
      memberRole: member.memberRole,
    },
  });
};

/**
 * The audit entry and event of a member's organization roles changing, as
 * `PUT /v1/admin/organizations/:id/members/:userId/roles` writes them:
 * `roleIds` is the full set held afterwards.
 */
const recordMemberRolesChanged = async (
  tx: Tx,
  auth: Actor,
  organizationId: string,
  userId: string,
  revokedJtis: string[]
) => {
  const membership = await db.organizations.getMembership(
    organizationId,
    userId,
    tx
  );
  if (!membership) return;
  const roleIds = (
    await db.organizations.getMemberRoles(organizationId, userId, tx)
  ).map((ur) => ur.roleId);
  await logAuditTx(tx, {
    auth,
    organizationId,
    action: "UPDATE",
    entityType: "OrganizationMember",
    entityId: membership.id,
    entityName: membership.user.email,
    metadata: {
      action: "roles_changed",
      userId,
      roleIds,
      ...(revokedJtis.length > 0 && {
        accessTokensRevoked: revokedJtis.length,
      }),
    },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.organization.member-roles-changed",
    entityType: "OrganizationMember",
    entityId: membership.id,
    data: {
      organizationId,
      userId,
      email: membership.user.email,
      roleIds,
    },
  });
};

/**
 * An invite refused because of the account the email names. A caller who
 * cannot read users (`users.read`) gets one `409 email_unavailable` whatever
 * the reason, so an invite is not an oracle for which emails have accounts.
 */
const refuseEmail = (
  auth: Pick<AuthContext, "permissions">,
  detailed: AppError
): AppError =>
  hasPermission(auth.permissions, "users.read")
    ? detailed
    : new ConflictError(
        "This email cannot be invited as a guest",
        "email_unavailable"
      );

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
        // The inviter chose it: promotion waits for one the guest chooses.
        passwordSetByUser: false,
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
  // The user, membership and roles are recorded as their own endpoints
  // record them; the guest entry and event below add what the invite was.
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.user.created",
    entityType: "User",
    entityId: created.id,
    data: formatUser(created) as unknown as Record<string, unknown>,
  });
  const member = await db.organizations.addMember(
    organizationId,
    created.id,
    OrgMemberRole.member,
    tx
  );
  await recordMemberAdded(tx, auth, member);
  const { addedRoleIds } = await addGuestRoles(
    tx,
    created.id,
    organizationId,
    roles
  );
  if (addedRoleIds.length > 0) {
    await recordMemberRolesChanged(tx, auth, organizationId, created.id, []);
  }
  const { user, passwordSetupUrl } = await applyInitialAccess(
    tx,
    auth,
    created,
    input.initialAccess
  );

  // The user's creation entry, in the shape POST /v1/admin/users writes.
  await logAuditTx(tx, {
    auth,
    organizationId,
    action: "CREATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    metadata: {
      action: "guest_invited",
      email: user.email,
      name: user.name,
      userType: user.userType,
      organizationId,
      roleIds: addedRoleIds,
      expiresAt: input.expiresAt.toISOString(),
      initialAccess: input.initialAccess.type,
    },
  });
  await emitTx(tx, {
    organizationId,
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
  auth: Actor & Pick<AuthContext, "permissions">,
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
    throw refuseEmail(
      auth,
      new ConflictError(
        "This account cannot be invited as a guest",
        "user_not_invitable"
      )
    );
  }
  if (existing.userType !== UserType.guest) {
    throw refuseEmail(
      auth,
      new AppError(
        409,
        "user_exists",
        "A user with this email exists; grant them access directly",
        { details: { userId: existing.id } }
      )
    );
  }
  const memberOf = await guestOrganizationId(existing.id, tx);
  if (memberOf !== null && memberOf !== organizationId) {
    throw refuseEmail(
      auth,
      new ConflictError(
        "This guest belongs to another organization",
        "guest_in_other_organization"
      )
    );
  }
  // A guest left with no organization (removed, or theirs archived) joins
  // the one inviting them. That hands the inviter the guest's account, so it
  // is for whoever acts in every organization.
  if (memberOf === null) {
    if (!managesAllGuests(auth)) {
      throw refuseEmail(
        auth,
        new ConflictError(
          "This guest belongs to no organization; only an administrator of every organization can invite them into one",
          "guest_unassigned"
        )
      );
    }
    const member = await db.organizations.addMember(
      organizationId,
      existing.id,
      OrgMemberRole.member,
      tx
    );
    await recordMemberAdded(tx, auth, member);
  }

  const roles = input.roles ? await resolveGuestRoles(input.roles, tx) : [];
  const { addedRoleIds, revokedJtis } = await addGuestRoles(
    tx,
    existing.id,
    organizationId,
    roles
  );
  if (addedRoleIds.length > 0) {
    await recordMemberRolesChanged(
      tx,
      auth,
      organizationId,
      existing.id,
      revokedJtis
    );
  }

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
    organizationId,
    eventType: "auth.guest.extended",
    entityType: "User",
    entityId: user.id,
    data: {
      ...(formatUser(user) as unknown as Record<string, unknown>),
      organizationId,
      previousExpiresAt: previous?.toISOString() ?? null,
      rolesAdded: addedRoleIds,
      change: "extended",
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

type ExpiryChange = "extended" | "shortened" | "ended";

const AUDIT_ACTION: Record<ExpiryChange, string> = {
  extended: "guest_extended",
  shortened: "guest_shortened",
  ended: "guest_access_ended",
};

/**
 * Sets a guest's expiry, earlier or later. One not in the future ends access
 * now: their live access tokens are revoked as well, and their jtis returned
 * so the caller can close the sockets they hold.
 */
export const updateGuest = async (
  tx: Tx,
  auth: Actor & Pick<AuthContext, "permissions">,
  id: string,
  body: { expiresAt: Date; name?: string }
): Promise<{
  user: UserRow;
  organizationId: string | null;
  revokedJtis: string[];
}> => {
  // Row-locked before the read, so a promotion committing first gives 404
  // not_a_guest rather than an expiry on a regular user.
  await db.users.lockForSignInChange(id, tx);
  const existing = await getManagedGuest(auth, id, tx);
  const organizationId = await guestOrganizationId(id, tx);
  const now = new Date();
  const previous = existing.expiresAt;
  const change: ExpiryChange =
    body.expiresAt <= now
      ? "ended"
      : previous !== null && body.expiresAt < previous
        ? "shortened"
        : "extended";
  const user = await setAccountExpiry(
    tx,
    existing,
    body.expiresAt,
    body.name !== undefined ? { name: body.name } : {}
  );
  // Expiry is checked on every use, but a token's socket is not: revoking
  // the tokens lets the caller close their sockets too.
  const revokedJtis =
    change === "ended"
      ? (
          await tx.accessToken.updateManyAndReturn({
            where: { userId: id, revokedAt: null, expiresAt: { gt: now } },
            data: { revokedAt: now },
            select: { jti: true },
          })
        ).map((t) => t.jti)
      : [];
  await logAuditTx(tx, {
    auth,
    organizationId,
    action: "UPDATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    metadata: {
      action: AUDIT_ACTION[change],
      previousExpiresAt: previous?.toISOString() ?? null,
      expiresAt: body.expiresAt.toISOString(),
      ...(body.name !== undefined && { name: body.name }),
      ...(revokedJtis.length > 0 && {
        accessTokensRevoked: revokedJtis.length,
      }),
    },
  });
  await emitTx(tx, {
    organizationId,
    eventType: "auth.guest.extended",
    entityType: "User",
    entityId: user.id,
    data: {
      ...(formatUser(user) as unknown as Record<string, unknown>),
      organizationId,
      previousExpiresAt: previous?.toISOString() ?? null,
      rolesAdded: [],
      change,
    },
  });
  return { user, organizationId, revokedJtis };
};

/**
 * Whether, once a regular user, `userId` must use 2FA: the instance policy
 * is `required`, or a role they hold, directly or through a group, requires
 * it.
 */
const regularUserRequires2fa = async (
  tx: Tx,
  userId: string
): Promise<boolean> => {
  const policy = await db.settings.getTotpPolicy();
  if (policy === "disabled") return false;
  if (policy === "required") return true;
  return await db.roles.holdsRequires2faRole(userId, tx, {
    ignoreGuestFloor: true,
  });
};

/**
 * Makes a guest a regular user: same id, membership, roles, password and
 * history, with no expiry. The caller has already passed the credential-reset
 * check, which took the authority lock. Refused while the password is one
 * someone else chose (409 `password_not_user_set`): whoever chose it could
 * sign in as the promoted account. The guest's live setup link and pending
 * forced-change grants are retired, since their holder may be the inviter.
 * Returns the access tokens revoked because the user now needs 2FA.
 */
export const promoteGuest = async (
  tx: Tx,
  auth: Actor,
  id: string
): Promise<{ user: UserRow; revokedJtis: string[] }> => {
  // Holds back a password set until the check below commits with the change.
  await db.users.lockForSignInChange(id, tx);
  const existing = await getGuest(id, tx);
  if (existing.passwordHash !== null && !existing.passwordSetByUser) {
    throw new ConflictError(
      "The guest's password was chosen for them; reset the user's credentials first: send them a password setup link and promote them once they have set their own",
      "password_not_user_set"
    );
  }
  await retirePasswordLinks(tx, id);
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
    organizationId,
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

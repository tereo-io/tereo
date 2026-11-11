import { getDefaultOrganizationId } from "../../../../../utils/defaultOrganization.js";
import { endSession, endUserSessions } from "../../../../../utils/sessions.js";
import { recordSessionsRevoked } from "../../../../../utils/sessionEvents.js";
import { setRateLimitTx } from "../../../../../utils/rateLimitOverride.js";
import { assertAdminRemains } from "../../../../../utils/adminGuard.js";
import { formatAdminUser } from "../../../../../utils/transformers.js";
import { logAuditTx, emitTx } from "../../../../../utils/outbox.js";
import type { Prisma } from "../../../../../utils/db/prisma.js";
import { validateUser } from "../../../../../utils/auth.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  disconnectTokenSockets,
  notifyUserRolesChanged,
} from "../../../../../websocket/emitters/index.js";
import {
  deactivateUser,
  reactivateUser,
  updateUserProfileTx,
  type UserRow,
} from "../../../../../utils/userLifecycle.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  assertScimAllows,
  holdScimUserTx,
} from "../../../../../utils/scim/users.js";
import {
  listGroupRoles,
  listOrgGroupRoles,
} from "../../../../../utils/groupRoles.js";
import {
  assertCanGrant,
  globalGrantablePermissions,
} from "../../../../../utils/grants.js";
import {
  ConflictError,
  NotFoundError,
  BadRequestError,
} from "../../../../../utils/errors.js";
import {
  RevokeAllSessionsSchema,
  RevokeSessionSchema,
  SetUserRolesSchema,
  UpdateUserSchema,
  UserIdParamSchema,
} from "./schemas.js";
import {
  assertMayDisempower,
  assertMayReactivate,
  assertMayResetCredentials,
  assertNotGuest,
  assertNotServiceAccount,
  assertNotSystemUser,
  managerOf,
} from "./guards.js";

// What a user's SCIM connection owns, of what this route changes.
const PROFILE_FIELDS = ["email", "name"] as const;

export const getUser = async (req: Request, res: Response) => {
  const { id } = validateParams(UserIdParamSchema, req);
  const user = await db.users.get(id);
  res.json({ ...formatAdminUser(user), managedBy: await managerOf(user) });
};

export const updateUser = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);
  const body = validateBody(UpdateUserSchema, req);
  assertNotSystemUser(id);

  const existing = await db.users.get(id);
  await assertNotServiceAccount(existing);

  const deactivating = body.isActive === false && existing.isActive;
  const reactivating = body.isActive === true && !existing.isActive;
  if (deactivating && id === auth.userId) {
    throw new BadRequestError(
      "self_deactivation",
      "You cannot deactivate your own account"
    );
  }

  // A body repeating the current value is not a change.
  const scimChange = {
    profile: PROFILE_FIELDS.some(
      (key) => body[key] !== undefined && body[key] !== existing[key]
    ),
    reactivating,
  };
  const scimLink = await db.scim.getLinkByUser(id);
  assertScimAllows(scimLink, scimChange);
  // Switching off a managed user the IdP already deactivated still sets the
  // admin's hold, so the IdP's next active:true does not bring them back.
  const holding =
    body.isActive === false && !existing.isActive && scimLink !== null;
  // Again under the user's row lock, which SCIM's writes take, so the link
  // checked is the one the change commits against. `hold` is the admin's
  // hold a deactivation sets and a reactivation clears.
  const scimTx = async (tx: Prisma.TransactionClient, hold?: boolean) => {
    await db.users.lockForSignInChange(id, tx);
    const link = await db.scim.getLinkByUser(id, tx);
    assertScimAllows(link, scimChange);
    if (link && hold !== undefined && link.adminHold !== hold) {
      await db.scim.updateLink(link.id, { adminHold: hold }, tx);
    }
    if (holding) await holdScimUserTx(tx, auth, id);
  };

  const newEmail =
    body.email && body.email !== existing.email ? body.email : null;
  if (newEmail) {
    const emailTaken = await db.users.getByEmail(newEmail);
    if (emailTaken) throw new ConflictError("Email already in use");
  }

  const authorize = async (tx: Prisma.TransactionClient) => {
    // A new email moves the account's sign-in identifier: the same takeover.
    if (body.password || newEmail) {
      await assertMayResetCredentials(auth, id, tx);
    }
    if (deactivating || holding) {
      await assertMayDisempower(auth, id, "deactivate", tx);
    }
    if (reactivating) await assertMayReactivate(auth, id, tx);
    if (body.rateLimitPerSecond !== undefined) {
      await assertMayDisempower(auth, id, "change the rate limit of", tx);
    }
  };

  const { rateLimitPerSecond, isActive, ...profile } = body;

  const setRateLimit = async (
    tx: Prisma.TransactionClient,
    updated: UserRow
  ) => {
    if (rateLimitPerSecond === undefined) return updated;
    await setRateLimitTx(tx, auth, id, rateLimitPerSecond);
    return await db.users.get(id, tx);
  };

  const update = async (tx: Prisma.TransactionClient) => {
    // A body of only a rate limit is not a profile update.
    const profileChanged =
      rateLimitPerSecond === undefined ||
      isActive !== undefined ||
      Object.keys(profile).length > 0;
    const updated = profileChanged
      ? await updateUserProfileTx(tx, auth, existing, profile)
      : await db.users.get(id, tx);
    return await setRateLimit(tx, updated);
  };

  let newUser: UserRow | undefined;
  // The profile shares the activation change's update and audit entry; the
  // rate limit follows it in the same transaction.
  let limited: UserRow | undefined;
  const limitAfter = async (tx: Prisma.TransactionClient) => {
    if (rateLimitPerSecond !== undefined) {
      limited = await setRateLimit(tx, existing);
    }
  };
  if (deactivating) {
    const deactivated = await deactivateUser(auth, existing, {
      authorize,
      profile,
      alsoInTx: async (tx) => {
        await scimTx(tx, true);
        await limitAfter(tx);
      },
    });
    newUser = limited ?? deactivated;
  } else if (reactivating) {
    // An admin reactivating their own account keeps the session they act
    // from, as sessions/all does by default.
    const reactivated = await reactivateUser(auth, existing, {
      authorize,
      profile,
      keepSession: id === auth.userId ? auth : null,
      alsoInTx: async (tx) => {
        await scimTx(tx, false);
        await limitAfter(tx);
      },
    });
    newUser = limited ?? reactivated;
  } else if (body.password) {
    // A password reset signs the user out everywhere, in the transaction
    // that sets the password. An admin resetting their own keeps the session
    // they act from, as sessions/all does by default.
    const recordRevoked = recordSessionsRevoked(auth, existing);
    const keep = id === auth.userId ? auth : null;
    await endUserSessions(
      id,
      keep,
      async (tx, sessionIds, ssoSessionIds) => {
        await scimTx(tx);
        newUser = await update(tx);
        await recordRevoked(tx, sessionIds, ssoSessionIds);
      },
      authorize
    );
  } else {
    newUser = await db.$transaction(
      async (tx) => {
        await authorize(tx);
        await scimTx(tx);
        return await update(tx);
      },
      { timeout: 30_000 }
    );
  }

  res.json(formatAdminUser(newUser as UserRow));
};

export const getUserPermissions = async (req: Request, res: Response) => {
  const { id } = validateParams(UserIdParamSchema, req);

  await db.users.get(id);
  const permissions = await db.roles.getUserPermissions(id);
  res.json({ userId: id, permissions });
};

/**
 * A user's global roles: `roles` holds the direct assignments, whatever their
 * state (exactly what `PUT` replaces), and `groupRoles` each live role held
 * through a live global group, once per role and group. A role held both
 * ways appears in each. `orgGroupRoles` are the roles held through
 * organizations' groups, which count only within that organization.
 */
const userRolesResponse = async (
  userId: string,
  direct: Awaited<ReturnType<typeof db.roles.getGlobalUserRoles>>
) => {
  return {
    userId,
    roles: direct.map((ur) => ({
      id: ur.role.id,
      name: ur.role.name,
      displayName: ur.role.displayName,
      expiresAt: ur.expiresAt,
      via: { kind: "direct" as const },
    })),
    groupRoles: await listGroupRoles(userId, null),
    orgGroupRoles: await listOrgGroupRoles(userId),
  };
};

export const getUserRoles = async (req: Request, res: Response) => {
  const { id } = validateParams(UserIdParamSchema, req);
  await db.users.get(id);

  res.json(await userRolesResponse(id, await db.roles.getGlobalUserRoles(id)));
};

export const setUserRoles = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);
  const body = validateBody(SetUserRolesSchema, req);
  const roleIds = [...new Set(body.roleIds)];
  assertNotSystemUser(id);

  const targetUser = await db.users.get(id);
  // A service's roles are what an admin approved for it (/admin/services).
  await assertNotServiceAccount(targetUser);
  if (roleIds.length > 0) {
    assertNotGuest(
      targetUser,
      "guest_global_role",
      "A guest cannot hold global roles"
    );
  }

  // 30 s: the user's authority lock may be held by a group change, which
  // takes every member's (utils/groups.ts).
  const { userRoles, revokedJtis } = await db.$transaction(
    async (tx) => {
      // A grant races a credential reset's check of what the user holds.
      await db.users.lockAuthority(id, tx);
      // Read in the transaction, and only the roles new as of this read are
      // created: a held role removed concurrently is not put back unchecked.
      const held = new Set(
        (await db.roles.getGlobalUserRoles(id, tx)).map((ur) => ur.roleId)
      );
      // A held role stays whatever its state: archived and retired ones keep
      // their assignment to come back on restore.
      const added = roleIds.filter((roleId) => !held.has(roleId));
      const roles = await db.roles.getByIds(added, tx);
      const found = new Set(roles.map((r) => r.id));
      const missing = added.filter((roleId) => !found.has(roleId));
      if (missing.length > 0) {
        throw new BadRequestError(
          "unknown_role",
          `Roles not found, archived or retired: ${missing.join(", ")}`
        );
      }
      assertCanGrant(
        await globalGrantablePermissions(auth, tx),
        db.roles.grantedPermissionNames(roles)
      );
      if ([...held].some((roleId) => !roleIds.includes(roleId))) {
        await assertMayDisempower(auth, id, "remove roles from", tx);
      }

      // A role the user already holds keeps its row and its expiresAt, so only
      // a newly created admin assignment is sure to be live; a kept one counts
      // only if assertAdminRemains finds it unexpired. Whether the user and
      // an added role count is read under the guard's lock, which a role
      // losing admin and the user's deactivation both take.
      await assertAdminRemains(null, tx);
      const current = await db.users.get(id, tx);
      const gainsAdmin =
        current.isActive &&
        current.userType === "human" &&
        (await db.roles.getAdminRoleIds(added, tx)).length > 0;
      if (!gainsAdmin) {
        await assertAdminRemains(
          { kind: "directExcept", userId: id, keepRoleIds: roleIds },
          tx
        );
      }
      const result = await db.roles.setUserRoles(
        id,
        roleIds,
        tx,
        new Set(added)
      );
      // Permissions are read live, so a token from a password-only login would
      // carry the new role; revoked, its refresh meets the step-up.
      const revokedJtis = roles.some((r) => r.requires2fa)
        ? await db.accessTokens.revokeWithoutMfa({ id }, tx)
        : [];
      await logAuditTx(tx, {
        auth,
        action: "UPDATE",
        entityType: "User",
        entityId: id,
        entityName: targetUser.email,
        metadata: {
          action: "roles_changed",
          roleIds: roleIds,
          ...(revokedJtis.length > 0 && {
            accessTokensRevoked: revokedJtis.length,
          }),
        },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.user.roles-changed",
        entityType: "User",
        entityId: id,
        data: { userId: id, email: targetUser.email, roleIds: roleIds },
      });
      return { userRoles: result, revokedJtis };
    },
    { timeout: 30_000 }
  );

  disconnectTokenSockets(revokedJtis);
  notifyUserRolesChanged(id);

  res.json(await userRolesResponse(id, userRoles));
};

export const getUserSessions = async (req: Request, res: Response) => {
  const { currentSessionId } = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);
  await db.users.get(id);

  const refreshTokens = await db.refreshTokens.getActiveByUserId(id);

  res.json({
    userId: id,
    sessions: refreshTokens.map((rt) => ({
      id: rt.id,
      clientId: rt.client.clientId,
      clientName: rt.client.name,
      scopes: rt.scopes,
      createdAt: rt.createdAt.toISOString(),
      expiresAt: rt.expiresAt.toISOString(),
      isCurrent: rt.id === currentSessionId,
    })),
  });
};

export const revokeUserSession = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);
  const { sessionId } = validateBody(RevokeSessionSchema, req);

  const user = await db.users.get(id);
  const session = await db.refreshTokens.getActiveForUser(sessionId, id);
  if (!session) throw new NotFoundError("Session not found");

  await endSession(sessionId, recordSessionsRevoked(auth, user), (tx) =>
    assertMayDisempower(auth, id, "end a session of", tx)
  );

  res.status(204).send();
};

export const revokeAllUserSessions = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);
  const body = validateBody(RevokeAllSessionsSchema, req);

  const user = await db.users.get(id);

  // An admin signing themselves out keeps the session they act from unless
  // includeCurrentSession says otherwise.
  const revoked = await endUserSessions(
    id,
    body.includeCurrentSession ? null : auth,
    recordSessionsRevoked(auth, user),
    (tx) => assertMayDisempower(auth, id, "end all sessions of", tx)
  );

  res.json({
    revokedCount: revoked.length,
    currentSessionRevoked:
      auth.currentSessionId !== null && revoked.includes(auth.currentSessionId),
  });
};

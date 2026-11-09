import { getDefaultOrganizationId } from "../../../../../utils/defaultOrganization.js";
import { recordSessionsRevoked } from "../../../../../utils/sessionEvents.js";
import { retirePasswordLinks } from "../../../../../utils/passwordSetup.js";
import { setRateLimitTx } from "../../../../../utils/rateLimitOverride.js";
import { assertAdminRemains } from "../../../../../utils/adminGuard.js";
import { listGroupRoles } from "../../../../../utils/groupRoles.js";
import type { Prisma } from "../../../../../utils/db/prisma.js";
import { validateUser } from "../../../../../utils/auth.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  disconnectTokenSockets,
  notifyUserRolesChanged,
} from "../../../../../websocket/emitters/index.js";
import {
  formatAdminUser,
  formatUser,
} from "../../../../../utils/transformers.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  endDeactivatedUserSessions,
  endSession,
  endUserSessions,
} from "../../../../../utils/sessions.js";
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
  logAuditTx,
  computeChanges,
  emitTx,
} from "../../../../../utils/outbox.js";
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
    if (deactivating) await assertMayDisempower(auth, id, "deactivate", tx);
    if (reactivating) await assertMayReactivate(auth, id, tx);
    if (body.rateLimitPerSecond !== undefined) {
      await assertMayDisempower(auth, id, "change the rate limit of", tx);
    }
  };

  const update = async (tx: Prisma.TransactionClient) => {
    if (deactivating) {
      await assertAdminRemains({ kind: "user", userId: id }, tx);
    }
    const { rateLimitPerSecond, ...profile } = body;
    // A body of only a rate limit is not a profile update.
    const profileChanged =
      rateLimitPerSecond === undefined || Object.keys(profile).length > 0;
    let updated = profileChanged
      ? await db.users.update(id, profile, tx)
      : await db.users.get(id, tx);
    // An invite is matched by email: it must not follow the account to an
    // address the admin who issued it never saw.
    const invitesWithdrawn = newEmail
      ? await db.userIdentities.deleteInvitesForUser(id, tx)
      : 0;
    // Whoever holds a setup link or a forced-change grant must not keep a way
    // in past a new password, a new sign-in email or a deactivation.
    if (body.password || newEmail || deactivating) {
      await retirePasswordLinks(tx, id);
    }
    if (profileChanged) {
      const metadata = {
        ...(body.password && { passwordReset: true }),
        ...(invitesWithdrawn > 0 && { invitesWithdrawn }),
      };
      await logAuditTx(tx, {
        auth,
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
    }
    if (rateLimitPerSecond !== undefined) {
      await setRateLimitTx(tx, auth, id, rateLimitPerSecond);
      updated = await db.users.get(id, tx);
    }
    return updated;
  };

  let newUser: Awaited<ReturnType<typeof update>>;
  if (deactivating) {
    // Deactivation takes the authority and admin-remains locks before the
    // user's row, so it keeps its own transaction rather than running inside
    // endUserSessions, which locks the row before its callback. The user's
    // tokens fail requireAuth as soon as it commits; the sessions end right
    // after.
    newUser = await db.$transaction(
      async (tx) => {
        await authorize(tx);
        return await update(tx);
      },
      { timeout: 30_000 }
    );
    await endDeactivatedUserSessions(id, recordSessionsRevoked(auth, existing));
  } else if (body.password) {
    // A password reset signs the user out everywhere, in the transaction
    // that sets the password. An admin resetting their own keeps the session
    // they act from, as sessions/all does by default.
    const recordRevoked = recordSessionsRevoked(auth, existing);
    const keep = id === auth.userId ? auth : null;
    let reset: typeof newUser | undefined;
    await endUserSessions(
      id,
      keep,
      async (tx, sessionIds, ssoSessionIds) => {
        reset = await update(tx);
        await recordRevoked(tx, sessionIds, ssoSessionIds);
      },
      authorize
    );
    newUser = reset as typeof newUser;
  } else {
    newUser = await db.$transaction(
      async (tx) => {
        await authorize(tx);
        return await update(tx);
      },
      { timeout: 30_000 }
    );
  }

  res.json(formatAdminUser(newUser));
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
 * ways appears in each.
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

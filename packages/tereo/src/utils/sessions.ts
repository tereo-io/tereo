import { resolveCoreAccess, type CoreAccess } from "./coreAccess.js";
import type { Prisma } from "./db/prisma.js";
import db from "./db/index.js";
import {
  disconnectTokenSockets,
  disconnectUserSockets,
  notifySessionsRevoked,
} from "../websocket/emitters/index.js";

type StoredAccessToken = NonNullable<
  Awaited<ReturnType<typeof db.accessTokens.getByJti>>
>;
type StoredUser = Awaited<ReturnType<typeof db.users.get>>;

export type AccessTokenCheck =
  | {
      active: true;
      token: StoredAccessToken;
      user: StoredUser;
      /** A client_credentials token: the user is the client's service account. */
      isClientToken: boolean;
      /** What the token may do in core's own API (utils/coreAccess.ts). */
      access: CoreAccess;
    }
  | {
      active: false;
      reason: string;
      /** Set when the browser's refresh cookie for this client is dead too. */
      clearCookies?: { clientId: string; reason: string };
    };

/**
 * Whether a signature-verified access token is still good: its row exists
 * and is not revoked, its client still exists, the refresh token (session)
 * it was issued with is not revoked or rotated away, and its user is active.
 * `requireAuth`, introspection and the WebSocket handshake all answer from
 * this, so they cannot disagree. `access` says what the token may do in
 * core's own API; introspection, which answers for app services, ignores it.
 */
export const checkAccessToken = async (
  jti: string,
  clientId: string
): Promise<AccessTokenCheck> => {
  const token = await db.accessTokens.getByJti(jti);
  if (!token || token.revokedAt) {
    return { active: false, reason: "Access token has been revoked" };
  }
  if (!token.client) {
    return {
      active: false,
      reason: "Client has been deleted",
      clearCookies: { clientId, reason: "client_deleted" },
    };
  }
  if (
    token.refreshTokenId &&
    (!token.refreshToken || token.refreshToken.revokedAt)
  ) {
    return {
      active: false,
      reason: "Session has been revoked",
      clearCookies: {
        clientId: token.client.clientId,
        reason: "session_revoked",
      },
    };
  }

  const user = await db.users.get(token.userId);
  const isClientToken = user.oauthClientId === token.clientId;
  if (!user.isActive) {
    return {
      active: false,
      reason: isClientToken
        ? "Service account is inactive"
        : "User account is inactive",
    };
  }
  const access = resolveCoreAccess({
    clientId: token.client.clientId,
    isServiceClient: isClientToken || token.client.service !== null,
    scopes: token.scopes,
  });
  return { active: true, token, user, isClientToken, access };
};

/**
 * The jtis among `jtis` that `checkAccessToken` would not call active, in
 * one query: for re-checking many connected sockets at once.
 */
export const findInactiveAccessTokens = async (
  jtis: string[]
): Promise<string[]> => {
  const active = new Set(await db.accessTokens.getActiveJtis(jtis));
  return jtis.filter((jti) => !active.has(jti));
};

/** The caller whose own session and access token a sign-out leaves alone. */
export interface Caller {
  /** Its refresh token, null for a token issued without one. */
  currentSessionId: string | null;
  jti: string;
}

/**
 * Signs a user out everywhere: revokes their live refresh tokens with their
 * token families' access tokens (those of a refresh token already rotated
 * away included), access tokens issued without a refresh token, and their SSO
 * sessions so no browser can mint new ones without a password, and deletes
 * their login steps already past the password. With `keep`
 * (the caller), its session and the SSO session that session was issued
 * under survive, as does its own access token, so the caller's browser stays
 * signed in. `record` runs in the revoking transaction (an audit entry, an
 * event); `prepare` runs first in it, before any lock on the user's row.
 * Returns the revoked session ids.
 *
 * Every ending below locks the users first (`db.users.lockForSessionEnd`) and
 * reads what to revoke after: a refresh or code exchange in flight would
 * otherwise create a token family after the read that nothing revokes.
 */
export const endUserSessions = async (
  userId: string,
  keep: Caller | null = null,
  record?: RecordRevocation,
  prepare?: PrepareRevocation
): Promise<string[]> => {
  const keepRefreshTokenId = keep?.currentSessionId ?? null;
  const keepSsoSessionId = keepRefreshTokenId
    ? await db.userSessions.getIdByRefreshTokenId(keepRefreshTokenId)
    : null;
  const keepFamily = keepRefreshTokenId
    ? ((await db.refreshTokens.getById(keepRefreshTokenId))?.authCodeId ?? null)
    : null;

  const { ids, jtis } = await db.$transaction(async (tx) => {
    await prepare?.(tx);
    await db.users.lockForSessionEnd(tx, { userIds: [userId] });
    const active = await db.refreshTokens.getActiveByUserId(userId, tx);
    const ending = active.filter((rt) => rt.id !== keepRefreshTokenId);
    const ids = ending.map((rt) => rt.id);
    const jtis = await db.accessTokens.revokeByRefreshTokenIds(ids, tx);
    // The access tokens of a refresh token since rotated away fail their
    // checks already, but sit in session rooms nothing here closes: revoke
    // them with their families, the caller's spared, to close their sockets.
    const families = [
      ...new Set(
        ending.flatMap((rt) =>
          rt.authCodeId && rt.authCodeId !== keepFamily ? [rt.authCodeId] : []
        )
      ),
    ];
    jtis.push(...(await db.accessTokens.revokeByAuthCodeIds(families, tx)));
    await db.refreshTokens.revokeByIds(ids, tx);
    jtis.push(
      ...(await db.accessTokens.revokeSessionlessByUserId(
        userId,
        keep?.jti ?? null,
        tx
      ))
    );
    const ssoSessionIds = await db.userSessions.deleteUserSessionsByUserId(
      userId,
      keepSsoSessionId,
      tx
    );
    await record?.(tx, ids, ssoSessionIds);
    // After `record`, which may consume one of them itself.
    await db.loginFlows.deletePendingForUser(userId, keepSsoSessionId, tx);
    return { ids, jtis };
  });

  notifySessionsRevoked(userId, ids);
  // Sessionless tokens' sockets joined no session room, and those of rotated
  // tokens a room nothing closes.
  disconnectTokenSockets(jtis);
  return ids;
};

/**
 * Records a revocation inside the transaction that makes it: every session
 * (refresh token) revoked and every SSO session (browser) ended.
 */
export type RecordRevocation = (
  tx: Prisma.TransactionClient,
  revokedSessionIds: string[],
  endedSsoSessionIds: string[]
) => Promise<void>;

/** Runs first in a revoking transaction: the caller's locks and checks. */
export type PrepareRevocation = (tx: Prisma.TransactionClient) => Promise<void>;

export interface RevokedBrowserSessions {
  /** The refresh tokens revoked, with their users. */
  tokens: { id: string; userId: string }[];
  ssoSessionIds: string[];
  /** The access tokens revoked. */
  jtis: string[];
}

/**
 * Ends the SSO sessions and revokes every token family issued under them,
 * plus the families named directly. The caller holds the users' lock
 * (`db.users.lockForSessionEnd`) and, after commit, calls `notifyRevoked`.
 */
export const revokeBrowserSessions = async (
  tx: Prisma.TransactionClient,
  { userSessionIds, authCodeIds }: BrowserSessions
): Promise<RevokedBrowserSessions> => {
  const families = [
    ...new Set([
      ...authCodeIds,
      ...(await db.authorizationCode.getIdsByUserSessionIds(
        userSessionIds,
        tx
      )),
    ]),
  ];
  const jtis = await db.accessTokens.revokeByAuthCodeIds(families, tx);
  const tokens = await db.refreshTokens.revokeByAuthCodeIds(families, tx);
  const ssoSessionIds = await db.userSessions.deleteUserSessionsByIds(
    userSessionIds,
    tx
  );
  return { tokens, ssoSessionIds, jtis };
};

interface BrowserSessions {
  userSessionIds: string[];
  authCodeIds: string[];
}

export const notifyRevoked = (
  { tokens, jtis }: Pick<RevokedBrowserSessions, "tokens" | "jtis">,
  also: { id: string; userId: string }[] = []
) => {
  const byUser = new Map<string, Set<string>>();
  for (const { id, userId } of [...also, ...tokens]) {
    byUser.set(userId, (byUser.get(userId) ?? new Set()).add(id));
  }
  for (const [userId, ids] of byUser) notifySessionsRevoked(userId, [...ids]);
  // A family's tokens issued without a refresh token joined no session room.
  disconnectTokenSockets(jtis);
};

/**
 * Logs one browser out: ends the given SSO sessions and revokes every token
 * family issued under them, plus the families named directly (the browser's
 * own refresh token). Other browsers' sessions are untouched. `record` runs
 * in the revoking transaction.
 */
export const endBrowserSessions = async (
  sessions: BrowserSessions,
  record?: (
    tx: Prisma.TransactionClient,
    revoked: RevokedBrowserSessions
  ) => Promise<void>
): Promise<void> => {
  const revoked = await db.$transaction(async (tx) => {
    await db.users.lockForSessionEnd(tx, sessions);
    const revoked = await revokeBrowserSessions(tx, sessions);
    await record?.(tx, revoked);
    return revoked;
  });
  notifyRevoked(revoked);
};

/**
 * Ends one session as the sessions endpoints list it (a refresh token): its
 * token family, and the SSO session (browser) it was issued under with every
 * family tied to it — otherwise that browser could mint new tokens with
 * prompt=none or an org switch. Other browsers' sessions are untouched.
 * The family goes by its authorization code, so a successor rotated from the
 * token in the meantime goes too. `record` runs in the revoking transaction,
 * `prepare` first in it.
 */
export const endSession = async (
  refreshTokenId: string,
  record?: RecordRevocation,
  prepare?: PrepareRevocation
): Promise<{ ssoSessionIds: string[] }> => {
  const token = await db.refreshTokens.getById(refreshTokenId);
  if (!token) return { ssoSessionIds: [] };
  const userSessionIds = [
    await db.userSessions.getIdByRefreshTokenId(refreshTokenId),
  ].filter((id): id is string => id !== null);

  const revoked = await db.$transaction(async (tx) => {
    await prepare?.(tx);
    await db.users.lockForSessionEnd(tx, {
      userIds: [token.userId],
      userSessionIds,
    });
    const revoked = await revokeBrowserSessions(tx, {
      userSessionIds,
      authCodeIds: token.authCodeId ? [token.authCodeId] : [],
    });
    // A token without an authorization code has no family to revoke by.
    revoked.jtis.push(
      ...(await db.accessTokens.revokeByRefreshTokenIds([token.id], tx))
    );
    await db.refreshTokens.revokeByIds([token.id], tx);
    // The requested session first, then the siblings ended with its browser.
    const revokedIds = [
      ...new Set([token.id, ...revoked.tokens.map((t) => t.id)]),
    ];
    await record?.(tx, revokedIds, revoked.ssoSessionIds);
    return revoked;
  });

  notifyRevoked(revoked, [{ id: token.id, userId: token.userId }]);
  return { ssoSessionIds: revoked.ssoSessionIds };
};

/**
 * Signs a user out of one organization: every token issued under it and
 * every SSO session (browser) bound to it, with the token families those
 * browsers obtained. For a user who has just lost their membership.
 */
export const endOrganizationSessions = async (
  userId: string,
  organizationId: string
): Promise<void> => {
  try {
    await endOrganizationTokens(userId, organizationId);
  } finally {
    // Access tokens issued there without a session have no session room.
    // Closed even if the revocation failed: whatever the user still holds
    // there is dead with the membership.
    disconnectUserSockets(userId, organizationId);
  }
};

const endOrganizationTokens = async (
  userId: string,
  organizationId: string
) => {
  const { revoked, loose } = await db.$transaction(async (tx) => {
    await db.users.lockForSessionEnd(tx, { userIds: [userId] });
    const userSessionIds = await db.userSessions.getIdsByUserAndOrganization(
      userId,
      organizationId,
      tx
    );
    const refreshTokens = await db.refreshTokens.getActiveByUserAndOrganization(
      userId,
      organizationId,
      tx
    );
    const revoked = await revokeBrowserSessions(tx, {
      userSessionIds,
      authCodeIds: refreshTokens.flatMap((rt) =>
        rt.authCodeId ? [rt.authCodeId] : []
      ),
    });

    // Tokens with no family, and access tokens issued without a refresh token.
    const loose = refreshTokens
      .filter((rt) => !rt.authCodeId)
      .map((rt) => rt.id);
    await db.accessTokens.revokeByRefreshTokenIds(loose, tx);
    await db.refreshTokens.revokeByIds(loose, tx);
    await db.accessTokens.revokeByUserAndOrganization(
      userId,
      organizationId,
      tx
    );
    return { revoked, loose };
  });

  notifyRevoked(
    revoked,
    loose.map((id) => ({ id, userId }))
  );
};

/**
 * Signs a deactivated user out everywhere, and closes all their sockets —
 * including those of tokens issued without a session. The deactivation has
 * committed already, so the sockets close even if the sign-out fails.
 */
export const endDeactivatedUserSessions = async (
  userId: string,
  record?: RecordRevocation
): Promise<string[]> => {
  try {
    return await endUserSessions(userId, null, record);
  } finally {
    disconnectUserSockets(userId);
  }
};

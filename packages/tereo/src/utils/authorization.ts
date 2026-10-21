import { generateAuthorizationCode, generateRandomString } from "./crypto.js";
import { maySelectOrganization } from "./supportAccess.js";
import { LOGIN_CLIENT } from "../definitions/index.js";
import type { Request, Response } from "express";
import { emitTx, logAuditTx } from "./outbox.js";
import type { Prisma } from "./db/prisma.js";
import { OAuth2Error } from "./errors.js";
import db from "./db/index.js";
import env from "../env.js";
import {
  notifyRevoked,
  revokeBrowserSessions,
  type RevokedBrowserSessions,
} from "./sessions.js";
import {
  clearUserSessionCookie,
  getUserSessionFromCookie,
  setUserSessionCookie,
} from "./cookies.js";

const ACR_PWD = "urn:auth-service:pwd";
const ACR_MFA = "urn:auth-service:mfa";

/**
 * An authorization response for the client: its redirect URI with `params`
 * (empty ones left out) and, per RFC 9207, `iss`, so a client talking to
 * several servers can tell which one answered. Every redirect to a client,
 * code or error, goes through here.
 */
export const authorizationResponseUrl = (
  redirectUri: string,
  params: Record<string, string | null | undefined>
): string => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", env.ISSUER);
  return url.toString();
};

/**
 * Whether the login used a second factor: a TOTP, a recovery code, or `mfa`,
 * which a provider login records when the provider vouched for one.
 */
export const usedMfa = (authMethods: string[]): boolean =>
  authMethods.includes("otp") ||
  authMethods.includes("recovery") ||
  authMethods.includes("mfa");

/**
 * Whether `acr_values` demands a second factor: it names the MFA class and
 * not the password one. Core treats the values it advertises as required,
 * not merely preferred, since a client asking for MFA cannot use less.
 */
export const requiresMfa = (acrValues: string | null | undefined): boolean => {
  const values = (acrValues ?? "").split(" ").filter(Boolean);
  return values.includes(ACR_MFA) && !values.includes(ACR_PWD);
};

/**
 * Whether a login without a second factor no longer suffices: 2FA has been
 * required of the user (`userRequires2fa`, the rule the password step
 * applies) since it. What that login left — an SSO session, a token family —
 * then goes back through the login, which asks for the factor or for
 * enrolment. Enrolling of one's own accord does not count: the session that
 * enrolled is kept on purpose.
 */
export const stepUpRequired = async (
  userId: string,
  authMethods: string[]
): Promise<boolean> =>
  !usedMfa(authMethods) && (await db.totp.userRequires2fa(userId));

/** An authorization request whose user has signed in, ready for a code. */
export interface ApprovedAuthorization {
  userId: string;
  organizationId: string | null;
  redirectUri: string;
  scopes: string[];
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  nonce: string | null;
  authTime: Date;
  maxAge: number | null;
  acrValues: string | null;
  authMethods: string[];
  /**
   * The SSO session a request without credentials (prompt=none, an org
   * switch) continues; null after a login with credentials.
   */
  userSessionId: string | null;
}

type LoginFlow = Omit<
  ApprovedAuthorization,
  "organizationId" | "userSessionId"
>;

/** The approval of a flow whose user just signed in with credentials. */
export const grantAfterLogin = (
  flow: LoginFlow,
  organizationId: string | null
): ApprovedAuthorization => ({
  userId: flow.userId,
  organizationId,
  redirectUri: flow.redirectUri,
  scopes: flow.scopes,
  state: flow.state,
  codeChallenge: flow.codeChallenge,
  codeChallengeMethod: flow.codeChallengeMethod,
  nonce: flow.nonce,
  authTime: flow.authTime,
  maxAge: flow.maxAge,
  acrValues: flow.acrValues,
  authMethods: flow.authMethods,
  userSessionId: null,
});

/**
 * Issues the authorization code for an approved request and starts (or
 * continues) this browser's SSO session, setting its cookie. Returns the
 * client's redirect URI with the code and state, or with `login_required`
 * when the SSO session a request without credentials continues has ended.
 * `consumeStep` spends the login step that led here under the user's lock
 * and throws when it is gone, so a sign-out that deleted it (a password
 * change) cannot be followed by a code.
 */
export const issueAuthorizationCode = async (
  req: Request,
  res: Response,
  client: { id: string; clientId: string },
  grant: ApprovedAuthorization,
  consumeStep?: (tx: Prisma.TransactionClient) => Promise<void>
): Promise<string> => {
  const { code, codeHash } = generateAuthorizationCode(client.clientId);

  const { authMethods } = grant;
  // Every path to a code checks this first; a request for MFA never ends in
  // a code for a login without one.
  if (requiresMfa(grant.acrValues) && !usedMfa(authMethods)) {
    throw new OAuth2Error(
      "interaction_required",
      "The request requires two-factor authentication"
    );
  }
  // Nor does a request without credentials continue such a login once 2FA
  // has been required of the user.
  if (
    grant.userSessionId !== null &&
    (await stepUpRequired(grant.userId, authMethods))
  ) {
    throw new OAuth2Error(
      "interaction_required",
      "Two-factor authentication is required"
    );
  }
  const acrValue = usedMfa(authMethods) ? ACR_MFA : ACR_PWD;

  const cookieToken = getUserSessionFromCookie(req, client.clientId);

  const issued = await db.$transaction(async (tx) => {
    // The user's row before any SSO session row, in the order every
    // session end takes them; the sessions are read under the lock, so a
    // logout that committed first is seen.
    await db.users.lockForTokenIssue(grant.userId, tx);
    await consumeStep?.(tx);

    const freshLogin = grant.userSessionId === null;
    const continued = grant.userSessionId
      ? await db.userSessions.getUserSessionById(grant.userSessionId, tx)
      : null;
    // Logged out, or signed out everywhere, since the request was let in.
    if (
      !freshLogin &&
      (!continued ||
        continued.userId !== grant.userId ||
        continued.expiresAt <= new Date())
    ) {
      return null;
    }
    // USER_SESSION_TTL is absolute: a session continued without a password
    // keeps the expiry of the one it came from.
    const userSessionExpiresAt = new Date(
      Math.min(
        Date.now() + env.USER_SESSION_TTL * 1000,
        continued?.expiresAt.getTime() ?? Infinity
      )
    );

    // One SSO session per browser: a browser that already holds a live one
    // for this user keeps its row, so every token family issued here is
    // tied to it and logging this browser out reaches all of them. A
    // password login gives it a new token, so a token planted or leaked
    // before it is worth nothing after (session fixation).
    const current = cookieToken
      ? await db.userSessions.getUserSessionByToken(cookieToken, tx, {
          includeIdle: true,
        })
      : null;
    const reuse =
      current &&
      current.userId === grant.userId &&
      current.expiresAt > new Date();
    // A session the new one does not continue (another user's, or expired)
    // is replaced here, once a login has succeeded: prompt=login leaves it
    // alone.
    const replaced = current && !reuse ? current : null;
    const sessionToken =
      reuse && cookieToken && !freshLogin
        ? cookieToken
        : generateRandomString(32);
    const userSessionData = {
      sessionToken,
      userId: grant.userId,
      // null, not undefined: a reused session must drop the org of an
      // earlier grant rather than keep it when this one has none.
      organizationId: grant.organizationId,
      authTime: grant.authTime,
      authMethods,
      acrValue,
      expiresAt: userSessionExpiresAt,
    };

    // Another user's session ends as a logout of this browser would, with
    // the token families issued under it; this user's own expired one goes.
    let revokedOther: RevokedBrowserSessions | null = null;
    if (replaced && replaced.userId !== grant.userId) {
      await db.users.lockForSessionEnd(tx, { userSessionIds: [replaced.id] });
      revokedOther = await revokeBrowserSessions(tx, {
        userSessionIds: [replaced.id],
        authCodeIds: [],
      });
    } else if (replaced) {
      await db.userSessions.deleteUserSessionsByIds([replaced.id], tx);
    }
    const session = reuse
      ? await db.userSessions.updateUserSession(current.id, userSessionData, tx)
      : await db.userSessions.createUserSession(userSessionData, tx);

    await db.authorizationCode.create(
      {
        codeHash,
        clientId: client.id,
        userId: grant.userId,
        organizationId: grant.organizationId ?? undefined,
        redirectUri: grant.redirectUri,
        scopes: grant.scopes,
        codeChallenge: grant.codeChallenge,
        codeChallengeMethod: grant.codeChallengeMethod as "S256",
        nonce: grant.nonce ?? undefined,
        authTime: grant.authTime,
        expiresAt: new Date(Date.now() + env.AUTHORIZATION_CODE_TTL * 1000),
        maxAge: grant.maxAge ?? undefined,
        acrValues: grant.acrValues ?? undefined,
        authMethods,
        userSessionId: session.id,
      },
      tx
    );

    // Callers let a non-member select the organization only through
    // support access, which its admins see as an entry and an event: once
    // per selection, so not for a silent re-issue in the organization the
    // continued session already holds, nor for one who no longer holds it.
    const support =
      !!grant.organizationId &&
      continued?.organizationId !== grant.organizationId &&
      (await maySelectOrganization(grant.userId, grant.organizationId, tx))
        .support;
    const user =
      freshLogin || support ? await db.users.get(grant.userId, tx) : null;

    if (support && user && grant.organizationId) {
      await logAuditTx(tx, {
        auth: { userId: user.id, email: user.email },
        organizationId: grant.organizationId,
        action: "LOGIN",
        entityType: "Organization",
        entityId: grant.organizationId,
        metadata: {
          action: "support_access",
          client_id: client.clientId,
          sid: session.id,
        },
      });
      await emitTx(tx, {
        organizationId: grant.organizationId,
        eventType: "auth.organization.support-access",
        entityType: "Organization",
        entityId: grant.organizationId,
        data: {
          userId: user.id,
          organizationId: grant.organizationId,
          clientId: client.clientId,
        },
      });
    }

    if (freshLogin && user) {
      await logAuditTx(tx, {
        auth: { userId: user.id, email: user.email },
        organizationId: grant.organizationId,
        action: "LOGIN",
        entityType: "User",
        entityId: user.id,
        entityName: user.email,
        metadata: {
          client_id: client.clientId,
          sid: session.id,
          auth_methods: authMethods,
        },
      });
    }
    return { sessionToken, userSessionExpiresAt, revokedOther };
  });
  if (issued?.revokedOther) notifyRevoked(issued.revokedOther);
  if (!issued) {
    clearUserSessionCookie(res, client.clientId);
    return authorizationResponseUrl(grant.redirectUri, {
      error: "login_required",
      error_description: "User session ended",
      state: grant.state,
    });
  }
  const { sessionToken, userSessionExpiresAt } = issued;

  setUserSessionCookie(
    res,
    sessionToken,
    Math.max(
      0,
      Math.floor((userSessionExpiresAt.getTime() - Date.now()) / 1000)
    ),
    client.clientId
  );

  return authorizationResponseUrl(grant.redirectUri, {
    code,
    state: grant.state,
  });
};

/** The authorize request as the login flow carries it between steps. */
export interface AuthorizeRequestParams {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  nonce: string | null;
  maxAge: number | null;
  acrValues: string | null;
  prompt: string | null;
}

/**
 * The authorize request's parameters, for the UI's login-flow pages: with
 * them "Back to sign in" restarts /oauth/authorize for the client that began
 * the login (whose PKCE verifier and state it still holds) rather than the
 * admin UI. Absent values are left out.
 */
export const authorizeRestartParams = (
  p: AuthorizeRequestParams
): Record<string, string> => {
  const params: Record<string, string> = {
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: p.scopes.join(" "),
    state: p.state ?? "",
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
    nonce: p.nonce ?? "",
    max_age: p.maxAge?.toString() ?? "",
    acr_values: p.acrValues ?? "",
    prompt: p.prompt ?? "",
  };
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== ""));
};

/** A UI page URL with the given query parameters. */
export const uiUrl = (path: string, params: Record<string, string>): string => {
  const url = new URL(`${env.UI_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

/**
 * The origin of an http(s) URI, or null for any other (a native app's
 * custom scheme has no origin a browser page could send).
 */
export const httpOrigin = (uri: string): string | null => {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
};

/**
 * Where a user goes to sign in to a client again when no authorize request is
 * at hand (after logging out of it): the admin UI's root for core's own
 * client, otherwise the origin of the client's first web redirect URI, and
 * the UI's root for a client with none (a native app).
 */
export const clientSignInUrl = (client: {
  clientId: string;
  redirectUris: string[];
}): string => {
  const origin =
    client.clientId === LOGIN_CLIENT.clientId
      ? null
      : client.redirectUris.map(httpOrigin).find((o) => o !== null);
  return `${origin ?? env.UI_BASE_URL}/`;
};

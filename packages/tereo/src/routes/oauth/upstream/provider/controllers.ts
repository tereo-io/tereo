import type { UpstreamAuthErrorCode } from "../../../../utils/identityProviders/errors.js";
import type { NormalizedIdentity } from "../../../../utils/identityProviders/types.js";
import type { UpstreamRoundTrip } from "../../../../utils/identityProviders/begin.js";
import type { ResolveFailure } from "../../../../utils/identityProviders/resolve.js";
import { getDefaultOrganizationId } from "../../../../utils/defaultOrganization.js";
import { UpstreamAuthError } from "../../../../utils/identityProviders/errors.js";
import { beginUpstreamAuth } from "../../../../utils/identityProviders/begin.js";
import type { AuthorizeRequestParams } from "../../../../utils/authorization.js";
import { continueAfterFirstFactor } from "../../../../utils/firstFactor.js";
import { recordSessionsRevoked } from "../../../../utils/sessionEvents.js";
import { uniqueViolationFields } from "../../../../utils/prismaErrors.js";
import { emailDomain, normalizeEmail } from "../../../../utils/email.js";
import { authFailure } from "../../../../middleware/rateLimit.js";
import { emitTx, logAuditTx } from "../../../../utils/outbox.js";
import { endUserSessions } from "../../../../utils/sessions.js";
import { hashTotpSetupGrant } from "../../../../utils/totp.js";
import { hashFlowToken } from "../../../../utils/crypto.js";
import { logger } from "../../../../utils/logger.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import env from "../../../../env.js";
import type {
  IdentityLinkGrant,
  IdentityProvider,
  UpstreamAuthSession,
  User,
} from "../../../../../prisma/generated/client/index.js";
import {
  emailTrusted,
  linkIdentity,
  resolveLoginIdentity,
  ssoProviderElsewhere,
} from "../../../../utils/identityProviders/resolve.js";
import {
  upstreamAuthTime,
  upstreamReauth,
} from "../../../../utils/identityProviders/reauth.js";
import {
  adapterFor,
  upstreamCallbackUrl,
} from "../../../../utils/identityProviders/index.js";
import {
  authorizeRestartParams,
  uiUrl,
} from "../../../../utils/authorization.js";
import {
  validateParams,
  validateQuery,
} from "../../../../utils/validateReq.js";
import {
  UPSTREAM_AUTH_TTL_SECONDS,
  clearIdentityLinkGrantCookie,
  clearUpstreamAuthCookie,
  getAuthSessionFromCookie,
  getIdentityLinkGrantFromCookie,
  getUpstreamAuthFromCookie,
  setUpstreamAuthCookie,
} from "../../../../utils/cookies.js";
import {
  NotFoundError,
  OAuth2Error,
  TooManyRequestsError,
} from "../../../../utils/errors.js";
import {
  authorizeRequestParams,
  getClientForAuthorize,
} from "../../authorize/utils.js";
import {
  UpstreamCallbackQuerySchema,
  UpstreamProviderParamsSchema,
  UpstreamStartGrantQuerySchema,
  UpstreamStartQuerySchema,
} from "./schemas.js";

type UpstreamLoginError =
  | UpstreamAuthErrorCode
  | ResolveFailure
  | "session_expired"
  | "provider_inactive"
  | "account_inactive"
  | "identity_in_use"
  | "already_linked"
  | "account_mismatch"
  | "upstream_reauth_failed"
  | "sso_required"
  | "too_many_attempts";

/** Ends a callback on the UI's login page; `restart` is the authorize request to retry. */
class LoginFailure extends Error {
  constructor(
    public code: UpstreamLoginError,
    public restart: Record<string, string> = {}
  ) {
    super(code);
  }
}

const loginPage = (error: UpstreamLoginError, restart = {}) =>
  uiUrl("/login", { ...restart, error });

type UpstreamLinkError =
  | UpstreamAuthErrorCode
  | "session_expired"
  | "provider_inactive"
  | "account_inactive"
  | "identity_in_use"
  | "already_linked"
  | "sso_required"
  | "too_many_attempts";

/** Ends a link callback on the UI's account page, where linking began. */
class LinkFailure extends Error {
  constructor(public code: UpstreamLinkError) {
    super(code);
  }
}

export const upstreamStart = async (req: Request, res: Response) => {
  if (req.query.grant !== undefined) {
    await startForcedLink(req, res);
    return;
  }
  const { slug } = validateParams(UpstreamProviderParamsSchema, req);
  const query = validateQuery(UpstreamStartQuerySchema, req);

  const client = await getClientForAuthorize(query.client_id);
  if (!client.grantTypes.includes("authorization_code")) {
    throw new OAuth2Error(
      "unauthorized_client",
      "Client not authorized for authorization code grant"
    );
  }
  if (!client.redirectUris.includes(query.redirect_uri)) {
    throw new OAuth2Error("invalid_request", "Invalid redirect URI");
  }

  const request = authorizeRequestParams(query);
  const restart = authorizeRestartParams(request);
  if (!getAuthSessionFromCookie(req, client.clientId)) {
    res.redirect(loginPage("session_expired", restart));
    return;
  }

  const provider = await db.identityProviders.getBySlug(slug);
  if (!provider?.isActive) {
    res.redirect(loginPage("provider_inactive", restart));
    return;
  }

  let trip: UpstreamRoundTrip;
  try {
    trip = await beginUpstreamAuth(provider, upstreamReauth(request));
  } catch (err) {
    if (!(err instanceof UpstreamAuthError)) throw err;
    logger.warn({ err, provider: provider.slug }, "Upstream sign-in failed");
    res.redirect(loginPage(err.code, restart));
    return;
  }

  await db.upstreamAuth.createSession({
    stateHash: trip.stateHash,
    providerId: provider.id,
    purpose: "login",
    nonce: trip.nonce,
    codeVerifier: trip.codeVerifier,
    clientId: client.id,
    redirectUri: request.redirectUri,
    scopes: request.scopes,
    state: request.state,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    clientNonce: request.nonce,
    maxAge: request.maxAge,
    acrValues: request.acrValues,
    prompt: request.prompt,
    expiresAt: new Date(Date.now() + UPSTREAM_AUTH_TTL_SECONDS * 1000),
  });

  setUpstreamAuthCookie(res, trip.state);
  res.redirect(trip.providerUrl.toString());
};

/**
 * The link-required page's button. The grant must come with its cookie, from
 * the browser that entered the password, and `slug` must be the provider
 * that owns the user's domain, so the grant links nothing else.
 */
const startForcedLink = async (req: Request, res: Response) => {
  const { slug } = validateParams(UpstreamProviderParamsSchema, req);
  const { grant } = validateQuery(UpstreamStartGrantQuerySchema, req);

  const linkGrant = await db.upstreamAuth.getLinkGrant(
    hashTotpSetupGrant(grant)
  );
  if (!linkGrant) {
    res.redirect(loginPage("session_expired"));
    return;
  }
  const client = await db.clients.get(linkGrant.clientId).catch((err) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });
  if (!client) {
    res.redirect(loginPage("session_expired"));
    return;
  }
  if (!client.grantTypes.includes("authorization_code")) {
    throw new OAuth2Error(
      "unauthorized_client",
      "Client not authorized for authorization code grant"
    );
  }
  const request = grantRequest(linkGrant, client.clientId);
  const restart = authorizeRestartParams(request);

  const cookie = getIdentityLinkGrantFromCookie(req, client.clientId);
  if (!cookie || hashTotpSetupGrant(cookie) !== linkGrant.tokenHash) {
    res.redirect(loginPage("session_expired", restart));
    return;
  }

  const user = await db.users.get(linkGrant.userId);
  const domain = await db.identityProviders.findDomain(emailDomain(user.email));
  if (!domain?.ssoOnly || domain.provider.slug !== slug) {
    res.redirect(loginPage("session_expired", restart));
    return;
  }
  const { provider } = domain;
  if (!provider.isActive) {
    res.redirect(loginPage("provider_inactive", restart));
    return;
  }

  let trip: UpstreamRoundTrip;
  try {
    trip = await beginUpstreamAuth(provider, upstreamReauth(request));
  } catch (err) {
    if (!(err instanceof UpstreamAuthError)) throw err;
    logger.warn({ err, provider: provider.slug }, "Upstream sign-in failed");
    res.redirect(loginPage(err.code, restart));
    return;
  }

  await db.upstreamAuth.createSession({
    stateHash: trip.stateHash,
    providerId: provider.id,
    purpose: "forced_link",
    userId: user.id,
    linkGrantId: linkGrant.id,
    nonce: trip.nonce,
    codeVerifier: trip.codeVerifier,
    clientId: client.id,
    redirectUri: request.redirectUri,
    scopes: request.scopes,
    state: request.state,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    clientNonce: request.nonce,
    maxAge: request.maxAge,
    acrValues: request.acrValues,
    prompt: request.prompt,
    expiresAt: new Date(Date.now() + UPSTREAM_AUTH_TTL_SECONDS * 1000),
  });

  setUpstreamAuthCookie(res, trip.state);
  res.redirect(trip.providerUrl.toString());
};

export const upstreamCallback = async (req: Request, res: Response) => {
  clearUpstreamAuthCookie(res);
  let next: string;
  try {
    next = await completeCallback(req, res);
  } catch (err) {
    if (err instanceof LoginFailure) {
      res.redirect(loginPage(err.code, err.restart));
      return;
    }
    if (err instanceof LinkFailure) {
      res.redirect(uiUrl("/account", { error: err.code }));
      return;
    }
    throw err;
  }
  await authFailure.refund(req);
  res.redirect(next);
};

/**
 * Where the browser goes next; throws LoginFailure for the login page, or
 * LinkFailure for the account page once the session shows a link.
 */
const completeCallback = async (
  req: Request,
  res: Response
): Promise<string> => {
  // No provider has a malformed slug: the browser lands on the login page as
  // for an unknown one, not on a JSON 400.
  const params = UpstreamProviderParamsSchema.safeParse(req.params);
  if (!params.success) throw new LoginFailure("session_expired");
  const { slug } = params.data;
  const { state } = validateQuery(UpstreamCallbackQuerySchema, req);
  const cookie = getUpstreamAuthFromCookie(req);
  if (!state || !cookie) throw new LoginFailure("session_expired");
  const stateHash = hashFlowToken(state);
  if (hashFlowToken(cookie) !== stateHash) {
    throw new LoginFailure("session_expired");
  }

  const provider = await db.identityProviders.getBySlug(slug);
  if (!provider) throw new LoginFailure("session_expired");
  // Scoped to this provider: a state begun at another one is not found here
  // (mix-up defence), and is left unconsumed.
  const session = await db.upstreamAuth.consumeSession(stateHash, provider.id);
  if (!session) throw new LoginFailure("session_expired");

  // Only now is an attempt spent: the callback has no client_id, so the key
  // is the address alone, and a page anywhere could otherwise send cookieless
  // callbacks from a visitor's browser to lock out everyone behind its IP.
  const limited = await authFailure.check(req).then(
    () => false,
    (err: unknown) => {
      if (err instanceof TooManyRequestsError) return true;
      throw err;
    }
  );

  switch (session.purpose) {
    case "login":
      return await completeLogin(req, res, provider, session, state, limited);
    case "link":
      return await completeLink(req, provider, session, state, limited);
    case "forced_link":
      return await completeForcedLink(
        req,
        res,
        provider,
        session,
        state,
        limited
      );
    default:
      throw new LoginFailure("session_expired");
  }
};

const completeLogin = async (
  req: Request,
  res: Response,
  provider: IdentityProvider,
  session: UpstreamAuthSession,
  state: string,
  limited: boolean
): Promise<string> => {
  if (!session.clientId) throw new LoginFailure("session_expired");
  const client = await db.clients.get(session.clientId).catch((err) => {
    if (err instanceof NotFoundError) throw new LoginFailure("session_expired");
    throw err;
  });
  const request = storedRequest(session, client.clientId);
  if (!request) throw new LoginFailure("session_expired");
  const restart = authorizeRestartParams(request);
  const fail = (code: UpstreamLoginError) => new LoginFailure(code, restart);

  if (limited) throw fail("too_many_attempts");
  if (!provider.isActive) throw fail("provider_inactive");

  const identity = await completeAtProvider(
    req,
    provider,
    session,
    state,
    fail
  );

  const resolution = await resolveLoginIdentity(provider, identity);
  if ("error" in resolution) {
    if (resolution.error === "sso_required") {
      // Names the provider to sign in with, as the password POST does.
      throw new LoginFailure("sso_required", {
        ...restart,
        provider: resolution.provider.slug,
      });
    }
    throw fail(resolution.error);
  }

  const user = await db.users.get(resolution.userId);
  if (!user.isActive || user.userType !== "human") {
    throw fail("account_inactive");
  }
  const linked = await db.userIdentities.getForUserAtProvider(
    user.id,
    provider.id
  );
  if (!linked) throw fail("no_account");

  return await continueProviderLogin(req, res, provider, user, linked.id, {
    client,
    request,
    authTime: authTimeOrFail(provider, identity, request, session, fail),
  });
};

/** The provider's `auth_time`, unless it falls short of the request's re-authentication. */
const authTimeOrFail = (
  provider: IdentityProvider,
  identity: NormalizedIdentity,
  request: AuthorizeRequestParams,
  session: UpstreamAuthSession,
  fail: (code: UpstreamLoginError) => Error
): Date => {
  const reauth = upstreamReauth(request);
  const authTime = upstreamAuthTime(identity, reauth, session.createdAt);
  if (!authTime) {
    logger.warn(
      {
        provider: provider.slug,
        authTime: identity.authTime,
        maxAge: reauth.maxAge,
        promptLogin: reauth.promptLogin,
      },
      "Upstream sign-in did not re-authenticate as requested"
    );
    throw fail("upstream_reauth_failed");
  }
  return authTime;
};

/** The provider was the first factor: on to TOTP, organization and consent. */
const continueProviderLogin = async (
  req: Request,
  res: Response,
  provider: IdentityProvider,
  user: User,
  identityId: string,
  {
    client,
    request,
    authTime,
  }: {
    client: {
      id: string;
      clientId: string;
      scopes: string[];
      consentRequired: boolean;
      trustedCoreScopes: string[];
    };
    request: AuthorizeRequestParams;
    authTime: Date;
  }
): Promise<string> => {
  const authMethods = provider.countsAsMfa ? ["fed", "mfa"] : ["fed"];

  // The LOGIN entry issueAuthorizationCode writes cannot name the provider:
  // the consent, org-select and TOTP steps between here and there keep no
  // place for it.
  await db.$transaction((tx) =>
    logAuditTx(tx, {
      auth: { userId: user.id, email: user.email },
      action: "LOGIN",
      entityType: "UserIdentity",
      entityId: identityId,
      entityName: user.email,
      metadata: {
        provider: provider.slug,
        auth_methods: authMethods,
        client_id: client.clientId,
      },
    })
  );

  const { redirect_url } = await continueAfterFirstFactor(req, res, {
    user,
    client,
    request,
    authMethods,
    mfaSatisfied: provider.countsAsMfa,
    authTime,
  });
  return redirect_url;
};

/** Links the provider's account to the signed-in user who began the link. */
const completeLink = async (
  req: Request,
  provider: IdentityProvider,
  session: UpstreamAuthSession,
  state: string,
  limited: boolean
): Promise<string> => {
  if (!session.userId) throw new LinkFailure("session_expired");
  if (limited) throw new LinkFailure("too_many_attempts");
  if (!provider.isActive) throw new LinkFailure("provider_inactive");

  const identity = await completeAtProvider(
    req,
    provider,
    session,
    state,
    (code) => new LinkFailure(code)
  );

  const user = await db.users.get(session.userId);
  if (!user.isActive || user.userType !== "human") {
    throw new LinkFailure("account_inactive");
  }
  if (await ssoProviderElsewhere(user.email, provider.id)) {
    throw new LinkFailure("sso_required");
  }
  const holder = await db.userIdentities.getByProviderSubject(
    provider.id,
    identity.subject
  );
  if (holder) {
    throw new LinkFailure(
      holder.userId === user.id ? "already_linked" : "identity_in_use"
    );
  }
  if (await db.userIdentities.getForUserAtProvider(user.id, provider.id)) {
    throw new LinkFailure("already_linked");
  }

  try {
    await db.$transaction((tx) =>
      linkIdentity(
        tx,
        { userId: user.id, email: user.email },
        user.id,
        provider,
        identity
      )
    );
  } catch (err) {
    // A concurrent link took the subject, or gave this user the provider.
    const fields = uniqueViolationFields(err);
    if (!fields) throw err;
    throw new LinkFailure(
      fields.some((f) => /subject/i.test(f))
        ? "identity_in_use"
        : "already_linked"
    );
  }
  return uiUrl("/account", { linked: provider.slug });
};

/**
 * An SSO-only user's correct password, then the domain's provider: links the
 * identity only when the provider vouches for the user's own email (verified,
 * equal to the account's, and trusted for the domain), so a stolen password
 * cannot bind someone else's account at the provider. Then clears the
 * password, consumes the grant and signs in as a provider login. A failure
 * leaves the grant for another try until it expires.
 */
const completeForcedLink = async (
  req: Request,
  res: Response,
  provider: IdentityProvider,
  session: UpstreamAuthSession,
  state: string,
  limited: boolean
): Promise<string> => {
  const { userId, linkGrantId } = session;
  if (!userId || !linkGrantId || !session.clientId) {
    throw new LoginFailure("session_expired");
  }
  const client = await db.clients.get(session.clientId).catch((err) => {
    if (err instanceof NotFoundError) throw new LoginFailure("session_expired");
    throw err;
  });
  const request = storedRequest(session, client.clientId);
  if (!request) throw new LoginFailure("session_expired");
  const restart = authorizeRestartParams(request);
  const fail = (code: UpstreamLoginError) => new LoginFailure(code, restart);

  if (limited) throw fail("too_many_attempts");
  if (!provider.isActive) throw fail("provider_inactive");

  const identity = await completeAtProvider(
    req,
    provider,
    session,
    state,
    fail
  );

  const user = await db.users.get(userId);
  if (!user.isActive || user.userType !== "human") {
    throw fail("account_inactive");
  }
  const holder = await db.userIdentities.getByProviderSubject(
    provider.id,
    identity.subject
  );
  if (holder) {
    throw fail(
      holder.userId === user.id ? "already_linked" : "identity_in_use"
    );
  }
  if (await db.userIdentities.getForUserAtProvider(user.id, provider.id)) {
    throw fail("already_linked");
  }
  // A stolen password must not bind just any account at the provider: only
  // the one it vouches for as this user's own email.
  if (identity.email === null || !identity.emailVerified) {
    throw fail("email_unverified");
  }
  if (normalizeEmail(identity.email) !== normalizeEmail(user.email)) {
    throw fail("account_mismatch");
  }
  if (!emailTrusted(provider, identity, user.email, "domain")) {
    throw fail("email_unverified");
  }
  const authTime = authTimeOrFail(provider, identity, request, session, fail);

  const auth = { userId: user.id, email: user.email };
  let linked: { id: string } | undefined;
  try {
    // Clearing the password signs the user out everywhere, as a password
    // reset does, in the same transaction; the login below starts afresh.
    await endUserSessions(
      user.id,
      null,
      async (tx, sessionIds, ssoSessionIds) => {
        await db.users.lockForSignInChange(user.id, tx);
        const domain = await db.identityProviders.findDomain(
          emailDomain(user.email),
          tx
        );
        if (!domain?.ssoOnly || domain.providerId !== provider.id) {
          throw fail("session_expired");
        }
        if (!(await db.upstreamAuth.consumeLinkGrant(linkGrantId, tx))) {
          throw fail("session_expired");
        }
        linked = await linkIdentity(tx, auth, user.id, provider, identity);
        await db.users.clearPassword(user.id, tx);
        await logAuditTx(tx, {
          auth,
          action: "UPDATE",
          entityType: "User",
          entityId: user.id,
          entityName: user.email,
          metadata: {
            passwordRemoved: true,
            reason: "sso_only",
            provider: provider.slug,
          },
        });
        await emitTx(tx, {
          organizationId: getDefaultOrganizationId(),
          eventType: "auth.user.password-changed",
          entityType: "User",
          entityId: user.id,
          data: { userId: user.id, email: user.email, reason: "sso_only" },
        });
        await recordSessionsRevoked(auth, user)(tx, sessionIds, ssoSessionIds);
      }
    );
  } catch (err) {
    const fields = uniqueViolationFields(err);
    if (!fields) throw err;
    throw fail(
      fields.some((f) => /subject/i.test(f))
        ? "identity_in_use"
        : "already_linked"
    );
  }
  clearIdentityLinkGrantCookie(res, client.clientId);

  return await continueProviderLogin(
    req,
    res,
    provider,
    { ...user, passwordHash: null },
    linked!.id,
    { client, request, authTime }
  );
};

/** The provider's answer on the callback URL, as the user it signed in. */
const completeAtProvider = async (
  req: Request,
  provider: IdentityProvider,
  session: UpstreamAuthSession,
  state: string,
  fail: (code: UpstreamAuthErrorCode) => Error
): Promise<NormalizedIdentity> =>
  await adapterFor(provider.kind)
    .complete(provider, new URL(req.originalUrl, env.PUBLIC_URL), {
      nonce: session.nonce,
      codeVerifier: session.codeVerifier,
      state,
      redirectUri: upstreamCallbackUrl(provider.slug),
    })
    .catch((err: unknown) => {
      if (!(err instanceof UpstreamAuthError)) throw err;
      if (err.code === "upstream_failed") {
        logger.warn(
          { err, provider: provider.slug },
          "Upstream sign-in failed"
        );
      }
      throw fail(err.code);
    });

const grantRequest = (
  grant: IdentityLinkGrant,
  clientId: string
): AuthorizeRequestParams => ({
  clientId,
  redirectUri: grant.redirectUri,
  scopes: grant.scopes,
  state: grant.state,
  codeChallenge: grant.codeChallenge,
  codeChallengeMethod: grant.codeChallengeMethod,
  nonce: grant.nonce,
  maxAge: grant.maxAge,
  acrValues: grant.acrValues,
  prompt: grant.prompt,
});

const storedRequest = (
  session: UpstreamAuthSession,
  clientId: string
): AuthorizeRequestParams | null => {
  if (
    !session.redirectUri ||
    !session.codeChallenge ||
    !session.codeChallengeMethod
  ) {
    return null;
  }
  return {
    clientId,
    redirectUri: session.redirectUri,
    scopes: session.scopes,
    state: session.state,
    codeChallenge: session.codeChallenge,
    codeChallengeMethod: session.codeChallengeMethod,
    nonce: session.clientNonce,
    maxAge: session.maxAge,
    acrValues: session.acrValues,
    prompt: session.prompt,
  };
};

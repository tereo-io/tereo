import { AppError, NotFoundError, OAuth2Error } from "../../../utils/errors.js";
import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { beginPasswordAttempt } from "../../../utils/passwordAttempts.js";
import { maySelectOrganization } from "../../../utils/supportAccess.js";
import { UserType } from "../../../../prisma/generated/client/index.js";
import type { AuthorizeRequest, AuthorizeSubmit } from "./schemas.js";
import type { StepWriter } from "../../../utils/db/loginFlows.js";
import { knownDeviceFor } from "../../../utils/knownDevice.js";
import { skipsConsent } from "../../../definitions/index.js";
import { emailDomain } from "../../../utils/email.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import env from "../../../env.js";
import {
  authFailure,
  knownDeviceFailure,
  loginAccountBackoff,
} from "../../../middleware/rateLimit.js";
import {
  authorizationResponseUrl,
  authorizeRestartParams,
  issueAuthorizationCode,
  requiresMfa,
  stepUpRequired,
  uiUrl,
  usedMfa,
} from "../../../utils/authorization.js";
import {
  buildRedirectUrl,
  continueAfterFirstFactor,
  writeStepWhilePasswordIs,
} from "../../../utils/firstFactor.js";
import {
  setConsentSessionCookie,
  setAuthSessionCookie,
  clearAuthSessionCookie,
  clearUserSessionCookie,
  setIdentityLinkGrantCookie,
  getUserSessionFromCookie,
  getAuthSessionFromCookie,
} from "../../../utils/cookies.js";
import {
  generateRandomString,
  hashPassword,
  verifyPassword,
} from "../../../utils/crypto.js";
import {
  generateTotpSetupGrant,
  hashTotpSetupGrant,
} from "../../../utils/totp.js";
import {
  AuthorizeRequestSchema,
  AuthorizeSubmitSchema,
  AuthorizeTargetSchema,
  hasPrompt,
} from "./schemas.js";
import {
  authorizeRequestParams,
  getClientForAuthorize,
  invalidAuthorizeRequestUrl,
} from "./utils.js";

// Checked against when the email matches no one who may log in, so an
// unknown email costs the same scrypt as a wrong password.
const UNKNOWN_USER_HASH = hashPassword(generateRandomString(32));

export const authorizeGetHandler = async (req: Request, res: Response) => {
  // RFC 6749 section 4.1.2.1: errors go back to the caller until the client
  // and redirect URI check out, and to the redirect URI after.
  const target = validateQuery(AuthorizeTargetSchema, req);
  const client = await getClientForAuthorize(target.client_id);
  if (!client.redirectUris.includes(target.redirect_uri)) {
    throw new OAuth2Error("invalid_request", "Invalid redirect URI");
  }

  const parsed = AuthorizeRequestSchema.safeParse(req.query);
  if (!parsed.success) {
    res.redirect(
      invalidAuthorizeRequestUrl(target.redirect_uri, req.query, parsed.error)
    );
    return;
  }
  const query = parsed.data;

  if (!client.grantTypes.includes("authorization_code")) {
    res.redirect(
      authorizationResponseUrl(query.redirect_uri, {
        error: "unauthorized_client",
        error_description: "Client not authorized for authorization code grant",
        state: query.state,
      })
    );
    return;
  }

  // Handle prompt=none - check for existing session
  if (hasPrompt(query.prompt, "none")) {
    const userSessionToken = getUserSessionFromCookie(req, client.clientId);
    if (!userSessionToken) {
      const redirectUrl = authorizationResponseUrl(query.redirect_uri, {
        error: "login_required",
        error_description: "User is not authenticated",
        state: query.state,
      });
      res.redirect(redirectUrl);
      return;
    }

    const userSession =
      await db.userSessions.getUserSessionByToken(userSessionToken);
    if (!userSession || userSession.expiresAt < new Date()) {
      clearUserSessionCookie(res, client.clientId);
      const redirectUrl = authorizationResponseUrl(query.redirect_uri, {
        error: "login_required",
        error_description: "User session expired",
        state: query.state,
      });
      res.redirect(redirectUrl);
      return;
    }

    // OIDC Core 3.1.2.6: a user who could not log in interactively gets
    // login_required, the same answer as having no session.
    if (!(await isUserActive(userSession.userId))) {
      clearUserSessionCookie(res, client.clientId);
      const redirectUrl = authorizationResponseUrl(query.redirect_uri, {
        error: "login_required",
        error_description: "User is not authenticated",
        state: query.state,
      });
      res.redirect(redirectUrl);
      return;
    }

    if (isAuthTooOld(userSession.authTime, query.max_age)) {
      const redirectUrl = authorizationResponseUrl(query.redirect_uri, {
        error: "login_required",
        error_description: "Authentication too old",
        state: query.state,
      });
      res.redirect(redirectUrl);
      return;
    }

    // The session's login had no second factor, which the request or 2FA
    // since required of the user demands; only the user can add one.
    if (
      (requiresMfa(query.acr_values) && !usedMfa(userSession.authMethods)) ||
      (await stepUpRequired(userSession.userId, userSession.authMethods))
    ) {
      const redirectUrl = authorizationResponseUrl(query.redirect_uri, {
        error: "interaction_required",
        error_description: "Two-factor authentication is required",
        state: query.state,
      });
      res.redirect(redirectUrl);
      return;
    }

    // User has valid session - skip to consent
    const requestedScopes = query.scope ? query.scope.split(" ") : [];
    const invalidScopes = requestedScopes.filter(
      (s) => !client.scopes.includes(s)
    );
    if (invalidScopes.length > 0) {
      const redirectUrl = authorizationResponseUrl(query.redirect_uri, {
        error: "invalid_scope",
        error_description: `Invalid scope(s): ${invalidScopes.join(", ")}`,
        state: query.state,
      });
      res.redirect(redirectUrl);
      return;
    }

    // An org_id the user may select (a membership, or support access) is
    // taken, as the org switch below would; another needs a login.
    if (
      query.org_id &&
      query.org_id !== userSession.organizationId &&
      !(await maySelectOrganization(userSession.userId, query.org_id)).allowed
    ) {
      res.redirect(
        authorizationResponseUrl(query.redirect_uri, {
          error: "login_required",
          error_description: "The user may not select this organization",
          state: query.state,
        })
      );
      return;
    }

    const authorization = {
      userId: userSession.userId,
      organizationId: query.org_id ?? userSession.organizationId,
      redirectUri: query.redirect_uri,
      scopes: requestedScopes,
      state: query.state || null,
      codeChallenge: query.code_challenge,
      codeChallengeMethod: query.code_challenge_method,
      nonce: query.nonce || null,
      authTime: userSession.authTime,
      maxAge: query.max_age ?? null,
      acrValues: query.acr_values || null,
      authMethods: userSession.authMethods,
      userSessionId: userSession.id,
    };

    // A client that needs approval needs the consent screen, which a silent
    // request cannot show (OIDC Core 3.1.2.6).
    if (!skipsConsent(client, authorization.scopes, query.prompt)) {
      res.redirect(
        authorizationResponseUrl(query.redirect_uri, {
          error: "consent_required",
          error_description: "The user must approve this client",
          state: query.state,
        })
      );
      return;
    }
    res.redirect(await issueAuthorizationCode(req, res, client, authorization));
    return;
  }

  // prompt=login goes to the password login below and leaves this browser's
  // SSO session alone: any site can send the browser here, and an abandoned
  // login must not sign it out. A successful login replaces the session
  // (issueAuthorizationCode).

  // Handle org_id hint with existing session — skip login for org switching
  if (query.org_id && !hasPrompt(query.prompt, "login")) {
    const userSessionToken = getUserSessionFromCookie(req, client.clientId);
    if (userSessionToken) {
      const userSession =
        await db.userSessions.getUserSessionByToken(userSessionToken);
      const userActive =
        !!userSession && (await isUserActive(userSession.userId));
      if (userSession && !userActive) {
        clearUserSessionCookie(res, client.clientId);
      }
      // A stale login, an inactive user or a login without the second
      // factor now required falls through to the password login, as without
      // a session.
      if (
        userSession &&
        userActive &&
        userSession.expiresAt >= new Date() &&
        !isAuthTooOld(userSession.authTime, query.max_age) &&
        (!requiresMfa(query.acr_values) || usedMfa(userSession.authMethods)) &&
        !(await stepUpRequired(userSession.userId, userSession.authMethods))
      ) {
        const requestedScopes = query.scope ? query.scope.split(" ") : [];
        const scopesValid = requestedScopes.every((s) =>
          client.scopes.includes(s)
        );
        // A member of an active organization, or a support-access holder,
        // switches without a password; anything else falls through to the
        // password login.
        if (
          scopesValid &&
          (await maySelectOrganization(userSession.userId, query.org_id))
            .allowed
        ) {
          const authorization = {
            userId: userSession.userId,
            organizationId: query.org_id,
            redirectUri: query.redirect_uri,
            scopes: requestedScopes,
            state: query.state || null,
            codeChallenge: query.code_challenge,
            codeChallengeMethod: query.code_challenge_method,
            nonce: query.nonce || null,
            authTime: userSession.authTime,
            maxAge: query.max_age ?? null,
            acrValues: query.acr_values || null,
            authMethods: userSession.authMethods,
            userSessionId: userSession.id,
          };

          if (skipsConsent(client, authorization.scopes, query.prompt)) {
            res.redirect(
              await issueAuthorizationCode(req, res, client, authorization)
            );
            return;
          }

          const consentSessionToken = generateRandomString(32);
          await db.consent.createConsentSession({
            ...authorization,
            sessionToken: consentSessionToken,
            clientId: client.id,
            expiresAt: new Date(Date.now() + env.LOGIN_FLOW_TTL * 1000),
            prompt: query.prompt || null,
          });
          setConsentSessionCookie(res, consentSessionToken, client.clientId);

          res.redirect(
            uiUrl("/consent", {
              session: consentSessionToken,
              ...restartParams(query),
            })
          );
          return;
        }
      }
    }
  }

  const sessionId = generateRandomString(32);
  setAuthSessionCookie(res, sessionId, client.clientId);

  const loginUrl = buildRedirectUrl(`${env.UI_BASE_URL}/login`, {
    client_id: query.client_id,
    redirect_uri: query.redirect_uri,
    response_type: "code",
    state: query.state,
    scope: query.scope || "",
    code_challenge: query.code_challenge || "",
    code_challenge_method: query.code_challenge_method || "",
    nonce: query.nonce || "",
    max_age: query.max_age?.toString() || "",
    acr_values: query.acr_values || "",
    prompt: query.prompt || "",
  });

  res.redirect(loginUrl);
};

export const authorizePostHandler = async (req: Request, res: Response) => {
  const body = validateBody(AuthorizeSubmitSchema, req);

  const client = await getClientForAuthorize(body.client_id);
  await authFailure.check(req, client.clientId);
  if (!client.grantTypes.includes("authorization_code")) {
    throw new OAuth2Error(
      "unauthorized_client",
      "Client not authorized for authorization code grant"
    );
  }
  const sessionId = getAuthSessionFromCookie(req, client.clientId);
  if (!sessionId) {
    // The code the 2FA, org-select and consent steps give a missing cookie,
    // so the UI treats every step's lost session alike.
    throw new OAuth2Error(
      "invalid_session",
      "Session expired or invalid. Please start the authorization flow again."
    );
  }
  if (!client.redirectUris.includes(body.redirect_uri)) {
    throw new OAuth2Error("invalid_request", "Invalid redirect URI");
  }

  const user = await db.users.getByEmail(body.email);
  const canLogIn =
    !!user && user.isActive && user.userType !== UserType.service_account;

  // A browser that has logged in as this user before is let through the
  // account's backoff, which an attacker can otherwise hold the owner in; its
  // wrong passwords still lengthen the backoff, and are capped per cookie.
  const knownDevice = user && canLogIn ? knownDeviceFor(req, user) : null;
  if (knownDevice && (await loginAccountBackoff.isDelayed(req, body.email))) {
    await knownDeviceFailure.check(req, knownDevice);
    await loginAccountBackoff.spendUnblocked(req, body.email);
  } else {
    await loginAccountBackoff.check(req, body.email);
  }

  const attempt = beginPasswordAttempt(req, user, "login", client.clientId);
  if (!user || !canLogIn || !user.passwordHash) {
    await verifyPassword(await UNKNOWN_USER_HASH, body.password);
    await attempt.failed(
      !user ? "unknown_user" : !canLogIn ? "login_not_allowed" : "no_password"
    );
    throw new OAuth2Error("access_denied", "Invalid credentials", 401);
  }

  const validPassword = await verifyPassword(user.passwordHash, body.password);
  if (!validPassword) {
    await attempt.failed("invalid_password");
    throw new OAuth2Error("access_denied", "Invalid credentials", 401);
  }

  await attempt.succeeded();
  await authFailure.refund(req, client.clientId);
  await loginAccountBackoff.reset(req, body.email);
  if (knownDevice) await knownDeviceFailure.reset(req, knownDevice);

  const passwordHash = await db.users.upgradePasswordHash(
    user.id,
    user.passwordHash,
    body.password
  );
  // A password change may end the user's steps between this check and the
  // next step's row; the step is written only while the password holds.
  const writeStep = writeStepWhilePasswordIs(user.id, passwordHash);
  const linkRequired = await ssoOnlyLinkRequired(
    res,
    user,
    client,
    body,
    writeStep
  );
  if (linkRequired) {
    res.json(linkRequired);
    return;
  }

  res.json(
    await continueAfterFirstFactor(req, res, {
      user: { ...user, passwordHash },
      client,
      request: authorizeRequestParams(body),
      authMethods: ["pwd"],
      mfaSatisfied: false,
      writeStep,
    })
  );
};

/**
 * For a correct password on an SSO-only domain: refuses with `sso_required`
 * when the user already has that provider, otherwise issues the grant that
 * starts a forced link and answers the link-required page. Null elsewhere.
 * An inactive provider still answers `sso_required`: the domain stays closed
 * to passwords, and its start page reports the provider as off.
 */
const ssoOnlyLinkRequired = async (
  res: Response,
  user: { id: string; email: string },
  client: { id: string; clientId: string },
  body: AuthorizeSubmit,
  writeStep: StepWriter
): Promise<{ redirect_url: string } | null> => {
  const domain = await db.identityProviders.findDomain(emailDomain(user.email));
  if (!domain?.ssoOnly) return null;
  const { provider } = domain;
  const ssoRequired = new AppError(
    403,
    "sso_required",
    `Sign in with ${provider.displayName}`,
    { details: { provider: provider.slug } }
  );
  if (!provider.isActive) throw ssoRequired;
  if (await db.userIdentities.getForUserAtProvider(user.id, provider.id)) {
    throw ssoRequired;
  }

  const request = authorizeRequestParams(body);
  const grant = generateTotpSetupGrant();
  await writeStep((tx) =>
    db.upstreamAuth.createLinkGrant(
      {
        tokenHash: hashTotpSetupGrant(grant),
        userId: user.id,
        clientId: client.id,
        redirectUri: request.redirectUri,
        scopes: request.scopes,
        state: request.state,
        codeChallenge: request.codeChallenge,
        codeChallengeMethod: request.codeChallengeMethod,
        nonce: request.nonce,
        maxAge: request.maxAge,
        acrValues: request.acrValues,
        prompt: request.prompt,
        expiresAt: new Date(Date.now() + env.TOTP_VERIFICATION_TTL * 1000),
      },
      tx
    )
  );
  setIdentityLinkGrantCookie(res, grant, client.clientId);
  clearAuthSessionCookie(res, client.clientId);

  return {
    redirect_url: uiUrl("/login/link-required", {
      grant,
      provider: provider.slug,
      ...authorizeRestartParams(request),
    }),
  };
};

const restartParams = (request: AuthorizeRequest) =>
  authorizeRestartParams(authorizeRequestParams(request));

const isAuthTooOld = (authTime: Date, maxAge: number | undefined) =>
  maxAge !== undefined &&
  Math.floor((Date.now() - authTime.getTime()) / 1000) > maxAge;

const isUserActive = async (userId: string) => {
  const user = await db.users.get(userId).catch((err) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });
  return !!user?.isActive;
};

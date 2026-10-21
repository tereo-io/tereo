import type { AuthorizeRequestParams } from "./authorization.js";
import { handlePostAuthOrgSelection } from "./orgSelection.js";
import type { StepWriter } from "./db/loginFlows.js";
import { issueKnownDevice } from "./knownDevice.js";
import type { Request, Response } from "express";
import { OAuth2Error } from "./errors.js";
import db from "./db/index.js";
import env from "../env.js";
import {
  authorizationResponseUrl,
  authorizeRestartParams,
  requiresMfa,
  uiUrl,
} from "./authorization.js";
import {
  clearAuthSessionCookie,
  setTotpSessionCookie,
  setTotpSetupGrantCookie,
} from "./cookies.js";
import {
  generateTotpSessionToken,
  generateTotpSetupGrant,
  hashTotpSetupGrant,
} from "./totp.js";

/** A URL with the given query parameters, empty values included. */
export const buildRedirectUrl = (
  baseUrl: string,
  params: Record<string, string>
): string => {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

/** A user whose first factor (password or provider) has just been checked. */
export interface FirstFactorContinuation {
  user: { id: string; totpEnabled: boolean; passwordHash: string | null };
  client: {
    id: string;
    clientId: string;
    scopes: string[];
    consentRequired: boolean;
    trustedCoreScopes: string[];
  };
  request: AuthorizeRequestParams;
  /** The `amr` so far: `["pwd"]`, `["fed"]` or `["fed", "mfa"]`. */
  authMethods: string[];
  /** The provider already vouched for a second factor, so core asks for none. */
  mfaSatisfied: boolean;
  /** When the first factor was presented, if not now: a provider's `auth_time`. */
  authTime?: Date;
  /** Held by a TOTP step, which commits it (`utils/identityProviders/forcedLink.ts`). */
  pendingLinkId?: string;
  /** Writes the step the login goes on to; by default on its own. */
  writeStep?: StepWriter;
}

/**
 * Writes a step after a password check only while that password is still the
 * user's, holding their row as a token issue does: a password change, which
 * deletes the user's steps holding the row exclusively, either committed
 * first, and the login is refused as with a wrong password, or waits for the
 * step and deletes it.
 */
export const writeStepWhilePasswordIs =
  (userId: string, passwordHash: string): StepWriter =>
  (write) =>
    db.$transaction(async (tx) => {
      await db.users.lockForTokenIssue(userId, tx);
      const user = await db.users.get(userId, tx);
      if (user.passwordHash !== passwordHash) {
        throw new OAuth2Error("access_denied", "Invalid credentials", 401);
      }
      return write(tx);
    });

/**
 * Everything after a first factor: the scope check, then a TOTP step if one is
 * due, then the organization and consent steps. Returns where the browser goes
 * next. Whatever the TOTP step saves carries `authMethods`, so the login it
 * finishes records the first factor too.
 */
export const continueAfterFirstFactor = async (
  req: Request,
  res: Response,
  {
    user,
    client,
    request,
    authMethods,
    mfaSatisfied,
    authTime = new Date(),
    pendingLinkId,
    writeStep = db.loginFlows.writeStep,
  }: FirstFactorContinuation
): Promise<{ redirect_url: string }> => {
  const invalidScopes = request.scopes.filter(
    (s) => !client.scopes.includes(s)
  );
  if (invalidScopes.length > 0) {
    return {
      redirect_url: authorizationResponseUrl(request.redirectUri, {
        error: "invalid_scope",
        error_description: `Invalid scope(s): ${invalidScopes.join(", ")}`,
        state: request.state,
      }),
    };
  }

  if (!mfaSatisfied) {
    const needs2fa =
      requiresMfa(request.acrValues) || (await db.totp.userNeedsTotp(user.id));
    if (needs2fa) {
      // Asked for MFA by a user who has none and may not enrol: OIDC's error
      // for an authentication the server cannot perform.
      if (
        !user.totpEnabled &&
        (await db.settings.getTotpPolicy()) === "disabled"
      ) {
        return {
          redirect_url: authorizationResponseUrl(request.redirectUri, {
            error: "unmet_authentication_requirements",
            error_description:
              "Two-factor authentication is required, and enrolment is disabled",
            state: request.state,
          }),
        };
      }
      if (!user.totpEnabled) {
        const grant = generateTotpSetupGrant();
        await writeStep((tx) =>
          db.totp.createSetupGrant(
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
              firstFactor: authMethods,
              expiresAt: new Date(
                Date.now() + env.TOTP_VERIFICATION_TTL * 1000
              ),
            },
            tx
          )
        );

        setTotpSetupGrantCookie(res, grant, client.clientId);
        clearAuthSessionCookie(res, client.clientId);

        // The OAuth params let the UI restart /oauth/authorize once setup is
        // done; /oauth/totp/setup reads them from the grant, not from here.
        return {
          redirect_url: buildRedirectUrl(`${env.UI_BASE_URL}/login/2fa/setup`, {
            setup_grant: grant,
            client_id: request.clientId,
            redirect_uri: request.redirectUri,
            state: request.state || "",
            scope: request.scopes.join(" "),
            code_challenge: request.codeChallenge || "",
            code_challenge_method: request.codeChallengeMethod || "",
            nonce: request.nonce || "",
            setup_required: "true",
            max_age: request.maxAge?.toString() || "",
            acr_values: request.acrValues || "",
            prompt: request.prompt || "",
          }),
        };
      }

      const sessionToken = generateTotpSessionToken();
      await writeStep((tx) =>
        db.totp.createVerificationSession(
          {
            userId: user.id,
            sessionToken,
            clientId: client.id,
            redirectUri: request.redirectUri,
            scopes: request.scopes,
            state: request.state,
            codeChallenge: request.codeChallenge,
            codeChallengeMethod: request.codeChallengeMethod,
            nonce: request.nonce,
            expiresAt: new Date(Date.now() + env.TOTP_VERIFICATION_TTL * 1000),
            maxAge: request.maxAge,
            acrValues: request.acrValues,
            prompt: request.prompt,
            firstFactor: authMethods,
            pendingLinkId,
          },
          tx
        )
      );

      setTotpSessionCookie(res, sessionToken, client.clientId);
      clearAuthSessionCookie(res, client.clientId);

      return {
        redirect_url: uiUrl("/login/2fa", {
          session: sessionToken,
          ...authorizeRestartParams(request),
        }),
      };
    }
  }

  issueKnownDevice(res, user);

  return handlePostAuthOrgSelection(
    req,
    res,
    user.id,
    client,
    request.redirectUri,
    request.scopes,
    request.state,
    request.codeChallenge,
    request.codeChallengeMethod,
    request.nonce,
    authTime,
    request.maxAge,
    request.acrValues,
    request.prompt,
    authMethods,
    undefined,
    writeStep
  );
};

import { skipsConsent } from "../definitions/index.js";
import type { StepWriter } from "./db/loginFlows.js";
import { generateRandomString } from "./crypto.js";
import type { Request, Response } from "express";
import db from "./db/index.js";
import env from "../env.js";
import {
  authorizeRestartParams,
  issueAuthorizationCode,
  uiUrl,
} from "./authorization.js";
import {
  setConsentSessionCookie,
  setOrgSelectSessionCookie,
  clearAuthSessionCookie,
} from "./cookies.js";

export const handlePostAuthOrgSelection = async (
  req: Request,
  res: Response,
  userId: string,
  client: { id: string; clientId: string; consentRequired: boolean },
  redirectUri: string,
  scopes: string[],
  state: string | null,
  codeChallenge: string,
  codeChallengeMethod: string,
  nonce: string | null,
  authTime: Date,
  maxAge: number | null,
  acrValues: string | null,
  prompt: string | null,
  authMethods: string[],
  orgHint?: string,
  writeStep: StepWriter = db.loginFlows.writeStep
): Promise<{ redirect_url: string }> => {
  const restart = authorizeRestartParams({
    clientId: client.clientId,
    redirectUri,
    scopes,
    state,
    codeChallenge,
    codeChallengeMethod,
    nonce,
    maxAge,
    acrValues,
    prompt,
  });

  const userOrgs = await db.organizations.getUserOrganizations(userId);
  const activeOrgs = userOrgs.filter((o) => o.isActive);

  // If org hint provided and user is a member, auto-select that org
  let orgId: string | null = null;
  if (orgHint && activeOrgs.some((o) => o.id === orgHint)) orgId = orgHint;
  else if (activeOrgs.length === 1) orgId = activeOrgs[0].id;

  if (orgId !== null || activeOrgs.length === 0) {
    // 0 orgs (platform admin) or 1 org (auto-select)
    if (skipsConsent(client)) {
      // Nothing is written for the user to continue, but the step that led
      // here (a TOTP verification) is still spent: one code, one login.
      await writeStep(async () => undefined);
      clearAuthSessionCookie(res, client.clientId);
      const redirectUrl = await issueAuthorizationCode(req, res, client, {
        userId,
        organizationId: orgId,
        redirectUri,
        scopes,
        state,
        codeChallenge,
        codeChallengeMethod,
        nonce,
        authTime,
        maxAge,
        acrValues,
        authMethods,
        userSessionId: null,
      });
      return { redirect_url: redirectUrl };
    }

    const consentSessionToken = generateRandomString(32);
    await writeStep((tx) =>
      db.consent.createConsentSession(
        {
          sessionToken: consentSessionToken,
          userId,
          clientId: client.id,
          organizationId: orgId,
          redirectUri,
          scopes,
          state,
          codeChallenge,
          codeChallengeMethod,
          nonce,
          authTime,
          expiresAt: new Date(Date.now() + env.LOGIN_FLOW_TTL * 1000),
          maxAge,
          acrValues,
          prompt,
          authMethods,
        },
        tx
      )
    );

    setConsentSessionCookie(res, consentSessionToken, client.clientId);
    clearAuthSessionCookie(res, client.clientId);

    return {
      redirect_url: uiUrl("/consent", {
        session: consentSessionToken,
        ...restart,
      }),
    };
  }

  // Multiple orgs — redirect to org picker
  const sessionToken = generateRandomString(32);
  await writeStep((tx) =>
    db.orgSelectionSessions.create(
      {
        sessionToken,
        userId,
        clientId: client.id,
        redirectUri,
        scopes,
        state,
        codeChallenge,
        codeChallengeMethod,
        nonce,
        authTime,
        maxAge,
        acrValues,
        prompt,
        authMethods,
        expiresAt: new Date(Date.now() + env.LOGIN_FLOW_TTL * 1000),
      },
      tx
    )
  );

  setOrgSelectSessionCookie(res, sessionToken, client.clientId);
  clearAuthSessionCookie(res, client.clientId);

  return {
    redirect_url: uiUrl("/login/org-select", {
      session: sessionToken,
      ...restart,
    }),
  };
};

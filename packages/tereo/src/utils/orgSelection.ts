import { authorizeRestartParams, uiUrl } from "./authorization.js";
import type { StepWriter } from "./db/loginFlows.js";
import { generateRandomString } from "./crypto.js";
import type { Response } from "express";
import db from "./db/index.js";
import env from "../env.js";
import {
  setConsentSessionCookie,
  setOrgSelectSessionCookie,
  clearAuthSessionCookie,
} from "./cookies.js";

export const handlePostAuthOrgSelection = async (
  res: Response,
  userId: string,
  clientInternalId: string,
  clientId: string,
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
    clientId,
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
    const consentSessionToken = generateRandomString(32);
    await writeStep((tx) =>
      db.consent.createConsentSession(
        {
          sessionToken: consentSessionToken,
          userId,
          clientId: clientInternalId,
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

    setConsentSessionCookie(res, consentSessionToken, clientId);
    clearAuthSessionCookie(res, clientId);

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
        clientId: clientInternalId,
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

  setOrgSelectSessionCookie(res, sessionToken, clientId);
  clearAuthSessionCookie(res, clientId);

  return {
    redirect_url: uiUrl("/login/org-select", {
      session: sessionToken,
      ...restart,
    }),
  };
};

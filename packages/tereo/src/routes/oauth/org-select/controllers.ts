import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { OrgSelectGetSchema, OrgSelectSubmitSchema } from "./schemas.js";
import { OAuth2Error, BadRequestError } from "../../../utils/errors.js";
import { generateRandomString } from "../../../utils/crypto.js";
import { skipsConsent } from "../../../definitions/index.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import env from "../../../env.js";
import {
  authorizeRestartParams,
  issueAuthorizationCode,
  uiUrl,
} from "../../../utils/authorization.js";
import {
  setConsentSessionCookie,
  clearOrgSelectSessionCookie,
  getOrgSelectSessionFromCookie,
} from "../../../utils/cookies.js";

export const orgSelectGetHandler = async (req: Request, res: Response) => {
  const query = validateQuery(OrgSelectGetSchema, req);

  const session = await db.orgSelectionSessions.get(query.session);
  if (!session) {
    throw new OAuth2Error(
      "invalid_session",
      "Session not found. Please login again."
    );
  }

  // The token travels in the page URL; the user's email and organizations
  // go only to the browser that holds its cookie.
  const client = await db.clients.get(session.clientId);
  if (getOrgSelectSessionFromCookie(req, client.clientId) !== query.session) {
    throw new OAuth2Error(
      "invalid_session",
      "Session mismatch. Please login again."
    );
  }

  if (session.expiresAt < new Date()) {
    await db.orgSelectionSessions.remove(session.id);
    throw new OAuth2Error(
      "session_expired",
      "Session expired. Please login again."
    );
  }

  const user = await db.users.get(session.userId);
  const userOrgs = await db.organizations.getUserOrganizations(session.userId);
  const activeOrgs = userOrgs.filter((o) => o.isActive);

  res.json({
    organizations: activeOrgs.map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
    })),
    client: { name: client.name },
    user: { email: user.email, name: user.name },
  });
};

export const orgSelectSubmitHandler = async (req: Request, res: Response) => {
  const body = validateBody(OrgSelectSubmitSchema, req);

  const session = await db.orgSelectionSessions.get(body.session_token);
  if (!session) {
    throw new OAuth2Error(
      "invalid_session",
      "Session not found. Please login again."
    );
  }

  const client = await db.clients.get(session.clientId);
  const sessionCookie = getOrgSelectSessionFromCookie(req, client.clientId);

  if (!sessionCookie || sessionCookie !== body.session_token) {
    throw new OAuth2Error(
      "invalid_session",
      "Session mismatch. Please login again."
    );
  }

  if (session.expiresAt < new Date()) {
    await db.orgSelectionSessions.remove(session.id);
    clearOrgSelectSessionCookie(res, client.clientId);
    throw new OAuth2Error(
      "session_expired",
      "Session expired. Please login again."
    );
  }

  // Verify user is a member of the selected organization
  const membership = await db.organizations.getMembership(
    body.organization_id,
    session.userId
  );
  if (!membership) {
    throw new BadRequestError(
      "user_not_in_organization",
      "User is not a member of the selected organization"
    );
  }

  // An archived organization keeps its members but is never offered (the
  // GET leaves it out); picking it anyway is the inactive case, not a 404.
  const org = await db.organizations.getAny(body.organization_id);
  if (!org.isActive || org.archivedAt) {
    throw new BadRequestError(
      "organization_not_active",
      "Organization is not active"
    );
  }

  // One pick, one consent: a concurrent submit with the same session loses.
  if (!(await db.orgSelectionSessions.consume(session.id))) {
    throw new OAuth2Error(
      "invalid_session",
      "Session not found. Please login again."
    );
  }
  clearOrgSelectSessionCookie(res, client.clientId);

  if (skipsConsent(client)) {
    const redirectUrl = await issueAuthorizationCode(req, res, client, {
      userId: session.userId,
      organizationId: body.organization_id,
      redirectUri: session.redirectUri,
      scopes: session.scopes,
      state: session.state,
      codeChallenge: session.codeChallenge,
      codeChallengeMethod: session.codeChallengeMethod,
      nonce: session.nonce,
      authTime: session.authTime,
      maxAge: session.maxAge,
      acrValues: session.acrValues,
      authMethods: session.authMethods,
      userSessionId: null,
    });
    res.json({ redirect_url: redirectUrl });
    return;
  }

  const consentSessionToken = generateRandomString(32);
  await db.consent.createConsentSession({
    sessionToken: consentSessionToken,
    userId: session.userId,
    clientId: session.clientId,
    organizationId: body.organization_id,
    redirectUri: session.redirectUri,
    scopes: session.scopes,
    state: session.state,
    codeChallenge: session.codeChallenge,
    codeChallengeMethod: session.codeChallengeMethod,
    nonce: session.nonce,
    authTime: session.authTime,
    expiresAt: new Date(Date.now() + env.LOGIN_FLOW_TTL * 1000),
    maxAge: session.maxAge,
    acrValues: session.acrValues,
    prompt: session.prompt,
    authMethods: session.authMethods,
  });

  setConsentSessionCookie(res, consentSessionToken, client.clientId);

  const consentUrl = uiUrl("/consent", {
    session: consentSessionToken,
    ...authorizeRestartParams({ ...session, clientId: client.clientId }),
  });

  res.json({ redirect_url: consentUrl });
};

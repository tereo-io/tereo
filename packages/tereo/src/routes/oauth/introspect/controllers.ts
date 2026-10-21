import type { ClientRecord } from "../../../utils/db/clients.js";
import { logTokenIntrospected } from "../../../utils/audit.js";
import { checkAccessToken } from "../../../utils/sessions.js";
import { verifyAccessToken } from "../../../utils/tokens.js";
import { validateBody } from "../../../utils/validateReq.js";
import { buildUserClaims } from "../../../utils/claims.js";
import { NotFoundError } from "../../../utils/errors.js";
import { IntrospectRequestSchema } from "./schemas.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import {
  authenticateClient,
  clientAuthenticationFailed,
} from "../../../utils/auth.js";

export const introspectHandler = async (req: Request, res: Response) => {
  const body = validateBody(IntrospectRequestSchema, req);
  const client = await authenticateClient(req, res, body.client_id);
  // RFC 7662 section 2.1: a client_id alone proves nothing.
  if (client.clientType === "public") throw clientAuthenticationFailed(res);

  const ip = req.ip || req.socket.remoteAddress;

  const verified = verifyAccessToken(body.token);
  if (!verified) {
    logTokenIntrospected(client.clientId, false, ip);
    res.json({ active: false });
    return;
  }

  const callerService = await db.services.getByClientId(client.id);
  if (
    !isAuthorizedToIntrospect(
      client,
      callerService,
      verified.client_id,
      verified.aud
    )
  ) {
    logTokenIntrospected(client.clientId, false, ip);
    res.json({ active: false });
    return;
  }

  if (verified.exp < Math.floor(Date.now() / 1000)) {
    logTokenIntrospected(client.clientId, false, ip);
    res.json({ active: false });
    return;
  }

  // The same check requireAuth makes, so the two never disagree.
  const check = await checkAccessToken(verified.jti, verified.client_id);
  if (!check.active) {
    logTokenIntrospected(client.clientId, false, ip);
    res.json({ active: false });
    return;
  }

  const scopes = verified.scope ? verified.scope.split(" ") : [];
  // For a client_credentials token this is the client's service-account user.
  const { user } = check;
  const userClaims = buildUserClaims(user, scopes);
  // Live, as requireAuth reads them: a role revoked since the token was
  // issued no longer counts, though the token still carries it. A service
  // is told them for any token it may introspect; a third-party client
  // asking about its own token with no core access is not, as at userinfo.
  const showsPermissions =
    callerService?.kind === "service" || check.access.kind !== "none";
  const permissions = showsPermissions
    ? await db.roles.getUserPermissions(
        user.id,
        check.token.organizationId ?? undefined
      )
    : undefined;

  // Resolve org_name if org_id is present in token
  let orgClaims = {};
  if (verified.org_id) {
    try {
      const org = await db.organizations.get(verified.org_id);
      orgClaims = { org_name: org.name };
    } catch (err) {
      // Org deleted or archived since the token was issued — omit org_name.
      if (!(err instanceof NotFoundError)) throw err;
    }
  }

  logTokenIntrospected(client.clientId, true, ip);
  res.json({
    active: true,
    ...verified,
    ...(permissions && { permissions }),
    ...userClaims,
    // The token's own sub: a client_credentials token names its client, not
    // the service-account user buildUserClaims reads. user_id is that user.
    sub: verified.sub,
    user_id: user.id,
    ...orgClaims,
  });
};

/**
 * Determines if the requesting client is authorized to introspect the given token.
 *
 * Authorization rules (RFC 7662 Section 2.2), for a confidential client:
 * 1. Client can always introspect its own tokens (client_id match)
 * 2. Otherwise the requesting client must belong to a service (never an
 *    integration) whose slug is in the token's audience — an audience an admin approved for the
 *    token's service (/admin/services)
 *
 * This enables the resource server pattern: a reporting service validates tokens issued to
 * the billing service when "reporting-service" is in their audience.
 */
const isAuthorizedToIntrospect = (
  requestingClient: ClientRecord,
  service: { kind: string; slug: string } | null,
  tokenClientId: string,
  tokenAudience?: string | string[]
): boolean => {
  if (tokenClientId === requestingClient.clientId) return true;
  if (!tokenAudience) return false;
  if (service?.kind !== "service") return false;
  const audiences = Array.isArray(tokenAudience)
    ? tokenAudience
    : [tokenAudience];
  return audiences.includes(service.slug);
};

import { presignUserPhotoUrl } from "../../../utils/userPhotos.js";
import type { AccessTokenCheck } from "../../../utils/sessions.js";
import { checkAccessToken } from "../../../utils/sessions.js";
import { buildUserClaims } from "../../../utils/claims.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import {
  allowsArea,
  effectivePermissions,
  type CoreAccess,
} from "../../../utils/coreAccess.js";
import {
  InvalidTokenError,
  NotFoundError,
  OAuth2Error,
} from "../../../utils/errors.js";
import {
  bearerToken,
  verifyAccessToken,
  type AccessTokenPayload,
} from "../../../utils/tokens.js";

interface TokenVerificationResult {
  user: Extract<AccessTokenCheck, { active: true }>["user"];
  scopes: string[];
  payload: AccessTokenPayload;
  /** What the token may do in core's API, which bounds what it is told. */
  access: CoreAccess;
}

export const getUserInfo = async (req: Request, res: Response) => {
  const { user, scopes, payload, access } = await verifyBearerTokenWithScopes(
    req,
    res
  );
  const userId = user.id;
  const photoUrl = user.photoObjectId
    ? await presignUserPhotoUrl(user.photoObjectId)
    : null;

  const claims = buildUserClaims(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      photoUrl,
      updatedAt: user.updatedAt,
    },
    scopes
  );

  // Resolve org from id in token
  let orgId: string | undefined;
  let orgName: string | undefined;
  if (payload.org_id) {
    try {
      const org = await db.organizations.get(payload.org_id);
      orgId = org.id;
      orgName = org.name;
    } catch (err) {
      // Org deleted or archived since the token was issued — omit its claims.
      if (!(err instanceof NotFoundError)) throw err;
    }
  }

  // Roles, permissions and organization memberships are core's
  // authorization, for the UI, a service or a client granted a core scope;
  // any other relying party gets the OIDC claims only. Roles are the global
  // ones and the token's organization's, the same scope as the permissions.
  // A delegated token is told what requireAuth would let it use: its
  // permissions cut down to its scopes' ceilings, no roles (a role is not
  // capped, its permissions are), and the memberships only with the scope
  // that lists them.
  const delegated = access.kind === "delegated";
  const authorization =
    access.kind !== "none"
      ? {
          roles: delegated
            ? []
            : (await db.roles.getLiveUserRoles(userId, orgId)).map(
                (ur) => ur.role.name
              ),
          permissions: effectivePermissions(
            await db.roles.getUserPermissions(userId, orgId),
            access
          ),
          organizations:
            delegated && !allowsArea(access, ["account", "organizations"])
              ? []
              : (await db.organizations.getUserOrganizations(userId))
                  .filter((org) => org.isActive)
                  .map((org) => ({
                    id: org.id,
                    name: org.name,
                    slug: org.slug,
                    memberRole: org.memberRole,
                  })),
        }
      : {};

  res.json({
    ...claims,
    ...authorization,
    ...(orgId && { org_id: orgId }),
    ...(orgName && { org_name: orgName }),
  });
};

/** RFC 6750 section 3: a 401 carries a Bearer challenge. */
const invalidToken = (res: Response, message: string) => {
  res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
  return new InvalidTokenError(message);
};

const verifyBearerTokenWithScopes = async (
  req: Request,
  res: Response
): Promise<TokenVerificationResult> => {
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    throw invalidToken(res, "Missing or invalid Authorization header");
  }
  const payload = verifyAccessToken(token);
  if (!payload) {
    throw invalidToken(res, "Invalid or expired access token");
  }

  // The same check requireAuth and introspection make: a revoked session,
  // a deleted client or an inactive user ends the token here too.
  const check = await checkAccessToken(payload.jti, payload.client_id);
  if (!check.active) throw invalidToken(res, check.reason);
  if (check.isClientToken) {
    throw invalidToken(res, "A client credentials token has no end user");
  }

  const scopes = payload.scope ? payload.scope.split(" ") : [];
  // OIDC Core 5.3: the UserInfo endpoint answers an OpenID Connect request,
  // which a token without `openid` is not.
  if (!scopes.includes("openid")) {
    res.set(
      "WWW-Authenticate",
      'Bearer error="insufficient_scope", scope="openid"'
    );
    throw new OAuth2Error(
      "insufficient_scope",
      "The UserInfo endpoint requires a token with the openid scope",
      403
    );
  }
  return {
    user: check.user,
    scopes,
    payload,
    access: check.access,
  };
};

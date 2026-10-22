// @module-tag int
// @module-tag auth
// @module-tag security
import { getTestPrincipalToken } from "../support/principals.js";
import { CORE_URL } from "../support/coreUrl.js";
import { describe, expect, it } from "vitest";
import {
  collectRoutes,
  type RouteEntry,
  type RouteMethod,
} from "../support/routeTable.js";

const PARAM = "00000000-0000-7000-8000-000000000000";

type Allowlist = ReadonlyArray<readonly [RouteMethod, string, string]>;

/**
 * Routes that take no bearer token: open by design, or authenticated by
 * another credential (client credentials, a login session, a signature, a
 * share token). Neither the 401 nor the 403 case runs for them.
 */
const PUBLIC: Allowlist = [
  [
    "get",
    "/health",
    "Liveness probe; load balancers and orchestrators send no token",
  ],
  [
    "get",
    "/.well-known/oauth-authorization-server",
    "OAuth server metadata (RFC 8414), read before a client holds a token",
  ],
  [
    "get",
    "/.well-known/openid-configuration",
    "OIDC discovery document, read before a client holds a token",
  ],
  [
    "get",
    "/.well-known/jwks.json",
    "Public signing keys that relying parties verify tokens with",
  ],
  [
    "get",
    "/oauth/authorize",
    "Starts the browser login; the user has no token yet",
  ],
  [
    "post",
    "/oauth/authorize",
    "Takes the login form's email and password; the user has no token yet",
  ],
  [
    "post",
    "/oauth/token",
    "OAuth token endpoint authenticates the client and the grant, not a bearer token",
  ],
  [
    "post",
    "/oauth/introspect",
    "Token introspection (RFC 7662) authenticates the calling client, not a bearer token",
  ],
  [
    "post",
    "/oauth/revoke",
    "Token revocation (RFC 7009) authenticates the calling client, not a bearer token",
  ],
  [
    "post",
    "/oauth/check-permission",
    "Authenticates the calling app service by its client credentials, not a bearer token",
  ],
  [
    "post",
    "/oauth/check-permission/batch",
    "Authenticates the calling app service by its client credentials, not a bearer token",
  ],
  [
    "get",
    "/oauth/consent",
    "Consent screen during login, keyed by the login session in the query",
  ],
  [
    "post",
    "/oauth/consent",
    "Consent decision during login, keyed by the login session token in the body",
  ],
  [
    "get",
    "/oauth/org-select",
    "Organization choice during login, keyed by the login session in the query",
  ],
  [
    "post",
    "/oauth/org-select/submit",
    "Organization choice during login, keyed by the login session token in the body",
  ],
  [
    "post",
    "/oauth/totp/verify",
    "Second login factor, keyed by the login session token",
  ],
  [
    "post",
    "/oauth/totp/recovery",
    "Recovery-code login factor, keyed by the login session token",
  ],
  [
    "post",
    "/oauth/totp/setup",
    "TOTP enrolment forced during login, keyed by the setup grant the login issued",
  ],
  [
    "post",
    "/oauth/totp/setup/verify",
    "Confirms TOTP enrolment during login with its setup token",
  ],
  [
    "get",
    "/oauth/end-session",
    "OIDC RP-initiated logout, identified by id_token_hint or client_id and the session cookie",
  ],
  [
    "post",
    "/oauth/end-session",
    "OIDC RP-initiated logout, identified by id_token_hint or client_id and the session cookie",
  ],
  [
    "get",
    "/oauth/end-session/confirm",
    "Confirms a logout with the confirm_token /oauth/end-session issued",
  ],
  [
    "post",
    "/oauth/end-session/confirm",
    "Confirms a logout with the confirm_token /oauth/end-session issued",
  ],
  [
    "get",
    "/oauth/upstream/providers",
    "Lists upstream identity providers for the login page, before sign-in",
  ],
  [
    "get",
    "/oauth/upstream/:slug/start",
    "Starts sign-in through an upstream identity provider; the user has no token yet",
  ],
  [
    "get",
    "/oauth/upstream/:slug/callback",
    "Upstream provider's redirect back, authenticated by its state and code",
  ],
  [
    "get",
    "/v1/setup/status",
    "Tells the admin UI whether to show first-run setup, before any user exists",
  ],
  [
    "post",
    "/v1/setup",
    "Creates the first admin; the setup token is the credential (404 once setup is done)",
  ],
  [
    "get",
    "/v1/files/signed/objects/:bucket/by-id/:id",
    "Presigned download, authenticated by the HMAC signature in its query",
  ],
  [
    "head",
    "/v1/files/signed/objects/:bucket/by-id/:id",
    "Presigned metadata probe, authenticated by the HMAC signature in its query",
  ],
  [
    "put",
    "/v1/files/signed/objects/:bucket/by-id/:id",
    "Presigned upload, authenticated by the HMAC signature in its query",
  ],
  [
    "get",
    "/v1/files/signed/archives/:id",
    "Presigned archive download, authenticated by the HMAC signature in its query",
  ],
  [
    "head",
    "/v1/files/signed/archives/:id",
    "Presigned archive probe, authenticated by the HMAC signature in its query",
  ],
  [
    "get",
    "/v1/files/shared/:token",
    "Share link, authenticated by its token in the path and its password if set",
  ],
  [
    "head",
    "/v1/files/shared/:token",
    "Share link probe, authenticated by its token in the path and its password if set",
  ],
  [
    "get",
    "/v1/files/shared/:token/:filename",
    "Share link with a filename, authenticated by its token in the path",
  ],
  [
    "head",
    "/v1/files/shared/:token/:filename",
    "Share link probe with a filename, authenticated by its token in the path",
  ],
  [
    "post",
    "/v1/files/shared/:token/unlock",
    "Exchanges a share's password for access, keyed by the share token in the path",
  ],
];

/**
 * Routes any signed-in user may call about themselves: a token with no
 * permissions passes, so only the 401 case runs. Some still answer 403 (a
 * recent login or the core UI client is required), which says nothing about
 * permissions.
 */
const SIGNED_IN_ONLY: Allowlist = [
  [
    "get",
    "/oauth/userinfo",
    "OIDC userinfo returns the caller's own claims to any valid access token",
  ],
  [
    "post",
    "/oauth/userinfo",
    "OIDC userinfo returns the caller's own claims to any valid access token",
  ],
  ["get", "/v1/account/me", "The caller's own profile"],
  ["post", "/v1/account/password", "Changes the caller's own password"],
  ["get", "/v1/account/organizations", "Organizations the caller belongs to"],
  ["get", "/v1/account/totp", "The caller's own TOTP status"],
  [
    "delete",
    "/v1/account/totp",
    "Disables the caller's own TOTP; needs a recent login, not a permission",
  ],
  [
    "post",
    "/v1/account/totp/setup",
    "Starts the caller's own TOTP enrolment; needs a recent login, not a permission",
  ],
  [
    "post",
    "/v1/account/totp/setup/verify",
    "Confirms the caller's own TOTP enrolment",
  ],
  [
    "post",
    "/v1/account/totp/recovery-codes",
    "Regenerates the caller's own recovery codes; needs a recent login, not a permission",
  ],
  ["post", "/v1/account/photo", "Uploads the caller's own profile photo"],
  ["delete", "/v1/account/photo", "Removes the caller's own profile photo"],
  ["get", "/v1/account/sessions", "The caller's own sessions"],
  ["delete", "/v1/account/sessions", "Revokes the caller's own sessions"],
  [
    "delete",
    "/v1/account/sessions/:sessionId",
    "Revokes one of the caller's own sessions",
  ],
  [
    "get",
    "/v1/account/identities",
    "The caller's own linked upstream identities",
  ],
  [
    "post",
    "/v1/account/identities",
    "Links an upstream identity to the caller; needs a recent login, not a permission",
  ],
  [
    "delete",
    "/v1/account/identities/:id",
    "Unlinks one of the caller's own upstream identities; needs a recent login",
  ],
  [
    "get",
    "/v1/account/service",
    "The service the caller's service-account user belongs to",
  ],
];

const routes = await collectRoutes();

const key = (method: string, path: string) => `${method} ${path}`;
const listed = (list: Allowlist) =>
  new Set(list.map(([method, path]) => key(method, path)));
const publicRoutes = listed(PUBLIC);
const signedInOnly = listed(SIGNED_IN_ONLY);

const protectedRoutes = routes
  .filter(({ method, path }) => !publicRoutes.has(key(method, path)))
  .map((route) => [route.method.toUpperCase(), route.path, route] as const);

const request = async (route: RouteEntry, token: string | null) => {
  const url = CORE_URL + route.path.replace(/[:*]\w+/g, PARAM);
  const hasBody = route.method !== "get" && route.method !== "head";
  const response = await fetch(url, {
    method: route.method.toUpperCase(),
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(hasBody && { "Content-Type": "application/json" }),
    },
    body: hasBody ? "{}" : undefined,
    redirect: "manual",
  });
  return { status: response.status, body: await response.text() };
};

describe("route table", () => {
  it("finds every route", () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes).toEqual(
      expect.arrayContaining([
        // Router mounted at a literal path, then a :param folder.
        { method: "patch", path: "/v1/admin/users/:id" },
        // Router mounted after body-parser middleware.
        { method: "post", path: "/oauth/token" },
        // Wildcard mount under nested :param mounts.
        {
          method: "get",
          path: "/v1/files/buckets/:name/objects/by-key/*objectKey",
        },
        // Router mounted after path-less auth middleware.
        { method: "get", path: "/v1/files/buckets" },
      ])
    );
  });

  it("lists only routes that exist", () => {
    const table = new Set(routes.map(({ method, path }) => key(method, path)));
    const missing = [...PUBLIC, ...SIGNED_IN_ONLY]
      .map(([method, path]) => key(method, path))
      .filter((entry) => !table.has(entry));
    expect(missing).toEqual([]);
  });
});

describe.each(protectedRoutes)("%s %s", (_method, path, route) => {
  it("returns 401 without a token", async () => {
    const { status, body } = await request(route, null);
    expect(status, body).toBe(401);
  });

  if (signedInOnly.has(key(route.method, path))) return;

  it("returns 403 for a token without permissions", async () => {
    const token = await getTestPrincipalToken({ permissions: [] });
    const { status, body } = await request(route, token);
    expect(status, body).toBe(403);
  });
});

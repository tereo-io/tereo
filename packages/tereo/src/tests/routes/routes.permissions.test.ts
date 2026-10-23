// @module-tag int
// @module-tag auth
// @module-tag security
/**
 * Generated auth enforcement over every route core mounts (`collectRoutes`).
 *
 * What it proves:
 * - every route not in PUBLIC answers 401 to a request without a token;
 * - every route not in PUBLIC, SIGNED_IN_ONLY or RESOURCE_SCOPED answers 403
 *   to a token with no permissions (a fresh user with no roles, in an
 *   organization), and that refusal comes from a permission gate
 *   (`requirePermission`, or a controller's own "one of the following
 *   permissions" check), not from validation, a missing organization or a
 *   missing resource;
 * - RESOURCE_SCOPED routes answer that token with 403.
 *
 * What it does not prove:
 * - which permission, or which level of it, a route requires: a route gated
 *   on `x.read` where it should need `x.write` still passes;
 * - resource-scoped access (organization membership, bucket grants,
 *   ownership): those belong in the routes' own `.permissions` files.
 *
 * CORS preflights (`app.options` in `app.ts`) are mounted on the app, not
 * under `routes/`, so they are outside the table by design.
 */
import { collectRoutes, type RouteEntry } from "../support/routeTable.js";
import { getTestPrincipalToken } from "../support/principals.js";
import { beforeAll, describe, expect, it } from "vitest";
import { CORE_URL } from "../support/coreUrl.js";
import {
  PUBLIC,
  RESOURCE_SCOPED,
  SIGNED_IN_ONLY,
  type Allowlist,
} from "../support/routeAllowlists.js";

const PARAM = "00000000-0000-7000-8000-000000000000";

// The messages a permission gate refuses with: `requirePermission`
// (middleware/auth.ts) and the either-of check in
// routes/v1/notifications/notification/controllers.ts.
const PERMISSION_REFUSAL =
  /^(The following permission is required|One of the following permissions is required): /;

const routes = await collectRoutes();

const key = (method: string, path: string) => `${method} ${path}`;
const listed = (list: Allowlist) =>
  new Set(list.map(([method, path]) => key(method, path)));
const publicRoutes = listed(PUBLIC);
const signedInOnly = listed(SIGNED_IN_ONLY);
const resourceScoped = listed(RESOURCE_SCOPED);

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
    const missing = [...PUBLIC, ...SIGNED_IN_ONLY, ...RESOURCE_SCOPED]
      .map(([method, path]) => key(method, path))
      .filter((entry) => !table.has(entry));
    expect(missing).toEqual([]);
  });
});

// One user with no roles, in an organization so that routes needing
// organization context reach their permission check.
let permissionless: string;
beforeAll(async () => {
  permissionless = await getTestPrincipalToken({
    permissions: [],
    organizationId: "route-permissions",
  });
});

describe.each(protectedRoutes)("%s %s", (_method, path, route) => {
  it("returns 401 without a token", async () => {
    const { status, body } = await request(route, null);
    expect(status, body).toBe(401);
  });

  if (signedInOnly.has(key(route.method, path))) return;

  if (resourceScoped.has(key(route.method, path))) {
    it("returns 403 for a token without permissions", async () => {
      const { status, body } = await request(route, permissionless);
      expect(status, body).toBe(403);
    });
    return;
  }

  it("returns 403 from a permission gate for a token without permissions", async () => {
    const { status, body } = await request(route, permissionless);
    expect(status, body).toBe(403);
    expect(JSON.parse(body).error_description).toMatch(PERMISSION_REFUSAL);
  });
});

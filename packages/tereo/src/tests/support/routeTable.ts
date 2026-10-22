import { getRedisClient, initializeRedis } from "../../utils/redis.js";
import { Router } from "express";
import env from "../../env.js";

export type RouteMethod = "get" | "post" | "put" | "patch" | "delete" | "head";

/** A route core mounts, with Express-style params (`/v1/admin/users/:id`). */
export type RouteEntry = { method: RouteMethod; path: string };

const METHODS: readonly string[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
];

interface RouterLike {
  stack: Array<{ route?: { path: unknown; methods: Record<string, boolean> } }>;
  use: (...args: unknown[]) => unknown;
}

type Mount = { path: string; handlers: unknown[] };

const isRouter = (value: unknown): value is RouterLike =>
  typeof value === "function" &&
  Array.isArray((value as Partial<RouterLike>).stack);

const join = (prefix: string, path: string) =>
  path === "/" ? prefix || "/" : `${prefix}${path}`;

/**
 * Every route under `routes/index.ts`, with its full path. Router 2 layers
 * don't keep the path they were mounted at, so `Router.prototype.use` is
 * wrapped while the route modules load to record each mount, then the tree is
 * walked from the root. Throws on anything it can't place (a non-string path
 * or method it doesn't know) rather than leaving a route out of the table.
 */
export const collectRoutes = async (): Promise<RouteEntry[]> => {
  // `express.Router` is the `router` package; its routers inherit from this.
  // The route modules build their rate limiters on import, which needs Redis;
  // this runs at collection time, before setup's beforeAll connects it.
  try {
    getRedisClient();
  } catch {
    await initializeRedis(env);
  }

  const proto = (Router as unknown as { prototype: RouterLike }).prototype;
  const original = proto.use;
  const mounts = new Map<RouterLike, Mount[]>();

  proto.use = function (this: RouterLike, ...args: unknown[]) {
    const [first, ...rest] = args;
    const hasPath = typeof first !== "function" && !Array.isArray(first);
    if (hasPath && typeof first !== "string") {
      throw new Error(`Unsupported mount path: ${String(first)}`);
    }
    const list = mounts.get(this) ?? [];
    list.push({
      path: hasPath ? (first as string) : "/",
      handlers: (hasPath ? rest : args).flat(Infinity),
    });
    mounts.set(this, list);
    return original.apply(this, args);
  };

  let root: unknown;
  try {
    ({ default: root } = await import("../../routes/index.js"));
  } finally {
    proto.use = original;
  }
  if (!isRouter(root) || !mounts.has(root)) {
    throw new Error(
      "routes/index.js loaded before collectRoutes could record its mounts"
    );
  }

  const routes: RouteEntry[] = [];
  const walk = (router: RouterLike, prefix: string) => {
    for (const { route } of router.stack) {
      if (!route) continue;
      if (typeof route.path !== "string") {
        throw new Error(`Unsupported route path under ${prefix}`);
      }
      for (const method of Object.keys(route.methods)) {
        if (!METHODS.includes(method)) {
          throw new Error(`Unsupported method ${method} on ${route.path}`);
        }
        routes.push({
          method: method as RouteMethod,
          path: join(prefix, route.path),
        });
      }
    }
    for (const { path, handlers } of mounts.get(router) ?? []) {
      for (const handler of handlers) {
        if (isRouter(handler)) walk(handler, join(prefix, path));
      }
    }
  };
  walk(root, "");
  return routes;
};

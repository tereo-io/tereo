import { NextFunction, Request, RequestHandler, Response } from "express";
import { AlreadyArchivedError, ArchivedError } from "./errors.js";
import { validateParams } from "./validateReq.js";
import { z } from "zod";

/** Any row carrying the archive lifecycle timestamp. */
export type Archivable = { archivedAt?: Date | null };

export interface GuardArchivedOptions {
  /**
   * Predicate deciding whether a request is permitted when the row is
   * archived. Defaults to the per-id sub-router whitelist: reads stay open,
   * plus the two lifecycle escapes (hard DELETE and restore) that must
   * operate on an archived row. On a flat router, pass `() => false` and
   * attach the guard only to the routes that should be blocked.
   */
  allow?: (req: Request) => boolean;
  /**
   * Error thrown when a blocked mutation hits an archived row. Defaults to
   * AlreadyArchivedError (409 `already_archived`) for `POST /archive` and
   * ArchivedError (409 `resource_archived`) for anything else.
   */
  onArchived?: (req: Request) => Error;
}

// Reads always allowed; the only mutations permitted on an archived row are a
// hard DELETE and a restore, both addressed at the sub-router root.
const defaultAllow = (req: Request): boolean =>
  req.method === "GET" ||
  (req.method === "DELETE" && (req.path === "/" || req.path === "")) ||
  (req.method === "POST" && req.path === "/restore");

const defaultOnArchived = (req: Request): Error =>
  req.method === "POST" && req.path === "/archive"
    ? new AlreadyArchivedError()
    : new ArchivedError();

/**
 * Enforce the "archived rows are read-only" rule. `load` fetches the target
 * row from the request; when it resolves to an archived row and the request
 * isn't in the allow-list, `onArchived` is raised. A `null` row falls through
 * so the route's own lookup produces the 404, and any error `load` throws
 * (validation 400, not-found 404) propagates unchanged.
 *
 * `load` is the only trust boundary: where ownership isn't already enforced by
 * a preceding middleware, `load` must enforce it (e.g. throw ForbiddenError on
 * an org mismatch) so the archived check never runs — and never leaks archive
 * state — ahead of the authorization check.
 */
export function guardArchived<T extends Archivable>(
  load: (req: Request) => Promise<T | null>,
  opts: GuardArchivedOptions = {}
): RequestHandler {
  const allow = opts.allow ?? defaultAllow;
  const onArchived = opts.onArchived ?? defaultOnArchived;
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const row = await load(req);
      if (row?.archivedAt && !allow(req)) {
        next(onArchived(req));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export interface GuardArchivedByIdOptions extends GuardArchivedOptions {
  /** Route param holding the row id (validated as a uuid). Defaults to "id". */
  param?: string;
}

// Any 8-4-4-4-12 hex string — deliberately looser than zod's RFC-4122 `.uuid()`
// (which rejects a variant nibble outside 8-b). Postgres' `uuid` type and the
// services' own controllers accept any such string and let a lookup miss return
// 404, so the guard must match that: garbage → 400, uuid-shaped-but-absent → the
// route's own 404 (not a spurious 400 the rest of the API never emits).
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * `guardArchived` for the common case: the row is addressed by a single uuid
 * route param. The param is validated (clean 400 on a malformed id) and passed
 * to `loadById`, so call sites skip the `validateParams(...)` + id-schema
 * import. `req` is still handed through for org-scoping. Loads that do more
 * than fetch-by-id (ownership checks, merged-row handling) should use the
 * lower-level `guardArchived` directly.
 */
export function guardArchivedById<T extends Archivable>(
  loadById: (id: string, req: Request) => Promise<T | null>,
  opts: GuardArchivedByIdOptions = {}
): RequestHandler {
  const { param = "id", ...rest } = opts;
  const schema = z.object({ [param]: z.string().regex(UUID_RE) });
  return guardArchived(
    (req) => loadById(validateParams(schema, req)[param], req),
    rest
  );
}

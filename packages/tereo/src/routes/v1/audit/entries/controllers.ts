import { assertAuditWriteScope } from "../../../../middleware/organizationId.js";
import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { withAuditIdempotency } from "../../../../utils/auditIdempotency.js";
import { callerService } from "../../../../utils/callerService.js";
import {
  CORE_SERVICE,
  CORE_SOURCE,
} from "../../../../definitions/index.js";
import { validateUser } from "../../../../middleware/auth.js";
import { escapeLike } from "../../../../utils/db/like.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { hasNul } from "../../../../utils/pgInput.js";
import db from "../../../../utils/db/index.js";
import { Request, Response } from "express";
import {
  BadRequestError,
  UnprocessableEntityError,
  ValidationError,
} from "../../../../utils/errors.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../utils/cursor.js";
import {
  createEntrySchema,
  createBatchSchema,
  facetsQuerySchema,
  listQuerySchema,
  FACETS_DEFAULT_DAYS,
  SEARCH_MAX_DAYS,
} from "./schemas.js";

// The authenticated principal that actually wrote the entry, taken from the
// token — never the request body. Stamped onto every entry so a forged
// `source`/`userId` (both self-reported by the calling service) is always
// attributable to the real writer. A client writes as its service-account
// user, so the client follows from `users.oauth_client_id`.
const writerIdentity = (auth: { userId: string }) => ({
  writerUserId: auth.userId,
});

/**
 * Entries name users and organizations by id, and both are foreign keys into
 * auth. Neither is ever deleted, so checking before the insert cannot race;
 * it turns a constraint violation into a 400 naming the missing ids.
 */
const assertReferencesExist = async (
  entries: { userId: string; organizationId?: string | null }[]
) => {
  const userIds = [...new Set(entries.map((e) => e.userId))];
  const orgIds = [
    ...new Set(
      entries.map((e) => e.organizationId).filter((id): id is string => !!id)
    ),
  ];
  const [users, orgs] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true },
    }),
    prisma.organization.findMany({
      where: { id: { in: orgIds } },
      select: { id: true },
    }),
  ]);
  const missingUsers = userIds.filter((id) => !users.some((u) => u.id === id));
  const missingOrgs = orgIds.filter((id) => !orgs.some((o) => o.id === id));
  if (missingUsers.length > 0) {
    throw new BadRequestError(
      "unknown_user",
      `No user with id: ${missingUsers.join(", ")}`
    );
  }
  if (missingOrgs.length > 0) {
    throw new BadRequestError(
      "unknown_organization",
      `No organization with id: ${missingOrgs.join(", ")}`
    );
  }
};

/**
 * An app service writes entries only under its own slug, the source its reads
 * are scoped to, and no one else may: core's source and every app service's
 * slug are reserved, so an entry under one was written by its owner. Any
 * other `source` is self-reported. 422, not 403: no grant fixes it, so the
 * SDK outbox dead-letters the row instead of retrying.
 */
const assertSourceAllowed = async (
  auth: { oauthClientId: string | null },
  sources: string[]
) => {
  const service = await callerService(auth);
  if (service) {
    if (sources.some((source) => source !== service.slug)) {
      throw new UnprocessableEntityError(
        "source_mismatch",
        `Service ${service.slug} may only write entries with source "${service.slug}"`
      );
    }
    return;
  }
  const unique = [...new Set(sources)];
  const serviceSlugs = await db.services.findSlugs(unique);
  const reserved = unique.filter(
    (source) =>
      source === CORE_SOURCE ||
      source === CORE_SERVICE.slug ||
      serviceSlugs.has(source)
  );
  if (reserved.length > 0) {
    throw new UnprocessableEntityError(
      "source_reserved",
      `Only the service it names may write entries with source: ${reserved.join(", ")}`
    );
  }
};

export const createEntry = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { idempotencyKey, ...entryData } = validateBody(createEntrySchema, req);
  await assertAuditWriteScope(auth, [entryData.organizationId]);
  await assertSourceAllowed(auth, [entryData.source]);
  await assertReferencesExist([entryData]);
  const entryWithWriter = { ...entryData, ...writerIdentity(auth) };

  const entry = await withAuditIdempotency(
    {
      userId: auth.userId,
      route: "entries",
      key: idempotencyKey,
      body: entryData,
    },
    () => db.auditLogEntries.create(entryWithWriter)
  );
  res.status(201).json(entry);
};

export const createBatch = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { idempotencyKey, entries } = validateBody(createBatchSchema, req);
  await assertAuditWriteScope(
    auth,
    entries.map((e) => e.organizationId)
  );
  await assertSourceAllowed(
    auth,
    entries.map((e) => e.source)
  );
  await assertReferencesExist(entries);
  const writer = writerIdentity(auth);
  const entriesWithWriter = entries.map((e) => ({ ...e, ...writer }));

  const result = await withAuditIdempotency(
    {
      userId: auth.userId,
      route: "entries/batch",
      key: idempotencyKey,
      body: entries,
    },
    () => db.auditLogEntries.createMany(entriesWithWriter)
  );
  res.status(201).json(result);
};

export const list = async (req: Request, res: Response) => {
  if (Array.isArray(req.query["filter[q]"])) {
    throw new ValidationError("filter[q] takes a single value");
  }
  const query = validateQuery(listQuerySchema, req);
  const metadataConditions = parseMetadataFilters(
    req.query as Record<string, unknown>
  );

  // filter[organizationId] was already applied by resolveAuditOrganizationId.
  const {
    organizationId: _requested,
    q: search,
    ...filters
  } = query.where ?? {};
  const q = (search as { equals: string } | undefined)?.equals;
  if (q !== undefined) filters.createdAt = searchWindow(filters);

  // A service's own scope is a clause of its own, so its filter[source]
  // narrows within it rather than replacing it.
  const and = [
    ...((filters.AND as Record<string, unknown>[] | undefined) ?? []),
    ...metadataConditions,
    ...(req.auditSourceScope ? [{ ...req.auditSourceScope }] : []),
  ];
  const baseFilter: Record<string, unknown> = {
    ...filters,
    organizationId: req.auditOrganizationId,
    ...(and.length > 0 && { AND: and }),
  };

  const where = applyCursorToWhere({ ...query, where: baseFilter });
  const page = { take: query.limit, orderBy: query.orderBy, where };

  const result =
    q === undefined
      ? await db.auditLogEntries.getPaginated(page)
      : await db.auditLogEntries.searchPaginated({ ...page, q });
  res.json(buildCursorPageResponse(result, query));
};

const DAY_MS = 24 * 60 * 60 * 1000;
// A client computing "31 days ago" on its own clock may be a little ahead of
// ours; a window that much over the limit still passes.
const SEARCH_WINDOW_SKEW_MS = 5 * 60 * 1000;

/**
 * The `createdAt` range a search may cover: at most `SEARCH_MAX_DAYS`, ending
 * at `createdAt_lte` (or now). Without `createdAt_gte` the window starts
 * `SEARCH_MAX_DAYS` before its end. A repeated bound lands in `where.AND`
 * (see `mergeClausesIntoWhere`), so the window takes the tightest bound across
 * `createdAt` and those; the `AND` clauses stay and intersect with it.
 */
const searchWindow = (
  filters: Record<string, unknown>
): { gte: Date; lte?: Date } => {
  const and = (filters.AND as Record<string, unknown>[] | undefined) ?? [];
  const ranges = [filters.createdAt, ...and.map((c) => c.createdAt)].filter(
    Boolean
  ) as { gte?: Date; lte?: Date }[];
  const bound = (dates: (Date | undefined)[], pick: typeof Math.max) => {
    const times = dates.filter((d): d is Date => !!d).map((d) => d.getTime());
    return times.length > 0 ? new Date(pick(...times)) : undefined;
  };
  const gte = bound(
    ranges.map((r) => r.gte),
    Math.max
  );
  const lte = bound(
    ranges.map((r) => r.lte),
    Math.min
  );
  const end = lte ?? new Date();
  const maxSpan = SEARCH_MAX_DAYS * DAY_MS;
  if (gte && end.getTime() - gte.getTime() > maxSpan + SEARCH_WINDOW_SKEW_MS) {
    throw new BadRequestError(
      "search_window_too_large",
      `filter[q] searches at most ${SEARCH_MAX_DAYS} days; narrow filter[createdAt_gte] / filter[createdAt_lte]`
    );
  }
  return { gte: gte ?? new Date(end.getTime() - maxSpan), ...(lte && { lte }) };
};

/**
 * Facets of the entries in the request's date window, as the list filters it;
 * without `filter[createdAt_gte]` the window starts `FACETS_DEFAULT_DAYS`
 * before its end, so the scan stays on recent partitions.
 */
export const facets = async (req: Request, res: Response) => {
  const query = validateQuery(facetsQuerySchema, req);
  const lte = query["filter[createdAt_lte]"];
  const end = lte ?? new Date();
  const gte =
    query["filter[createdAt_gte]"] ??
    new Date(end.getTime() - FACETS_DEFAULT_DAYS * DAY_MS);
  res.json(
    await db.auditLogEntries.getFacets(
      req.auditOrganizationId,
      { gte, ...(lte && { lte }) },
      req.auditSourceScope
    )
  );
};

/**
 * Parse metadata[key_operator]=value query params into Prisma JSON path conditions.
 * Supports `equals` and `contains` (maps to Prisma `string_contains`). Any other
 * `metadata[...]` param is refused rather than silently widening the result.
 */
function parseMetadataFilters(
  query: Record<string, unknown>
): Record<string, unknown>[] {
  const conditions: Record<string, unknown>[] = [];
  const metadataRegex = /^metadata\[(.+?)_(equals|contains)\]$/;

  for (const [key, rawValue] of Object.entries(query)) {
    if (!key.startsWith("metadata[")) continue;
    const match = key.match(metadataRegex);
    if (!match) {
      throw new ValidationError(
        `${key}: metadata filters take the form metadata[<key>_equals] or metadata[<key>_contains]`
      );
    }
    if (typeof rawValue !== "string") {
      throw new ValidationError(`${key} takes a single value`);
    }
    const [, metaKey, operator] = match;
    if (hasNul(metaKey) || hasNul(rawValue)) {
      throw new ValidationError(`${key} must not contain a NUL character`);
    }
    if (rawValue === "") continue;
    // Prisma's string_contains is a LIKE that leaves `_` and `%` as wildcards.
    conditions.push({
      metadata:
        operator === "contains"
          ? { path: [metaKey], string_contains: escapeLike(rawValue) }
          : { path: [metaKey], equals: rawValue },
    });
  }

  return conditions;
}

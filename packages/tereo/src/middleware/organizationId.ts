import { ForbiddenError, ValidationError } from "../utils/errors.js";
import { UserType } from "../../prisma/generated/client/index.js";
import { PERMISSIONS } from "../definitions/permissions.js";
import { Request, Response, NextFunction } from "express";
import { hasPermission } from "../utils/permissions.js";
import type { AuthContext } from "./auth.js";
import db from "../utils/db/index.js";

declare global {
  namespace Express {
    interface Request {
      organizationId?: string;
      auditOrganizationId?: string | null;
    }
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Webhook routes: the organization is the token's `org_id`. A `webhooks.admin`
 * caller may name another with `X-Organization-ID`, which must be an existing
 * organization; anyone else's header is ignored.
 */
export const resolveWebhookOrganizationId = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  const header = req.headers["x-organization-id"];
  const requested = typeof header === "string" ? header : undefined;
  if (
    requested &&
    hasPermission(req.auth?.permissions ?? [], PERMISSIONS.WEBHOOKS.ADMIN)
  ) {
    if (!UUID_RE.test(requested)) {
      throw new ValidationError("X-Organization-ID must be an organization id");
    }
    await db.organizations.getAny(requested);
    req.organizationId = requested;
    return next();
  }

  const orgId = req.auth?.organizationId;
  if (!orgId) {
    throw new ForbiddenError(
      "Organization context required. Token must include an org_id."
    );
  }

  req.organizationId = orgId;
  next();
};

const AUDIT_SYSTEM_WIDE_FILTER = "none";

const parseAuditOrganizationFilter = (
  req: Request
): string | null | undefined => {
  const raw = req.query["filter[organizationId]"];
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new ValidationError("filter[organizationId] takes a single value");
  }
  if (raw === AUDIT_SYSTEM_WIDE_FILTER) return null;
  if (!UUID_RE.test(raw)) {
    throw new ValidationError(
      `filter[organizationId] must be an organization id or "${AUDIT_SYSTEM_WIDE_FILTER}"`
    );
  }
  return raw;
};

/**
 * Audit reads: sets `req.auditOrganizationId` — an organization id, `null` for
 * system-wide entries, or `undefined` for every organization.
 *
 * `filter[organizationId]=<id>|none` overrides the token's organization only
 * for `audit-logs.admin`; anyone else may name only their own. Without it,
 * reads are scoped to the token's `org_id`, and an admin token without one
 * sees every organization.
 */
export const resolveAuditOrganizationId = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  const tokenOrgId = req.auth?.organizationId;
  const isAdmin = hasPermission(
    req.auth?.permissions ?? [],
    PERMISSIONS.AUDIT_LOGS.ADMIN
  );
  const requested = parseAuditOrganizationFilter(req);

  if (requested !== undefined) {
    if (!isAdmin && (requested === null || requested !== tokenOrgId)) {
      throw new ForbiddenError(
        "Only audit-logs.admin may read another organization's entries"
      );
    }
    req.auditOrganizationId = requested;
    return next();
  }

  if (tokenOrgId) {
    req.auditOrganizationId = tokenOrgId;
    return next();
  }

  if (isAdmin) return next();

  throw new ForbiddenError(
    "Organization context required. Token must include an org_id."
  );
};

/**
 * Writes on behalf of organizations — audit entries, emitted events: the
 * organizations a caller may write for.
 *
 * - `adminPermission`: any organization, or none (system-wide).
 * - A token with an `org_id`: only that organization. A system-wide write is
 *   outside it, so an organization must be given.
 * - A service account's token without an `org_id` — an app service's client,
 *   which writes for every tenant of its app: any organization, or none.
 * - A person's token without an `org_id`: nothing.
 *
 * One disallowed organization refuses the whole request, so a batch stays
 * all-or-nothing. Callers check this before checking that the organizations
 * exist, so a refused caller can't probe which do.
 */
const assertOrganizationWriteScope = (
  auth: Pick<AuthContext, "permissions" | "organizationId" | "userType">,
  organizationIds: (string | null | undefined)[],
  adminPermission: string,
  refusal: string
): void => {
  if (hasPermission(auth.permissions, adminPermission)) return;

  const tokenOrgId = auth.organizationId;
  if (!tokenOrgId) {
    if (auth.userType === UserType.service_account) return;
    throw new ForbiddenError(
      "Organization context required. Token must include an org_id."
    );
  }

  if (organizationIds.some((id) => id !== tokenOrgId)) {
    throw new ForbiddenError(refusal);
  }
};

/** Audit writes: see `assertOrganizationWriteScope`; the admin is `audit-logs.admin`. */
export const assertAuditWriteScope = (
  auth: Pick<AuthContext, "permissions" | "organizationId" | "userType">,
  organizationIds: (string | null | undefined)[]
): void =>
  assertOrganizationWriteScope(
    auth,
    organizationIds,
    PERMISSIONS.AUDIT_LOGS.ADMIN,
    "Only audit-logs.admin may write entries for another organization or system-wide"
  );

/** Event emission: see `assertOrganizationWriteScope`; the admin is `webhooks.admin`. */
export const assertEmitScope = (
  auth: Pick<AuthContext, "permissions" | "organizationId" | "userType">,
  organizationIds: string[]
): void =>
  assertOrganizationWriteScope(
    auth,
    organizationIds,
    PERMISSIONS.WEBHOOKS.ADMIN,
    "Only webhooks.admin may emit events for another organization"
  );

/** Notification sends: see `assertOrganizationWriteScope`; the admin is `notifications.admin`. */
export const assertNotificationWriteScope = (
  auth: Pick<AuthContext, "permissions" | "organizationId" | "userType">,
  organizationIds: (string | null | undefined)[]
): void =>
  assertOrganizationWriteScope(
    auth,
    organizationIds,
    PERMISSIONS.NOTIFICATIONS.ADMIN,
    "Only notifications.admin may send for another organization"
  );

/** Returns `req.organizationId`, or throws if it was not resolved. */
export const validateOrganizationId = (req: Request): string => {
  if (!req.organizationId)
    throw new ForbiddenError("Organization context required");
  return req.organizationId;
};

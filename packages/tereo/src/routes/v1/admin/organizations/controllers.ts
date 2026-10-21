import { getDefaultOrganizationId } from "../../../../utils/defaultOrganization.js";
import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { ConflictError, NotFoundError } from "../../../../utils/errors.js";
import { formatOrganization } from "../../../../utils/transformers.js";
import { emitTx, logAuditTx } from "../../../../utils/outbox.js";
import { validateUser } from "../../../../utils/auth.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../utils/cursor.js";
import {
  CreateOrganizationSchema,
  ListOrganizationsQuerySchema,
  listOrganizationsExtraQuerySchema,
} from "./schemas.js";

export const createOrganization = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(CreateOrganizationSchema, req);

  const existing = await db.organizations.getBySlugAny(body.slug);
  if (existing) {
    throw new ConflictError(
      existing.archivedAt
        ? "An archived organization with this slug already exists"
        : "Organization with this slug already exists",
      "slug_taken"
    );
  }
  const codeTaken = await db.organizations.getByCodeAny(body.code);
  if (codeTaken) {
    throw new ConflictError(
      codeTaken.archivedAt
        ? "An archived organization with this code already exists"
        : "Organization with this code already exists",
      "code_taken"
    );
  }

  const org = await db.$transaction(async (tx) => {
    const created = await db.organizations.create(body, tx);
    await logAuditTx(tx, {
      auth,
      organizationId: created.id,
      action: "CREATE",
      entityType: "Organization",
      entityId: created.id,
      entityName: created.name,
      metadata: { slug: created.slug, code: created.code },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.created",
      entityType: "Organization",
      entityId: created.id,
      data: formatOrganization(created) as Record<string, unknown>,
    });
    return created;
  });

  res.status(201).json(formatOrganization(org));
};

export const listOrganizations = async (req: Request, res: Response) => {
  const query = validateQuery(ListOrganizationsQuerySchema, req);

  const where = applyCursorToWhere(query);

  const { includeArchived } = validateQuery(
    listOrganizationsExtraQuerySchema,
    req
  );

  const result = await db.organizations.getPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where,
    includeArchived,
  });

  const page = buildCursorPageResponse(result, query);
  res.json({ ...page, data: page.data.map(formatOrganization) });
};

export const getDefaultOrganization = async (_req: Request, res: Response) => {
  const org = await db.organizations.getDefault();
  if (!org) throw new NotFoundError("No default organization configured");
  res.json(formatOrganization(org));
};

import { getDefaultOrganizationId } from "../../../../utils/defaultOrganization.js";
import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { emitTx, logAuditTx } from "../../../../utils/outbox.js";
import { formatRole } from "../../../../utils/transformers.js";
import { ConflictError } from "../../../../utils/errors.js";
import { validateUser } from "../../../../utils/auth.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../utils/cursor.js";
import {
  CreateRoleSchema,
  ListRolesQuerySchema,
  listRolesExtraQuerySchema,
} from "./schemas.js";

export const createRole = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(CreateRoleSchema, req);

  const existing = await db.roles.getCustomByNameAny(body.name);
  if (existing) {
    throw new ConflictError(
      existing.archivedAt
        ? "An archived role with this name already exists"
        : "Role with this name already exists"
    );
  }

  const roleWithPermissions = await db.$transaction(async (tx) => {
    const role = await db.roles.create(body, tx);
    const withPerms = await db.roles.get(role.id, tx);
    await logAuditTx(tx, {
      auth,
      action: "CREATE",
      entityType: "Role",
      entityId: withPerms.id,
      entityName: withPerms.name,
      metadata: {
        displayName: withPerms.displayName,
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.role.created",
      entityType: "Role",
      entityId: withPerms.id,
      data: formatRole(withPerms) as Record<string, unknown>,
    });
    return withPerms;
  });

  res.status(201).json(formatRole(roleWithPermissions));
};

export const listRoles = async (req: Request, res: Response) => {
  const query = validateQuery(ListRolesQuerySchema, req);

  const where = applyCursorToWhere(query);

  const { includeArchived, includeRetired } = listRolesExtraQuerySchema.parse(
    req.query
  );

  const result = await db.roles.getPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where: {
      ...where,
      ...(includeRetired ? {} : { retiredAt: null }),
    },
    includeArchived,
  });

  const page = buildCursorPageResponse(result, query);
  res.json({ ...page, data: page.data.map(formatRole) });
};

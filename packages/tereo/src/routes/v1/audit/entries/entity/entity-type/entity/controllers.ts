import { entityParamsSchema, entityQuerySchema } from "./schemas.js";
import db from "../../../../../../../utils/db/index.js";
import { Request, Response } from "express";
import {
  validateParams,
  validateQuery,
} from "../../../../../../../utils/validateReq.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../../../../utils/cursor.js";

export const getByEntity = async (req: Request, res: Response) => {
  const params = validateParams(entityParamsSchema, req);
  const query = validateQuery(entityQuerySchema, req);

  // filter[organizationId] was already applied by resolveAuditOrganizationId.
  const { organizationId: _requested, ...filters } = query.where ?? {};
  const where = applyCursorToWhere(
    { ...query, where: filters },
    {
      entityType: params.entityType,
      entityId: params.entityId,
      organizationId: req.auditOrganizationId,
    }
  );

  const result = await db.auditLogEntries.getPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where,
  });
  res.json(buildCursorPageResponse(result, query));
};

import { validateQuery } from "../../../../utils/validateReq.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../utils/cursor.js";
import {
  ListPermissionsQuerySchema,
  listPermissionsExtraQuerySchema,
} from "./schemas.js";

// Permissions are declared in code by their services and registered at boot
// (utils/registry.ts); admins read them and compose custom roles from them.

export const listPermissions = async (req: Request, res: Response) => {
  const query = validateQuery(ListPermissionsQuerySchema, req);

  const where = applyCursorToWhere(query);

  const { includeRetired } = validateQuery(
    listPermissionsExtraQuerySchema,
    req
  );

  const result = await db.permissions.getPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where,
    includeRetired,
  });

  res.json(buildCursorPageResponse(result, query));
};

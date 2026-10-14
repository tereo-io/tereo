import { validateQuery } from "../../../../../utils/validateReq.js";
import { ListNotificationsQuerySchema } from "./schemas.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../../utils/cursor.js";

export const listNotifications = async (req: Request, res: Response) => {
  const query = validateQuery(ListNotificationsQuerySchema, req);
  const result = await db.notifications.list({
    take: query.limit,
    orderBy: query.orderBy,
    where: applyCursorToWhere(query),
  });
  res.json(buildCursorPageResponse(result, query));
};

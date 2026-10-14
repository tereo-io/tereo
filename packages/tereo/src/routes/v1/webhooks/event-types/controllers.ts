import { validateQuery } from "../../../../utils/validateReq.js";
import { getEventTypesQuerySchema } from "./schemas.js";
import db from "../../../../utils/db/index.js";
import { Request, Response } from "express";
import {
  applyCursorToWhere,
  encodeListCursor,
} from "../../../../utils/cursor.js";

export const listEventTypes = async (req: Request, res: Response) => {
  const query = validateQuery(getEventTypesQuerySchema, req);

  const where = applyCursorToWhere(query);

  const result = await db.eventTypes.getPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where,
  });

  // EventType's primary key is `eventType`, not `id` — encode the cursor
  // explicitly so we can pass the right tiebreaker value.
  const lastRow = result.data[result.data.length - 1];
  const nextCursor =
    result.hasMore && lastRow
      ? encodeListCursor({
          sort: query.sort,
          sortDir: query.sortDir,
          sortValue: (lastRow as unknown as Record<string, unknown>)[
            query.sortPrismaField
          ],
          id: lastRow.eventType,
        })
      : null;

  res.json({
    data: result.data,
    hasMore: result.hasMore,
    limit: query.limit,
    nextCursor,
  });
};

import { setAccessLog } from "../../../../../../../../../middleware/accessLog.js";
import { validateQuery } from "../../../../../../../../../utils/validateReq.js";
import { resolveObjectById, serializeVersions } from "./utils.js";
import db from "../../../../../../../../../utils/db/index.js";
import { Request, Response } from "express";
import {
  applyCursorToWhere,
  encodeListCursor,
} from "../../../../../../../../../utils/cursor.js";
import {
  byIdListVersionsParamsSchema,
  listVersionsQuerySchema,
} from "./schemas.js";

export const listObjectVersionsById = async (req: Request, res: Response) => {
  const { bucket, object } = await resolveObjectById(
    req,
    "read",
    byIdListVersionsParamsSchema
  );
  const query = validateQuery(listVersionsQuerySchema, req);

  setAccessLog(res, {
    bucketId: bucket.id,
    objectId: object.id,
    operation: "LIST_VERSIONS",
  });

  const where = applyCursorToWhere(query);

  const result = await db.objectVersions.listPaginated({
    objectId: object.id,
    take: query.limit,
    orderBy: query.orderBy,
    where,
  });

  const lastRow = result.data[result.data.length - 1];
  const nextCursor =
    result.hasMore && lastRow
      ? encodeListCursor({
          sort: query.sort,
          sortDir: query.sortDir,
          sortValue: (lastRow as unknown as Record<string, unknown>)[
            query.sortPrismaField
          ],
          id: lastRow.id,
        })
      : null;

  res.json({
    data: await serializeVersions(req, bucket.name, result.data),
    hasMore: result.hasMore,
    limit: query.limit,
    nextCursor,
  });
};

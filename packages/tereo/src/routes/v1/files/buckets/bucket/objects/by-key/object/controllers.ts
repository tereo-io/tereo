import { getReadableBucket } from "../../../../../../../../utils/bucketAccess.js";
import { setAccessLog } from "../../../../../../../../middleware/accessLog.js";
import { validateParams } from "../../../../../../../../utils/validateReq.js";
import { serializeObject, standardizeObjectKey } from "../../utils.js";
import { objectParamsSchema } from "../../object/schemas.js";
import db from "../../../../../../../../utils/db/index.js";
import { Request, Response } from "express";

/**
 * Resolve a (bucket, objectKey) pair to its stable UUID id + full metadata.
 * Wraps `getByKey` with the same serialization as `GET /by-id/:id` so clients
 * that only hold a key can fetch the id for subsequent id-addressed mutations
 * in a single round trip.
 *
 * GET /buckets/:name/objects/by-key/*objectKey
 */
export const getObjectByKey = async (req: Request, res: Response) => {
  standardizeObjectKey(req);
  const params = validateParams(objectParamsSchema, req);

  const bucket = await getReadableBucket(req, params.name);

  const object = await db.objects.getByKey(bucket.id, params.objectKey);

  setAccessLog(res, {
    bucketId: bucket.id,
    objectId: object.id,
    operation: "GET_OBJECT_METADATA",
  });

  res.json(serializeObject(object));
};

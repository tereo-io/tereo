import { getAccessibleBucket } from "../../../../../../../../../utils/bucketAccess.js";
import { sign as presignSign } from "../../../../../../../../../utils/presigning.js";
import { setAccessLog } from "../../../../../../../../../middleware/accessLog.js";
import { validateUser } from "../../../../../../../../../middleware/auth.js";
import { logAuditTx } from "../../../../../../../../../utils/outbox.js";
import { assertObjectKeyNotReserved } from "../../../utils.js";
import db from "../../../../../../../../../utils/db/index.js";
import { byIdParamsSchema } from "../schemas.js";
import { presignBodySchema } from "./schemas.js";
import { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../../../../utils/validateReq.js";

/**
 * POST /buckets/:name/objects/by-id/:id/presign
 * Generate a presigned URL for read or write access. The signature binds the
 * object's id (so it survives a rename) and the caller, who is recorded as the
 * writer of an upload through the URL.
 */
export const presignObjectById = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(byIdParamsSchema, req);
  const body = validateBody(presignBodySchema, req);

  const bucket = await getAccessibleBucket(
    auth,
    params.name,
    body.operation === "write" ? "write" : "read"
  );

  const object = await db.objects.getById(bucket.id, params.id);
  if (body.operation === "write") assertObjectKeyNotReserved(object.objectKey);

  setAccessLog(res, {
    bucketId: bucket.id,
    objectId: object.id,
    operation: body.operation === "write" ? "PRESIGN_WRITE" : "PRESIGN_READ",
  });

  const signed = presignSign({
    bucket: params.name,
    id: params.id,
    operation: body.operation,
    expiresInSeconds: body.expiresInSeconds,
    by: auth.userId,
  });

  // No DB write occurs for a presigned URL (signatures are stateless), but
  // still publish the audit through the outbox so it survives a service crash
  // before dispatch.
  await db.$transaction(async (tx) => {
    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "CREATE",
      entityType: "presignedUrl",
      entityId: `${bucket.id}:${params.id}`,
      entityName: object.objectKey,
      metadata: {
        bucketName: bucket.name,
        objectKey: object.objectKey,
        objectId: params.id,
        operation: body.operation,
        expiresAt: signed.expiresAt.toISOString(),
      },
    });
  });

  res.json({
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
    operation: signed.operation,
  });
};

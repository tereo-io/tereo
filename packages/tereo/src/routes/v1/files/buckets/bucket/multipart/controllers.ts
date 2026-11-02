import { assertWritePreconditions } from "../../../../../../utils/writePreconditions.js";
import { getAccessibleBucket } from "../../../../../../utils/bucketAccess.js";
import { setAccessLog } from "../../../../../../middleware/accessLog.js";
import { initiateBodySchema, initiateParamsSchema } from "./schemas.js";
import { validateUser } from "../../../../../../middleware/auth.js";
import { assertMultipartFits, assertStagingFits } from "./utils.js";
import db from "../../../../../../utils/db/index.js";
import { Request, Response } from "express";
import env from "../../../../../../env.js";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  bucketEventScope,
  logAuditTx,
  emitTx,
} from "../../../../../../utils/outbox.js";
import {
  assertObjectKeyNotReserved,
  parseEtagPreconditions,
} from "../objects/utils.js";

export const initiateMultipart = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(initiateParamsSchema, req);
  const body = validateBody(initiateBodySchema, req);
  const bucket = await getAccessibleBucket(auth, params.name, "write");
  // After the access check, so a caller without access learns nothing.
  assertObjectKeyNotReserved(body.objectKey);
  if (body.expectedSize !== undefined) {
    assertMultipartFits({ expectedSize: null }, bucket, body.expectedSize);
  }
  // Advisory: complete re-checks under lock. Failing here spares the caller
  // sending every part first.
  if (req.header("If-Match") || req.header("If-None-Match")) {
    const state = await db.objects.getWriteState(bucket.id, body.objectKey);
    assertWritePreconditions(
      parseEtagPreconditions(req),
      state.existing,
      state.currentEtag
    );
  }

  const upload = await db.$transaction(async (tx) => {
    const u = await db.multipartUploads.initiate(
      {
        bucketId: bucket.id,
        objectKey: body.objectKey,
        contentType: body.contentType,
        metadata: body.metadata as never,
        tags: body.tags,
        expectedSize: body.expectedSize,
        createdBy: auth.userId,
        ttlHours: env.FILE_SERVICE_MULTIPART_UPLOAD_TTL_HOURS,
        maxActive: env.FILE_SERVICE_MAX_ACTIVE_MULTIPART_UPLOADS,
      },
      tx,
      (current, stagedBytes) =>
        assertStagingFits(current, stagedBytes, body.expectedSize)
    );

    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "CREATE",
      entityType: "multipartUpload",
      entityId: u.id,
      entityName: u.objectKey,
      metadata: {
        bucketName: bucket.name,
        objectKey: u.objectKey,
        contentType: u.contentType,
      },
    });

    await emitTx(tx, {
      eventType: "file-service.multipart.initiated",
      ...bucketEventScope(bucket),
      entityType: "multipartUpload",
      entityId: u.id,
      data: {
        bucketName: bucket.name,
        objectKey: u.objectKey,
        contentType: u.contentType,
        expiresAt: u.expiresAt,
      },
    });

    return u;
  });

  setAccessLog(res, {
    bucketId: bucket.id,
    operation: "INITIATE_MULTIPART",
  });

  res.status(201).json({
    uploadId: upload.id,
    bucket: bucket.name,
    objectKey: upload.objectKey,
    contentType: upload.contentType,
    expiresAt: upload.expiresAt,
  });
};

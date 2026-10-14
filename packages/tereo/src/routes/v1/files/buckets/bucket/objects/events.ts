import type { Prisma } from "../../../../../../utils/db/prisma.js";
import { emitTx } from "../../../../../../utils/outbox.js";
import { serializeObject } from "./utils.js";
import type {
  ObjectWithCurrent,
  UpsertWithBlobResult,
} from "../../../../../../utils/db/objects.js";

type EventBucket = {
  name: string;
  organizationId: string | null;
};

export type ObjectWriteVia = "direct" | "presigned" | "multipart";

export const emitVersionCreatedTx = async (
  tx: Prisma.TransactionClient,
  bucket: EventBucket,
  object: ObjectWithCurrent,
  via: ObjectWriteVia | "metadata"
) => {
  if (!bucket.organizationId) return;
  const version = object.versions[0];
  if (!version) return;

  await emitTx(tx, {
    eventType: "file-service.object.version.created",
    organizationId: bucket.organizationId,
    entityType: "objectVersion",
    entityId: version.id,
    data: {
      bucketName: bucket.name,
      objectKey: object.objectKey,
      objectId: object.id,
      versionId: version.id,
      contentType: version.contentType,
      sizeBytes: version.contentBlob?.sizeBytes.toString() ?? null,
      etag: version.etag,
      via,
    },
  });
};

/**
 * Emits `object.created` or `object.updated` for a content write, plus
 * `object.version.created` when the write kept versions.
 */
export const emitObjectWrittenTx = async (
  tx: Prisma.TransactionClient,
  bucket: EventBucket,
  upsert: UpsertWithBlobResult,
  via: ObjectWriteVia
) => {
  if (!bucket.organizationId) return;
  const serialized = serializeObject(upsert.object);

  await emitTx(tx, {
    eventType:
      upsert.type === "updated"
        ? "file-service.object.updated"
        : "file-service.object.created",
    organizationId: bucket.organizationId,
    entityType: "object",
    entityId: String(upsert.object.id),
    data: {
      bucketName: bucket.name,
      objectKey: serialized.key,
      contentType: serialized.contentType,
      sizeBytes: serialized.sizeBytes,
      etag: serialized.etag,
      tags: serialized.tags,
      via,
    },
  });

  if (upsert.versioningEnabled) {
    await emitVersionCreatedTx(tx, bucket, upsert.object, via);
  }
};

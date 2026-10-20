import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { Prisma } from "../../../prisma/generated/client/index.js";
import { prisma } from "./prisma.js";
import { v7 as uuidv7 } from "uuid";
import {
  generateStagingDek,
  unwrapDek,
  aadForUploadId,
} from "../encryption.js";

export interface InitiateInput {
  bucketId: number;
  objectKey: string;
  contentType: string;
  metadata?: Prisma.InputJsonValue;
  tags?: string[];
  expectedSize?: bigint;
  createdBy: string;
  ttlHours: number;
  /** Active uploads the creator may hold in the bucket, this one included. */
  maxActive: number;
}

export interface UpsertPartInput {
  uploadId: string;
  partNumber: number;
  sizeBytes: bigint;
  etag: string;
  fsPath: string;
}

function newUploadId(): string {
  return uuidv7();
}

/**
 * `assertFits` gets the bucket's quota and usage and the `expectedSize`s its
 * active uploads have staged against them, under a lock that orders the
 * bucket's initiates, and throws to refuse the upload.
 */
export const initiate = async (
  input: InitiateInput,
  tx: Prisma.TransactionClient,
  assertFits: (
    bucket: { storageQuotaBytes: bigint | null; currentUsageBytes: bigint },
    stagedBytes: bigint
  ) => void
) => {
  // Initiates to one bucket count one after the other, so each sees the
  // uploads the others staged.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`files:multipart:${input.bucketId}`}, 0))`;
  const bucket = await tx.bucket.findUniqueOrThrow({
    where: { id: input.bucketId },
    select: { storageQuotaBytes: true, currentUsageBytes: true },
  });
  const { _sum } = await tx.multipartUpload.aggregate({
    where: {
      bucketId: input.bucketId,
      completedAt: null,
      abortedAt: null,
      expiresAt: { gt: new Date() },
    },
    _sum: { expectedSize: true },
  });
  assertFits(bucket, _sum.expectedSize ?? 0n);
  const active = await tx.multipartUpload.count({
    where: {
      bucketId: input.bucketId,
      createdBy: input.createdBy,
      completedAt: null,
      abortedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (active >= input.maxActive) {
    throw new ConflictError(
      `You have ${active} multipart uploads in progress in this bucket, the most allowed; complete or abort one first`,
      "too_many_multipart_uploads"
    );
  }
  const expiresAt = new Date(Date.now() + input.ttlHours * 60 * 60 * 1000);
  // Generate the upload id up front so we can bind the staging DEK to it via
  // AAD before persisting the row. The wrap fails closed if the row's id is
  // ever altered, so the DEK on disk can never be re-pointed at another
  // upload's parts.
  const id = newUploadId();
  const { wrapped, masterKeyVersion } = generateStagingDek(id);
  return await tx.multipartUpload.create({
    data: {
      id,
      bucketId: input.bucketId,
      objectKey: input.objectKey,
      contentType: input.contentType,
      metadata: input.metadata,
      tags: input.tags ?? [],
      expectedSize: input.expectedSize ?? null,
      createdBy: input.createdBy,
      expiresAt,
      wrappedStagingDek: new Uint8Array(wrapped),
      stagingDekMasterKeyVersion: masterKeyVersion,
    },
  });
};

/**
 * Unwrap the per-upload staging DEK from a row produced by `getActive` /
 * `getAny`. AAD = uploadId — a tampered row id makes this fail closed.
 */
export function unwrapStagingDek(row: {
  id: string;
  wrappedStagingDek: Uint8Array;
  stagingDekMasterKeyVersion: number;
}): Buffer {
  return unwrapDek(
    Buffer.from(row.wrappedStagingDek),
    row.stagingDekMasterKeyVersion,
    aadForUploadId(row.id)
  );
}

export const getActive = async (uploadId: string) => {
  // Past expiresAt counts as gone before the sweep aborts it.
  const upload = await prisma.multipartUpload.findFirst({
    where: {
      id: uploadId,
      completedAt: null,
      abortedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (!upload)
    throw new NotFoundError("Multipart upload not found or no longer active");
  return upload;
};

export const getAny = async (uploadId: string) => {
  const upload = await prisma.multipartUpload.findUnique({
    where: { id: uploadId },
  });
  if (!upload) throw new NotFoundError("Multipart upload not found");
  return upload;
};

export const listParts = async (uploadId: string) => {
  return await prisma.multipartPart.findMany({
    where: { uploadId },
    orderBy: { partNumber: "asc" },
  });
};

/**
 * The active upload and its parts, read under a share lock on the upload's
 * row: a part PUT records its part under that row's update lock, so the parts
 * read here are not displaced while being read.
 */
export const getActiveWithParts = async (uploadId: string) =>
  prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "files"."multipart_uploads"
      WHERE "id" = ${uploadId}::uuid
      FOR SHARE
    `;
    const upload = await tx.multipartUpload.findFirst({
      where: {
        id: uploadId,
        completedAt: null,
        abortedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!upload)
      throw new NotFoundError("Multipart upload not found or no longer active");
    const parts = await tx.multipartPart.findMany({
      where: { uploadId },
      orderBy: { partNumber: "asc" },
    });
    return { upload, parts };
  });

/**
 * Upsert a staged part. Returns the prior `fsPath` (if any) so the caller
 * can unlink the displaced file. Each part PUT writes to a unique-nonce
 * path under `multipart/{uploadId}/`, so two concurrent PUTs to the same
 * `partNumber` never race on the same file; the upload's row lock orders
 * their upserts, so the later one finds the earlier one's file to unlink.
 *
 * Under that lock, `assertNotCompleting` throws while a complete of the
 * upload runs, and `assertFits` gets the bytes the upload's other parts hold
 * and throws to refuse the part; the caller then unlinks its file. An upload
 * completed, aborted or expired since the caller read it is refused too.
 */
export const upsertPart = async (
  input: UpsertPartInput,
  checks: {
    assertNotCompleting: () => Promise<void>;
    assertFits: (otherPartsBytes: bigint) => void;
  }
) =>
  prisma.$transaction(async (tx) => {
    // Parts of one upload are recorded one at a time, so each sees the bytes
    // the others staged.
    const rows = await tx.$queryRaw<{ active: boolean }[]>`
      SELECT ("completed_at" IS NULL
        AND "aborted_at" IS NULL
        AND "expires_at" > NOW()) AS "active"
      FROM "files"."multipart_uploads"
      WHERE "id" = ${input.uploadId}::uuid
      FOR UPDATE
    `;
    if (!rows[0]?.active) {
      throw new BadRequestError(
        "upload_not_active",
        "Upload is not in an active state"
      );
    }
    await checks.assertNotCompleting();
    checks.assertFits(await stagedBytes(input.uploadId, input.partNumber, tx));
    return recordPart(input, tx);
  });

/**
 * Bytes staged for an upload's parts, but for `exceptPartNumber`'s, which the
 * part being uploaded replaces.
 */
export const stagedBytes = async (
  uploadId: string,
  exceptPartNumber: number,
  tx?: Prisma.TransactionClient
): Promise<bigint> => {
  const client = tx ?? prisma;
  const { _sum } = await client.multipartPart.aggregate({
    where: { uploadId, partNumber: { not: exceptPartNumber } },
    _sum: { sizeBytes: true },
  });
  return _sum.sizeBytes ?? 0n;
};

const recordPart = async (
  input: UpsertPartInput,
  tx: Prisma.TransactionClient
) => {
  const prior = await tx.multipartPart.findUnique({
    where: {
      uploadId_partNumber: {
        uploadId: input.uploadId,
        partNumber: input.partNumber,
      },
    },
    select: { fsPath: true },
  });
  const row = await tx.multipartPart.upsert({
    where: {
      uploadId_partNumber: {
        uploadId: input.uploadId,
        partNumber: input.partNumber,
      },
    },
    create: {
      uploadId: input.uploadId,
      partNumber: input.partNumber,
      sizeBytes: input.sizeBytes,
      etag: input.etag,
      fsPath: input.fsPath,
      aadBound: true,
    },
    update: {
      sizeBytes: input.sizeBytes,
      etag: input.etag,
      fsPath: input.fsPath,
      aadBound: true,
      uploadedAt: new Date(),
    },
  });
  return {
    row,
    priorFsPath: prior && prior.fsPath !== input.fsPath ? prior.fsPath : null,
  };
};

// Throws when a racing completion, abort or expiry finalized the upload
// first, rolling back the caller's transaction so it writes nothing.
export const markCompleted = async (
  uploadId: string,
  tx: Prisma.TransactionClient
) => {
  const { count } = await tx.multipartUpload.updateMany({
    where: { id: uploadId, completedAt: null, abortedAt: null },
    data: { completedAt: new Date() },
  });
  if (count === 0) {
    throw new BadRequestError(
      "upload_not_active",
      "Upload is not in an active state"
    );
  }
};

// False when the upload was already completed or aborted, so a racing abort,
// expiry or completion finalizes it (and emits its event) only once.
export const markAborted = async (
  uploadId: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const client = tx ?? prisma;
  const { count } = await client.multipartUpload.updateMany({
    where: { id: uploadId, completedAt: null, abortedAt: null },
    data: { abortedAt: new Date() },
  });
  return count > 0;
};

/**
 * Drop all `MultipartPart` rows for an upload. Called after the staging dir
 * has been removed — the rows have no further use once their files are gone,
 * and their absence is the signal the sweep uses to know that file cleanup
 * has succeeded for this upload.
 */
export const deleteParts = async (uploadId: string) => {
  await prisma.multipartPart.deleteMany({ where: { uploadId } });
};

/**
 * Uploads whose TTL has passed and that are still active (not yet completed
 * or aborted). The sweep marks them aborted and removes their staged dir.
 */
export const listExpired = async (limit: number) => {
  return await prisma.multipartUpload.findMany({
    where: {
      expiresAt: { lt: new Date() },
      completedAt: null,
      abortedAt: null,
    },
    include: {
      bucket: { select: { name: true, organizationId: true } },
    },
    take: limit,
    orderBy: { expiresAt: "asc" },
  });
};

/**
 * Uploads finalised long enough ago (aborted OR completed) and whose part
 * rows still exist (the signal that file cleanup hasn't completed). Used as a
 * backstop for `abortMultipart` and `completeMultipart` when their inline
 * `removeMultipartDir` failed (filesystem hiccup, partial process restart).
 *
 * After a successful sweep iteration the caller should delete the part rows
 * via `deleteParts` so subsequent ticks naturally skip this upload.
 */
export const listFinalisedNeedingCleanup = async (
  graceSeconds: number,
  limit: number
) => {
  const cutoff = new Date(Date.now() - graceSeconds * 1000);
  return await prisma.multipartUpload.findMany({
    where: {
      OR: [
        { abortedAt: { lt: cutoff, not: null } },
        { completedAt: { lt: cutoff, not: null } },
      ],
      parts: { some: {} },
    },
    take: limit,
    orderBy: { createdAt: "asc" },
  });
};

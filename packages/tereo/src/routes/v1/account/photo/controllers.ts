import { logAuditTx } from "../../../../utils/outbox.js";
import { validateUser } from "../../../../utils/auth.js";
import { logger } from "../../../../utils/logger.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  uploadUserPhoto,
  deleteUserPhoto,
  presignUserPhotoUrl,
  isAllowedMimeType,
  getMaxFileSizeBytes,
  getAllowedMimeTypes,
} from "../../../../utils/userPhotos.js";
import {
  BadRequestError,
  NotFoundError,
  PayloadTooLargeError,
} from "../../../../utils/errors.js";

export const uploadPhoto = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { userId } = auth;

  const file = req.file;
  if (!file) {
    throw new BadRequestError("file_upload_required", "No file was uploaded");
  }

  if (!isAllowedMimeType(file.mimetype)) {
    throw new BadRequestError(
      "invalid_file_type",
      `Invalid file type. Allowed types: ${getAllowedMimeTypes().join(", ")}`
    );
  }

  const maxSize = getMaxFileSizeBytes();
  if (file.size > maxSize) {
    throw new PayloadTooLargeError(
      `File too large. Maximum size: ${maxSize / 1024 / 1024}MB`
    );
  }

  // Replaces (and deletes) the previous photo in the same transaction.
  const photoObjectId = await uploadUserPhoto(
    userId,
    file.buffer,
    file.mimetype,
    async (tx, objectId) => {
      await tx.user.update({
        where: { id: userId },
        data: { photoObjectId: objectId },
      });
      await logAuditTx(tx, {
        auth,
        action: "UPDATE",
        entityType: "User",
        entityId: userId,
        entityName: auth.email,
        metadata: { action: "photo_changed", photoObjectId: objectId },
      });
    }
  );

  const photoUrl = await presignUserPhotoUrl(photoObjectId);

  logger.debug({ userId, photoObjectId }, "Profile photo uploaded");

  res.status(201).json({
    photoUrl,
    fileName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
  });
};

export const deletePhoto = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { userId } = auth;

  const photoObjectId = await db.users.getProfilePhotoId(userId);
  if (!photoObjectId) {
    throw new NotFoundError("No profile photo to delete");
  }

  await deleteUserPhoto(userId, photoObjectId, async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { photoObjectId: null },
    });
    await logAuditTx(tx, {
      auth,
      action: "UPDATE",
      entityType: "User",
      entityId: userId,
      entityName: auth.email,
      metadata: { action: "photo_removed", photoObjectId },
    });
  });
  logger.debug({ userId, photoObjectId }, "Profile photo deleted");
  res.status(204).send();
};

-- AlterTable
ALTER TABLE "files"."multipart_parts" ADD COLUMN     "aad_bound" BOOLEAN NOT NULL DEFAULT false;

-- A ref_count below zero means a release was counted twice; refuse it rather
-- than clamp it. None can exist while decRef clamped, but repair any first.
UPDATE "files"."content_blobs" SET "ref_count" = 0 WHERE "ref_count" < 0;
ALTER TABLE "files"."content_blobs"
  ADD CONSTRAINT "content_blobs_ref_count_nonnegative" CHECK ("ref_count" >= 0);

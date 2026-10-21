-- AlterTable
ALTER TABLE "files"."object_versions" ADD COLUMN     "noncurrent_since" TIMESTAMP(3);

-- An existing non-current version stopped being current when the next
-- version of its object was written (ids are UUIDv7, so time-ordered);
-- now() when that version is gone.
UPDATE "files"."object_versions" ov
SET "noncurrent_since" = COALESCE(
  (
    SELECT MIN(nv."created_at")
    FROM "files"."object_versions" nv
    WHERE nv."object_id" = ov."object_id"
      AND nv."id" > ov."id"
  ),
  CURRENT_TIMESTAMP
)
WHERE ov."is_current" = false;

-- Version expiry scans non-current live versions by when they stopped being current.
CREATE INDEX "object_versions_noncurrent_scan" ON "files"."object_versions" ("noncurrent_since") WHERE "deleted_at" IS NULL AND "is_current" = false;

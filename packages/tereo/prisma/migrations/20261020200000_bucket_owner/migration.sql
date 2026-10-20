-- AlterTable
ALTER TABLE "files"."buckets" ADD COLUMN "owner_id" UUID;

UPDATE "files"."buckets" SET "owner_id" = "created_by";

ALTER TABLE "files"."buckets" ALTER COLUMN "owner_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "buckets_owner_id_idx" ON "files"."buckets"("owner_id");

-- AddForeignKey
ALTER TABLE "files"."buckets" ADD CONSTRAINT "buckets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

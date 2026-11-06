-- AlterTable
ALTER TABLE "auth"."users" ADD COLUMN     "password_set_by_user" BOOLEAN NOT NULL DEFAULT true;

-- A grant from before has no cookie secret to check: its login starts over.
DELETE FROM "auth"."password_change_grants";

-- AlterTable
ALTER TABLE "auth"."password_change_grants" ADD COLUMN     "cookie_secret_hash" VARCHAR(64) NOT NULL;

-- CreateIndex
CREATE INDEX "password_setup_tokens_expires_at_idx" ON "auth"."password_setup_tokens"("expires_at");


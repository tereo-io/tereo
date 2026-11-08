-- CreateEnum
CREATE TYPE "auth"."user_link_purpose" AS ENUM ('setup', 'reset', 'verify');

-- AlterTable
ALTER TABLE "auth"."users" ADD COLUMN     "email_verified_at" TIMESTAMP(3);

-- Renamed rather than recreated so existing setup links survive.
ALTER TABLE "auth"."password_setup_tokens" RENAME TO "user_link_tokens";
ALTER TABLE "auth"."user_link_tokens" RENAME CONSTRAINT "password_setup_tokens_pkey" TO "user_link_tokens_pkey";
ALTER TABLE "auth"."user_link_tokens" RENAME CONSTRAINT "password_setup_tokens_user_id_fkey" TO "user_link_tokens_user_id_fkey";
ALTER TABLE "auth"."user_link_tokens" RENAME CONSTRAINT "password_setup_tokens_created_by_fkey" TO "user_link_tokens_created_by_fkey";
ALTER INDEX "auth"."password_setup_tokens_token_hash_key" RENAME TO "user_link_tokens_token_hash_key";
ALTER INDEX "auth"."password_setup_tokens_expires_at_idx" RENAME TO "user_link_tokens_expires_at_idx";

ALTER TABLE "auth"."user_link_tokens" ADD COLUMN "purpose" "auth"."user_link_purpose" NOT NULL DEFAULT 'setup';
ALTER TABLE "auth"."user_link_tokens" ALTER COLUMN "purpose" DROP DEFAULT;
ALTER TABLE "auth"."user_link_tokens" ADD COLUMN "email" VARCHAR(255);

ALTER TABLE "auth"."user_link_tokens" ADD CONSTRAINT "user_link_tokens_email_purpose_check" CHECK (("purpose" = 'verify') = ("email" IS NOT NULL));

DROP INDEX "auth"."password_setup_tokens_user_id_live_key";
CREATE UNIQUE INDEX "user_link_tokens_user_id_live_password_key" ON "auth"."user_link_tokens" ("user_id") WHERE "used_at" IS NULL AND "purpose" IN ('setup', 'reset');
CREATE UNIQUE INDEX "user_link_tokens_user_id_live_verify_key" ON "auth"."user_link_tokens" ("user_id") WHERE "used_at" IS NULL AND "purpose" = 'verify';

-- Accounts that exist already have been vouched for; only later signups verify.
UPDATE "auth"."users" SET "email_verified_at" = now() WHERE "user_type" IN ('human', 'guest');

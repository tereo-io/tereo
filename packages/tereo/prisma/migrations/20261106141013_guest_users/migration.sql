-- AlterEnum
ALTER TYPE "auth"."user_type" ADD VALUE 'guest';

-- AlterTable
ALTER TABLE "auth"."roles" ADD COLUMN     "guest_assignable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "auth"."users" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "password_change_required" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "auth"."password_setup_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "password_setup_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_setup_tokens_token_hash_key" ON "auth"."password_setup_tokens"("token_hash");

-- AddForeignKey
ALTER TABLE "auth"."password_setup_tokens" ADD CONSTRAINT "password_setup_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."password_setup_tokens" ADD CONSTRAINT "password_setup_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "auth"."users" ADD CONSTRAINT "users_guest_expiry_check" CHECK (("user_type" = 'guest') = ("expires_at" IS NOT NULL));

ALTER TABLE "auth"."roles" ADD CONSTRAINT "roles_guest_assignable_custom_check" CHECK (NOT "guest_assignable" OR "service_id" IS NULL);

CREATE UNIQUE INDEX "password_setup_tokens_user_id_live_key" ON "auth"."password_setup_tokens" ("user_id") WHERE "used_at" IS NULL;

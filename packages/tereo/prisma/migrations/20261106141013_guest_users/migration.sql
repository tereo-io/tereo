-- AlterEnum
ALTER TYPE "auth"."user_type" ADD VALUE 'guest';

-- AlterTable
ALTER TABLE "auth"."roles" ADD COLUMN     "guest_assignable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "auth"."users" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "password_change_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "password_set_by_user" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "notifications"."notifications" ADD COLUMN     "sensitive" BOOLEAN NOT NULL DEFAULT false;

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

-- CreateTable
CREATE TABLE "auth"."password_change_grants" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "cookie_secret_hash" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "redirect_uri" VARCHAR(2048) NOT NULL,
    "scopes" TEXT[],
    "state" VARCHAR(512),
    "code_challenge" VARCHAR(128) NOT NULL,
    "code_challenge_method" VARCHAR(10) NOT NULL,
    "nonce" VARCHAR(512),
    "max_age" INTEGER,
    "acr_values" VARCHAR(512),
    "prompt" VARCHAR(50),
    "first_factor" TEXT[] DEFAULT ARRAY['pwd']::TEXT[],
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_change_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_setup_tokens_token_hash_key" ON "auth"."password_setup_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_setup_tokens_expires_at_idx" ON "auth"."password_setup_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_change_grants_token_hash_key" ON "auth"."password_change_grants"("token_hash");

-- CreateIndex
CREATE INDEX "password_change_grants_user_id_idx" ON "auth"."password_change_grants"("user_id");

-- CreateIndex
CREATE INDEX "password_change_grants_expires_at_idx" ON "auth"."password_change_grants"("expires_at");

-- AddForeignKey
ALTER TABLE "auth"."password_setup_tokens" ADD CONSTRAINT "password_setup_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."password_setup_tokens" ADD CONSTRAINT "password_setup_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."password_change_grants" ADD CONSTRAINT "password_change_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."password_change_grants" ADD CONSTRAINT "password_change_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "auth"."users" ADD CONSTRAINT "users_guest_expiry_check" CHECK (("user_type" = 'guest') = ("expires_at" IS NOT NULL));

ALTER TABLE "auth"."roles" ADD CONSTRAINT "roles_guest_assignable_custom_check" CHECK (NOT "guest_assignable" OR "service_id" IS NULL);

CREATE UNIQUE INDEX "password_setup_tokens_user_id_live_key" ON "auth"."password_setup_tokens" ("user_id") WHERE "used_at" IS NULL;

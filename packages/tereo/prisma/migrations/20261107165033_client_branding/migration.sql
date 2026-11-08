-- CreateEnum
CREATE TYPE "auth"."branding_layout" AS ENUM ('centered', 'split');

-- CreateTable
CREATE TABLE "auth"."branding_profiles" (
    "id" UUID NOT NULL,
    "client_id" UUID,
    "app_name" VARCHAR(60),
    "headline" VARCHAR(80),
    "subtitle" VARCHAR(160),
    "sign_in_label" VARCHAR(30),
    "notice" VARCHAR(280),
    "layout" "auth"."branding_layout",
    "footer_links" JSONB,
    "colors_light" JSONB NOT NULL DEFAULT '{}',
    "colors_dark" JSONB NOT NULL DEFAULT '{}',
    "logo_object_id" UUID,
    "logo_dark_object_id" UUID,
    "favicon_object_id" UUID,
    "background_object_id" UUID,
    "apply_to_console" BOOLEAN NOT NULL DEFAULT false,
    "provisioned" BOOLEAN NOT NULL DEFAULT false,
    "provisioned_from" VARCHAR(255),
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branding_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."branding_grants" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "granted_by" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by" UUID,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "branding_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "branding_profiles_client_id_key" ON "auth"."branding_profiles"("client_id");

-- CreateIndex
CREATE INDEX "branding_profiles_logo_object_id_idx" ON "auth"."branding_profiles"("logo_object_id");

-- CreateIndex
CREATE INDEX "branding_profiles_logo_dark_object_id_idx" ON "auth"."branding_profiles"("logo_dark_object_id");

-- CreateIndex
CREATE INDEX "branding_profiles_favicon_object_id_idx" ON "auth"."branding_profiles"("favicon_object_id");

-- CreateIndex
CREATE INDEX "branding_profiles_background_object_id_idx" ON "auth"."branding_profiles"("background_object_id");

-- CreateIndex
CREATE INDEX "branding_grants_client_id_idx" ON "auth"."branding_grants"("client_id");

-- CreateIndex
CREATE INDEX "branding_grants_user_id_idx" ON "auth"."branding_grants"("user_id");

-- AddForeignKey
ALTER TABLE "auth"."branding_profiles" ADD CONSTRAINT "branding_profiles_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."branding_profiles" ADD CONSTRAINT "branding_profiles_logo_object_id_fkey" FOREIGN KEY ("logo_object_id") REFERENCES "files"."objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."branding_profiles" ADD CONSTRAINT "branding_profiles_logo_dark_object_id_fkey" FOREIGN KEY ("logo_dark_object_id") REFERENCES "files"."objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."branding_profiles" ADD CONSTRAINT "branding_profiles_favicon_object_id_fkey" FOREIGN KEY ("favicon_object_id") REFERENCES "files"."objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."branding_profiles" ADD CONSTRAINT "branding_profiles_background_object_id_fkey" FOREIGN KEY ("background_object_id") REFERENCES "files"."objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."branding_profiles" ADD CONSTRAINT "branding_profiles_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."branding_grants" ADD CONSTRAINT "branding_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."branding_grants" ADD CONSTRAINT "branding_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."branding_grants" ADD CONSTRAINT "branding_grants_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."branding_grants" ADD CONSTRAINT "branding_grants_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only one default profile (client_id NULL) may exist.
CREATE UNIQUE INDEX "branding_profiles_one_default" ON "auth"."branding_profiles" ((true)) WHERE "client_id" IS NULL;

ALTER TABLE "auth"."branding_profiles" ADD CONSTRAINT "branding_profiles_provisioned_from"
  CHECK ("provisioned" = ("provisioned_from" IS NOT NULL));

CREATE UNIQUE INDEX "branding_grants_one_active" ON "auth"."branding_grants" ("client_id", "user_id") WHERE "revoked_at" IS NULL;

-- AlterTable
ALTER TABLE "auth"."totp_verifications" ADD COLUMN     "pending_link_id" UUID;

-- CreateTable
CREATE TABLE "auth"."pending_identity_links" (
    "id" UUID NOT NULL,
    "link_grant_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_identity_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_identity_links_link_grant_id_idx" ON "auth"."pending_identity_links"("link_grant_id");

-- CreateIndex
CREATE INDEX "pending_identity_links_provider_id_idx" ON "auth"."pending_identity_links"("provider_id");

-- CreateIndex
CREATE INDEX "totp_verifications_pending_link_id_idx" ON "auth"."totp_verifications"("pending_link_id");

-- AddForeignKey
ALTER TABLE "auth"."totp_verifications" ADD CONSTRAINT "totp_verifications_pending_link_id_fkey" FOREIGN KEY ("pending_link_id") REFERENCES "auth"."pending_identity_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."pending_identity_links" ADD CONSTRAINT "pending_identity_links_link_grant_id_fkey" FOREIGN KEY ("link_grant_id") REFERENCES "auth"."identity_link_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."pending_identity_links" ADD CONSTRAINT "pending_identity_links_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "auth"."identity_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

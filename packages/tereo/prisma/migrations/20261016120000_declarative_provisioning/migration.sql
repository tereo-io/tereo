-- AlterTable
ALTER TABLE "auth"."roles" ADD COLUMN     "provisioned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unprovisioned_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "webhooks"."webhook_endpoints" ADD COLUMN     "owner_service_id" UUID,
ADD COLUMN     "provisioned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "provisioning_key" VARCHAR(300),
ALTER COLUMN "organization_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_provisioning_key_key" ON "webhooks"."webhook_endpoints"("provisioning_key");

-- CreateIndex
CREATE INDEX "webhook_endpoints_owner_service_id_idx" ON "webhooks"."webhook_endpoints"("owner_service_id");

-- AddForeignKey
ALTER TABLE "webhooks"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_owner_service_id_fkey" FOREIGN KEY ("owner_service_id") REFERENCES "core"."services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A webhook endpoint belongs to an organization or to a service.
ALTER TABLE "webhooks"."webhook_endpoints"
  ADD CONSTRAINT "webhook_endpoints_org_or_owner"
  CHECK ("organization_id" IS NOT NULL OR "owner_service_id" IS NOT NULL);

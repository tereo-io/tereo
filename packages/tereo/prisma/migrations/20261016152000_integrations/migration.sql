-- CreateEnum
CREATE TYPE "core"."service_kind" AS ENUM ('service', 'integration');

-- AlterTable
ALTER TABLE "core"."services" ADD COLUMN     "kind" "core"."service_kind" NOT NULL DEFAULT 'service',
ADD COLUMN     "organization_id" UUID,
ALTER COLUMN "namespace" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "services_organization_id_idx" ON "core"."services"("organization_id");

-- AddForeignKey
ALTER TABLE "core"."services" ADD CONSTRAINT "services_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A service names its items under its namespace; an integration has none.
ALTER TABLE "core"."services" ADD CONSTRAINT "services_namespace_kind_check" CHECK ("kind" <> 'service' OR "namespace" IS NOT NULL);

-- Only an integration is bound to an organization.
ALTER TABLE "core"."services" ADD CONSTRAINT "services_organization_kind_check" CHECK ("kind" = 'integration' OR "organization_id" IS NULL);

-- CreateEnum
CREATE TYPE "core"."service_kind" AS ENUM ('service', 'integration');

-- AlterTable
ALTER TABLE "core"."services" ADD COLUMN     "internal_host" VARCHAR(253),
ADD COLUMN     "kind" "core"."service_kind" NOT NULL DEFAULT 'service',
ADD COLUMN     "organization_id" UUID,
ALTER COLUMN "namespace" DROP NOT NULL;

-- AlterTable
ALTER TABLE "auth"."oauth_clients" ADD COLUMN     "trusted_core_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "services_organization_id_idx" ON "core"."services"("organization_id");

-- AddForeignKey
ALTER TABLE "core"."services" ADD CONSTRAINT "services_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A service has a namespace for its items; an integration has none.
ALTER TABLE "core"."services" ADD CONSTRAINT "services_namespace_kind_check" CHECK (("kind" = 'service') = ("namespace" IS NOT NULL));

-- Only an integration is bound to an organization.
ALTER TABLE "core"."services" ADD CONSTRAINT "services_organization_kind_check" CHECK ("kind" = 'integration' OR "organization_id" IS NULL);

-- AlterTable
ALTER TABLE "core"."services" DROP COLUMN "provisioned_access";

-- Requests left from registration; provisioning approves what it lists.
DELETE FROM "core"."service_access" WHERE "status" = 'pending';

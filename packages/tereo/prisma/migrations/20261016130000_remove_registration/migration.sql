-- AlterTable
ALTER TABLE "core"."services" DROP COLUMN "provisioned_access";

-- Requests left from registration that nobody decided; provisioning
-- approves what it lists.
DELETE FROM "core"."service_access"
WHERE "status" = 'pending' AND "decided_at" IS NULL;

-- Approved access a role's growth reopened kept its role assignment, which
-- deleting the row would cascade to; it is approved again, and the next
-- provisioning apply brings it up to what the role grants.
UPDATE "core"."service_access" SET "status" = 'approved'
WHERE "status" = 'pending';

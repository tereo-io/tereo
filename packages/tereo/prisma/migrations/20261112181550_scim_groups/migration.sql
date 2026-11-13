-- CreateEnum
CREATE TYPE "auth"."scim_groups_target" AS ENUM ('none', 'global', 'organization');

-- CreateEnum
CREATE TYPE "auth"."scim_group_skip_reason" AS ENUM ('not_org_member');

-- AlterEnum
ALTER TYPE "auth"."group_definition_source" ADD VALUE 'scim';

-- AlterEnum
ALTER TYPE "auth"."group_membership_source" ADD VALUE 'scim';

-- AlterTable
ALTER TABLE "auth"."scim_connections" ADD COLUMN     "groups_organization_id" UUID,
ADD COLUMN     "groups_target" "auth"."scim_groups_target" NOT NULL DEFAULT 'none';

-- CreateTable
CREATE TABLE "auth"."scim_groups" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "external_id" VARCHAR(255),
    "display_name" VARCHAR(255) NOT NULL,
    "display_name_key" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."scim_group_skipped_members" (
    "id" UUID NOT NULL,
    "scim_group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" "auth"."scim_group_skip_reason" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scim_group_skipped_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scim_groups_group_id_key" ON "auth"."scim_groups"("group_id");

-- CreateIndex
CREATE INDEX "scim_groups_connection_id_display_name_key_idx" ON "auth"."scim_groups"("connection_id", "display_name_key");

-- CreateIndex
CREATE INDEX "scim_groups_connection_id_external_id_idx" ON "auth"."scim_groups"("connection_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "scim_group_skipped_members_scim_group_id_user_id_key" ON "auth"."scim_group_skipped_members"("scim_group_id", "user_id");

-- AddForeignKey
ALTER TABLE "auth"."scim_connections" ADD CONSTRAINT "scim_connections_groups_organization_id_fkey" FOREIGN KEY ("groups_organization_id") REFERENCES "auth"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."scim_groups" ADD CONSTRAINT "scim_groups_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "auth"."scim_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."scim_groups" ADD CONSTRAINT "scim_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "auth"."groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."scim_group_skipped_members" ADD CONSTRAINT "scim_group_skipped_members_scim_group_id_fkey" FOREIGN KEY ("scim_group_id") REFERENCES "auth"."scim_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."scim_group_skipped_members" ADD CONSTRAINT "scim_group_skipped_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "auth"."scim_connections"
  ADD CONSTRAINT "scim_connections_groups_target_org"
  CHECK (("groups_target" = 'organization') = ("groups_organization_id" IS NOT NULL));

-- CreateEnum
CREATE TYPE "auth"."group_definition_source" AS ENUM ('local', 'provisioned');

-- CreateEnum
CREATE TYPE "auth"."group_membership_source" AS ENUM ('local');

-- CreateTable
CREATE TABLE "auth"."groups" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "slug" VARCHAR(100) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" VARCHAR(500),
    "definition_source" "auth"."group_definition_source" NOT NULL,
    "membership_source" "auth"."group_membership_source" NOT NULL DEFAULT 'local',
    "unprovisioned_at" TIMESTAMP(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."group_members" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."group_roles" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "added_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "groups_organization_id_idx" ON "auth"."groups"("organization_id");

-- CreateIndex
CREATE INDEX "groups_archived_at_idx" ON "auth"."groups"("archived_at");

-- CreateIndex
CREATE INDEX "group_members_user_id_idx" ON "auth"."group_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_members_group_id_user_id_key" ON "auth"."group_members"("group_id", "user_id");

-- CreateIndex
CREATE INDEX "group_members_group_id_id_idx" ON "auth"."group_members"("group_id", "id");

-- CreateIndex
CREATE INDEX "group_roles_role_id_idx" ON "auth"."group_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_roles_group_id_role_id_key" ON "auth"."group_roles"("group_id", "role_id");

-- AddForeignKey
ALTER TABLE "auth"."groups" ADD CONSTRAINT "groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."groups" ADD CONSTRAINT "groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "auth"."groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."group_members" ADD CONSTRAINT "group_members_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."group_roles" ADD CONSTRAINT "group_roles_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "auth"."groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."group_roles" ADD CONSTRAINT "group_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "auth"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."group_roles" ADD CONSTRAINT "group_roles_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Slug uniqueness per scope. An archived group keeps its slug.
CREATE UNIQUE INDEX "groups_org_slug_key" ON "auth"."groups" ("organization_id", "slug") WHERE "organization_id" IS NOT NULL;
CREATE UNIQUE INDEX "groups_global_slug_key" ON "auth"."groups" ("slug") WHERE "organization_id" IS NULL;

-- The slug format and provisioning state the admin API and provisioning
-- enforce, held by the database too.
ALTER TABLE "auth"."groups" ADD CONSTRAINT "groups_slug_format"
  CHECK ("slug" ~ '^[a-z0-9-]{1,100}$');
ALTER TABLE "auth"."groups" ADD CONSTRAINT "groups_unprovisioned_provisioned"
  CHECK ("unprovisioned_at" IS NULL OR "definition_source" = 'provisioned');

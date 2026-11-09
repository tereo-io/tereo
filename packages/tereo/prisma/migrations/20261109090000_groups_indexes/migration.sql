-- CreateIndex
CREATE INDEX "group_members_group_id_id_idx" ON "auth"."group_members"("group_id", "id");

-- The slug format and provisioning state the admin API and provisioning
-- enforce, held by the database too.
ALTER TABLE "auth"."groups" ADD CONSTRAINT "groups_slug_format"
  CHECK ("slug" ~ '^[a-z0-9-]{1,100}$');
ALTER TABLE "auth"."groups" ADD CONSTRAINT "groups_unprovisioned_provisioned"
  CHECK ("unprovisioned_at" IS NULL OR "definition_source" = 'provisioned');

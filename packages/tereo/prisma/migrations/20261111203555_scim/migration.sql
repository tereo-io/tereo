-- CreateTable
CREATE TABLE "auth"."scim_connections" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."scim_tokens" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "scim_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."scim_users" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "external_id" VARCHAR(255),
    "user_name" VARCHAR(255) NOT NULL,
    "idp_active" BOOLEAN NOT NULL,
    "admin_hold" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scim_connections_provider_id_key" ON "auth"."scim_connections"("provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "scim_tokens_hash_key" ON "auth"."scim_tokens"("hash");

-- CreateIndex
CREATE INDEX "scim_tokens_connection_id_idx" ON "auth"."scim_tokens"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "scim_users_user_id_key" ON "auth"."scim_users"("user_id");

-- CreateIndex
CREATE INDEX "scim_users_connection_id_idx" ON "auth"."scim_users"("connection_id");

-- AddForeignKey
ALTER TABLE "auth"."scim_connections" ADD CONSTRAINT "scim_connections_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "auth"."identity_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."scim_connections" ADD CONSTRAINT "scim_connections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."scim_tokens" ADD CONSTRAINT "scim_tokens_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "auth"."scim_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."scim_tokens" ADD CONSTRAINT "scim_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."scim_users" ADD CONSTRAINT "scim_users_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "auth"."scim_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."scim_users" ADD CONSTRAINT "scim_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "scim_users_connection_external_id_key"
  ON "auth"."scim_users" ("connection_id", "external_id") WHERE "external_id" IS NOT NULL;
CREATE UNIQUE INDEX "scim_users_connection_user_name_key"
  ON "auth"."scim_users" ("connection_id", lower("user_name"));

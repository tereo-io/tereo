-- AlterTable
ALTER TABLE "auth"."oauth_clients" ADD COLUMN     "provisioned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unprovisioned_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "core"."services" ADD COLUMN     "provisioned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "provisioned_access" JSONB NOT NULL DEFAULT '{"roles":[],"audiences":[]}',
ADD COLUMN     "unprovisioned_at" TIMESTAMP(3);

-- No two clients share a secret: a client authenticates by it alone.
CREATE UNIQUE INDEX "oauth_clients_client_secret_key" ON "auth"."oauth_clients" ("client_secret") WHERE "client_secret" IS NOT NULL;

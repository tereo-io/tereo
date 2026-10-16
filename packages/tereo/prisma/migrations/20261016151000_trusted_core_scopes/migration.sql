-- AlterTable
ALTER TABLE "auth"."oauth_clients" ADD COLUMN     "trusted_core_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "auth"."oauth_clients" ADD COLUMN     "retired_secret_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[];

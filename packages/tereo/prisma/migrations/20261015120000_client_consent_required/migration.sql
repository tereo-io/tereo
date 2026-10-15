-- AlterTable
ALTER TABLE "auth"."oauth_clients" ADD COLUMN     "consent_required" BOOLEAN NOT NULL DEFAULT true;

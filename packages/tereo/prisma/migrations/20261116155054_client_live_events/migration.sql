-- AlterTable
ALTER TABLE "auth"."oauth_clients" ADD COLUMN     "live_events" BOOLEAN NOT NULL DEFAULT false;

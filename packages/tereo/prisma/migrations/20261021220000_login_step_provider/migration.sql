-- AlterTable
ALTER TABLE "auth"."consent_sessions" ADD COLUMN     "provider" VARCHAR(50);

-- AlterTable
ALTER TABLE "auth"."org_selection_sessions" ADD COLUMN     "provider" VARCHAR(50);

-- AlterTable
ALTER TABLE "auth"."totp_verifications" ADD COLUMN     "provider" VARCHAR(50);

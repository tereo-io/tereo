-- DropIndex
DROP INDEX "auth"."refresh_tokens_token_prefix_idx";

-- AlterTable
ALTER TABLE "auth"."refresh_tokens" DROP COLUMN "token_prefix";

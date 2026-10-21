-- AlterTable
ALTER TABLE "auth"."user_sessions" ADD COLUMN     "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "user_sessions_last_used_at_idx" ON "auth"."user_sessions"("last_used_at");

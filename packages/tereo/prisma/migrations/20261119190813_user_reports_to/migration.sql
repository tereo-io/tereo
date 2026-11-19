-- AlterTable
ALTER TABLE "auth"."users" ADD COLUMN     "reports_to_id" UUID;

-- CreateIndex
CREATE INDEX "users_reports_to_id_idx" ON "auth"."users"("reports_to_id");

-- AddForeignKey
ALTER TABLE "auth"."users" ADD CONSTRAINT "users_reports_to_id_fkey" FOREIGN KEY ("reports_to_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A user cannot report to themselves.
ALTER TABLE "auth"."users" ADD CONSTRAINT users_reports_to_not_self CHECK (reports_to_id IS NULL OR reports_to_id <> id);

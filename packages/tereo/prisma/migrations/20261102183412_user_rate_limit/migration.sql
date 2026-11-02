-- AlterTable
ALTER TABLE "auth"."users" ADD COLUMN     "rate_limit_per_second" INTEGER;

ALTER TABLE "auth"."users" ADD CONSTRAINT "users_rate_limit_per_second_check" CHECK ("rate_limit_per_second" BETWEEN 1 AND 100000);

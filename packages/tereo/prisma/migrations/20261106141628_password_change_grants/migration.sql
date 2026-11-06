-- CreateTable
CREATE TABLE "auth"."password_change_grants" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "redirect_uri" VARCHAR(2048) NOT NULL,
    "scopes" TEXT[],
    "state" VARCHAR(512),
    "code_challenge" VARCHAR(128) NOT NULL,
    "code_challenge_method" VARCHAR(10) NOT NULL,
    "nonce" VARCHAR(512),
    "max_age" INTEGER,
    "acr_values" VARCHAR(512),
    "prompt" VARCHAR(50),
    "first_factor" TEXT[] DEFAULT ARRAY['pwd']::TEXT[],
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_change_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_change_grants_token_hash_key" ON "auth"."password_change_grants"("token_hash");

-- CreateIndex
CREATE INDEX "password_change_grants_user_id_idx" ON "auth"."password_change_grants"("user_id");

-- CreateIndex
CREATE INDEX "password_change_grants_expires_at_idx" ON "auth"."password_change_grants"("expires_at");

-- AddForeignKey
ALTER TABLE "auth"."password_change_grants" ADD CONSTRAINT "password_change_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."password_change_grants" ADD CONSTRAINT "password_change_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

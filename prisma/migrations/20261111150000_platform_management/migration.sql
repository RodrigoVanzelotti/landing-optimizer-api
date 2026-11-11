ALTER TABLE "tenant" ADD COLUMN "archived_at" TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "password_reset" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "password_reset_token_hash_key" ON "password_reset"("token_hash");
CREATE INDEX "password_reset_user_id_idx" ON "password_reset"("user_id");

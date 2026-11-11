CREATE TABLE "team_invitation" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" "Role" NOT NULL,
  "token_hash" TEXT NOT NULL,
  "invited_by_user_id" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "team_invitation_role" CHECK ("role" IN ('admin', 'editor', 'viewer'))
);
CREATE UNIQUE INDEX "team_invitation_token_hash_key" ON "team_invitation"("token_hash");
CREATE INDEX "team_invitation_tenant_id_expires_at_idx" ON "team_invitation"("tenant_id", "expires_at");
-- Existing tenant owners retain administrator access under the three-role model.
UPDATE "user_membership" SET "role" = 'admin' WHERE "role" = 'owner';

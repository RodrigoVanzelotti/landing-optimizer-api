ALTER TABLE "ai_suggestion"
  ADD COLUMN "rejected_at" TIMESTAMP(3),
  ADD COLUMN "rejected_by_user_id" TEXT;

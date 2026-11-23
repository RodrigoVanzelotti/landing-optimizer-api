ALTER TYPE "ExperimentStatus" ADD VALUE IF NOT EXISTS 'accepted';
ALTER TABLE "experiment" ADD COLUMN "evaluation_plan" JSONB;
ALTER TABLE "experiment" ADD COLUMN "result_snapshot" JSONB;

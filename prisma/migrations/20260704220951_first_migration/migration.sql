-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('free', 'pro', 'enterprise');

-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('active', 'paused');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "GoalKind" AS ENUM ('event', 'url', 'form_submit');

-- CreateEnum
CREATE TYPE "ExperimentType" AS ENUM ('copy', 'cta', 'headline', 'subheadline', 'button_style', 'section_order', 'section_visibility', 'layout_class');

-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('draft', 'ai_suggested', 'pending_review', 'approved', 'scheduled', 'running', 'paused', 'completed', 'rejected', 'rolled_back');

-- CreateEnum
CREATE TYPE "ChangeOp" AS ENUM ('set_text', 'set_html_safe', 'set_attr', 'add_class', 'remove_class', 'hide', 'show', 'reorder');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "SuggestionKind" AS ENUM ('hypothesis', 'headline', 'cta', 'friction', 'section', 'score', 'plan');

-- CreateTable
CREATE TABLE "tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'free',
    "data_region" TEXT NOT NULL DEFAULT 'us',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_membership" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'viewer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hashed_key" TEXT NOT NULL,
    "scopes" TEXT[],
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primary_domain" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "private_key_enc" BYTEA NOT NULL,
    "ingest_key" TEXT NOT NULL,
    "sampling_rate" DECIMAL(4,3) NOT NULL DEFAULT 1.0,
    "status" "SiteStatus" NOT NULL DEFAULT 'active',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "config_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_origin" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_origin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversion_goal" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "GoalKind" NOT NULL DEFAULT 'event',
    "matcher" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversion_goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hypothesis" TEXT,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'draft',
    "type" "ExperimentType" NOT NULL,
    "targeting" JSONB NOT NULL DEFAULT '{}',
    "allocation" DECIMAL(4,3) NOT NULL DEFAULT 0.5,
    "primary_goal_id" TEXT,
    "risk_score" INTEGER NOT NULL DEFAULT 0,
    "winner_variant_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant" (
    "id" TEXT NOT NULL,
    "experiment_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_control" BOOLEAN NOT NULL DEFAULT false,
    "weight" DECIMAL(4,3) NOT NULL DEFAULT 0.5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_change" (
    "id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "selector" TEXT NOT NULL,
    "op" "ChangeOp" NOT NULL,
    "original_value" TEXT,
    "proposed_value" TEXT,
    "attr_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" TEXT NOT NULL,
    "experiment_id" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "risk_score" INTEGER NOT NULL DEFAULT 0,
    "checklist" JSONB NOT NULL DEFAULT '{}',
    "screenshot_url" TEXT,
    "approver_user_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_suggestion" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "kind" "SuggestionKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "expected_impact" TEXT,
    "risk_level" "RiskLevel" NOT NULL DEFAULT 'low',
    "experiment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_guardrail" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "rules" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_guardrail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_map" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "url_path" TEXT NOT NULL,
    "map" JSONB NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_map_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_membership_user_id_idx" ON "user_membership"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_membership_tenant_id_user_id_key" ON "user_membership"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "api_key_tenant_id_idx" ON "api_key"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_ingest_key_key" ON "site"("ingest_key");

-- CreateIndex
CREATE INDEX "site_tenant_id_idx" ON "site"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_origin_site_id_origin_key" ON "site_origin"("site_id", "origin");

-- CreateIndex
CREATE UNIQUE INDEX "conversion_goal_site_id_name_key" ON "conversion_goal"("site_id", "name");

-- CreateIndex
CREATE INDEX "experiment_tenant_id_idx" ON "experiment"("tenant_id");

-- CreateIndex
CREATE INDEX "experiment_site_id_status_idx" ON "experiment"("site_id", "status");

-- CreateIndex
CREATE INDEX "variant_experiment_id_idx" ON "variant"("experiment_id");

-- CreateIndex
CREATE INDEX "variant_change_variant_id_idx" ON "variant_change"("variant_id");

-- CreateIndex
CREATE INDEX "approval_experiment_id_idx" ON "approval"("experiment_id");

-- CreateIndex
CREATE INDEX "approval_status_idx" ON "approval"("status");

-- CreateIndex
CREATE INDEX "ai_suggestion_site_id_idx" ON "ai_suggestion"("site_id");

-- CreateIndex
CREATE UNIQUE INDEX "brand_guardrail_site_id_key" ON "brand_guardrail"("site_id");

-- CreateIndex
CREATE INDEX "page_map_site_id_url_path_idx" ON "page_map"("site_id", "url_path");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_created_at_idx" ON "audit_log"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "user_membership" ADD CONSTRAINT "user_membership_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_membership" ADD CONSTRAINT "user_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site" ADD CONSTRAINT "site_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_origin" ADD CONSTRAINT "site_origin_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversion_goal" ADD CONSTRAINT "conversion_goal_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment" ADD CONSTRAINT "experiment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment" ADD CONSTRAINT "experiment_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment" ADD CONSTRAINT "experiment_primary_goal_id_fkey" FOREIGN KEY ("primary_goal_id") REFERENCES "conversion_goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant" ADD CONSTRAINT "variant_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_change" ADD CONSTRAINT "variant_change_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestion" ADD CONSTRAINT "ai_suggestion_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestion" ADD CONSTRAINT "ai_suggestion_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_guardrail" ADD CONSTRAINT "brand_guardrail_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_map" ADD CONSTRAINT "page_map_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Behavior heatmap support: page snapshots + one page map per (site, path).

-- page_map gains a uniqueness guarantee so ingestion can upsert the latest
-- structural map per path. Duplicate rows (if any) must be resolved first:
-- keep the most recent capture per (site_id, url_path).
DELETE FROM "page_map" a
USING "page_map" b
WHERE a."site_id" = b."site_id"
  AND a."url_path" = b."url_path"
  AND (a."captured_at" < b."captured_at"
       OR (a."captured_at" = b."captured_at" AND a."id" < b."id"));

-- DropIndex
DROP INDEX "page_map_site_id_url_path_idx";

-- CreateIndex
CREATE UNIQUE INDEX "page_map_site_id_url_path_key" ON "page_map"("site_id", "url_path");

-- CreateTable
CREATE TABLE "page_snapshot" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "url_path" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "content_type" TEXT NOT NULL,
    "image" BYTEA NOT NULL,
    "nodes" JSONB NOT NULL DEFAULT '[]',
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "page_snapshot_site_id_url_path_captured_at_idx" ON "page_snapshot"("site_id", "url_path", "captured_at");

-- AddForeignKey
ALTER TABLE "page_snapshot" ADD CONSTRAINT "page_snapshot_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

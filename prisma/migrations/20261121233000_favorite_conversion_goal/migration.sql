BEGIN;
ALTER TABLE conversion_goal ADD COLUMN is_favorite BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX conversion_goal_one_favorite_per_site
  ON conversion_goal(site_id) WHERE is_favorite = TRUE;
COMMIT;

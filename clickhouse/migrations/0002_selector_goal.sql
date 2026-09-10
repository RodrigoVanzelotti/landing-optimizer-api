-- 0002_selector_goal.sql — element-anchored analytics columns.
-- The SDK has always sent `sel` (sanitized CSS selector) and `goal` on the
-- wire; until now they were validated and then discarded. The behavior
-- heatmap (clicks / hover / frustration per element) needs them stored.
-- `hover` is a new aggregate event: dwell_ms holds accumulated attention time
-- for the element in `selector`.

ALTER TABLE events ADD COLUMN IF NOT EXISTS selector String DEFAULT '' AFTER section_id;

ALTER TABLE events ADD COLUMN IF NOT EXISTS goal LowCardinality(String) DEFAULT '' AFTER selector;

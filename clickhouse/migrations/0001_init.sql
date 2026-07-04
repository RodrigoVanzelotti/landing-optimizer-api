-- 0001_init.sql — Landing Optimizer analytics schema (ClickHouse)
-- Applied by src/modules/analytics/clickhouse/migrate.ts (idempotent).

CREATE TABLE IF NOT EXISTS events
(
  event_date        Date DEFAULT toDate(event_time),
  event_time        DateTime64(3) DEFAULT now64(3),
  tenant_id         UUID,
  site_id           UUID,
  session_id        String,
  event_name        LowCardinality(String),
  page_path         String,
  referrer_host     LowCardinality(String),
  device_category   LowCardinality(String),
  browser_category  LowCardinality(String),
  country           LowCardinality(String),
  is_bot            UInt8 DEFAULT 0,
  experiment_id     UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  variant_id        UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  section_id        LowCardinality(String) DEFAULT '',
  scroll_depth      UInt8 DEFAULT 0,
  dwell_ms          UInt32 DEFAULT 0,
  value             Float64 DEFAULT 0,
  props             String DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY (toYYYYMMDD(event_time), tenant_id)
ORDER BY (tenant_id, site_id, event_name, event_time)
TTL event_date + INTERVAL 180 DAY;

-- Experiment statistics rollup (exposures + conversions per variant/day).
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_experiment_stats
ENGINE = SummingMergeTree
PARTITION BY event_date
ORDER BY (tenant_id, site_id, experiment_id, variant_id, event_date)
AS
SELECT
  event_date,
  tenant_id,
  site_id,
  experiment_id,
  variant_id,
  countIf(event_name = 'exposure')          AS exposures,
  countIf(event_name = 'conversion')        AS conversions,
  sumIf(value, event_name = 'conversion')   AS conversion_value
FROM events
WHERE experiment_id != toUUID('00000000-0000-0000-0000-000000000000')
GROUP BY event_date, tenant_id, site_id, experiment_id, variant_id;

-- Daily funnel rollup (counts per event name).
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_funnel
ENGINE = SummingMergeTree
PARTITION BY event_date
ORDER BY (tenant_id, site_id, event_name, event_date)
AS
SELECT
  event_date,
  tenant_id,
  site_id,
  event_name,
  count() AS events
FROM events
GROUP BY event_date, tenant_id, site_id, event_name;

-- Section performance rollup (visibility, dwell, dead/rage clicks per section).
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_section_performance
ENGINE = SummingMergeTree
PARTITION BY event_date
ORDER BY (tenant_id, site_id, section_id, event_date)
AS
SELECT
  event_date,
  tenant_id,
  site_id,
  section_id,
  countIf(event_name = 'section_view') AS views,
  countIf(event_name = 'dead_click')   AS dead_clicks,
  countIf(event_name = 'rage_click')   AS rage_clicks,
  sum(dwell_ms)                        AS dwell_ms_total
FROM events
WHERE section_id != ''
GROUP BY event_date, tenant_id, site_id, section_id;

-- shortcut: event retention is manual for V1; schedule cleanup before expanding traffic.
CREATE TABLE events (
  event_time timestamp(3) NOT NULL,
  tenant_id text NOT NULL REFERENCES tenant(id),
  site_id text NOT NULL REFERENCES site(id),
  session_id text NOT NULL,
  event_name text NOT NULL,
  page_path text NOT NULL,
  referrer_host text NOT NULL,
  device_category text NOT NULL,
  browser_category text NOT NULL,
  country text NOT NULL,
  is_bot integer NOT NULL,
  experiment_id text NOT NULL,
  variant_id text NOT NULL,
  section_id text NOT NULL,
  selector text NOT NULL,
  goal text NOT NULL,
  scroll_depth integer NOT NULL,
  dwell_ms integer NOT NULL,
  value double precision NOT NULL,
  props text NOT NULL
);
CREATE INDEX events_site_time ON events (tenant_id, site_id, event_time);
CREATE INDEX events_experiment ON events (tenant_id, experiment_id, variant_id);
CREATE VIEW mv_section_performance AS
SELECT tenant_id, site_id, section_id,
  count(*) FILTER (WHERE event_name = 'section_view') AS views,
  count(*) FILTER (WHERE event_name = 'dead_click') AS dead_clicks,
  count(*) FILTER (WHERE event_name = 'rage_click') AS rage_clicks,
  sum(dwell_ms) AS dwell_ms_total
FROM events WHERE section_id <> '' GROUP BY tenant_id, site_id, section_id;
CREATE VIEW mv_experiment_stats AS
SELECT tenant_id, site_id, experiment_id, variant_id,
  count(*) FILTER (WHERE event_name = 'exposure') AS exposures,
  count(*) FILTER (WHERE event_name = 'conversion') AS conversions
FROM events GROUP BY tenant_id, site_id, experiment_id, variant_id;
CREATE TABLE rate_limit (key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX rate_limit_expiry ON rate_limit (expires_at);

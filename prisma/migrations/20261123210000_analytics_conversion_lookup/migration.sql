-- Attribution joins look up conversions by session; avoid rescanning a site's history per exposure.
CREATE INDEX events_conversion_session
ON events (tenant_id, site_id, session_id, event_time)
WHERE event_name = 'conversion' AND is_bot = 0;

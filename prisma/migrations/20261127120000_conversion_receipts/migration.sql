CREATE TABLE conversion_receipt (
  site_id text NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  goal text NOT NULL,
  fingerprint text NOT NULL,
  PRIMARY KEY (site_id, goal, fingerprint)
);

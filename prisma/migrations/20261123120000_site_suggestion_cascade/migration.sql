-- Enforce new writes and cascades without deleting unrelated historical orphan records.
ALTER TABLE ai_suggestion ADD CONSTRAINT ai_suggestion_site_id_fkey
  FOREIGN KEY (site_id) REFERENCES site(id) ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

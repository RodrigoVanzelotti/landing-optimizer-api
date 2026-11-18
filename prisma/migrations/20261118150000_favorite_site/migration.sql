ALTER TABLE user_membership
  ADD COLUMN favorite_site_id text REFERENCES site(id) ON DELETE SET NULL;

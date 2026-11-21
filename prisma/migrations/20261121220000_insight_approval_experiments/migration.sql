BEGIN;

-- Stop instead of losing ambiguous or cross-workspace legacy associations.
DO $$
BEGIN
  IF EXISTS (
    SELECT experiment_id FROM ai_suggestion WHERE experiment_id IS NOT NULL
    GROUP BY experiment_id HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM ai_suggestion s JOIN experiment e ON e.id = s.experiment_id
    WHERE e.tenant_id <> s.tenant_id OR e.site_id <> s.site_id
  ) THEN
    RAISE EXCEPTION 'Review inconsistent legacy insight/experiment associations before migrating';
  END IF;
END $$;

ALTER TABLE ai_suggestion
  ADD COLUMN approved_at timestamp(3),
  ADD COLUMN approved_by_user_id text,
  ADD COLUMN experiments_ready_at timestamp(3);
ALTER TABLE experiment ADD COLUMN insight_id text;
UPDATE experiment e SET insight_id = s.id FROM ai_suggestion s WHERE s.experiment_id = e.id;
ALTER TABLE experiment ADD CONSTRAINT experiment_insight_id_fkey
  FOREIGN KEY (insight_id) REFERENCES ai_suggestion(id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX experiment_insight_id_idx ON experiment(insight_id);
ALTER TABLE ai_suggestion DROP CONSTRAINT ai_suggestion_experiment_id_fkey;
ALTER TABLE ai_suggestion DROP COLUMN experiment_id;

-- Existing links are preserved; earlier creation is not recorded as an approval.
COMMIT;

-- Replayed provider removals must not clear a newer authorization. Existing grants
-- retain every value and use created_at as their conservative legacy boundary;
-- new OAuth completions record their authorization time explicitly.
ALTER TABLE conference_connections ADD COLUMN authorized_at timestamptz;

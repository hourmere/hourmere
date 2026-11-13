-- Audit log retention chosen by an organization's owner (docs/audit-log.md, Retention).
-- No row: the organization follows the instance default (AUDIT_LOG_RETENTION_DAYS). A row
-- keeps events forever or for 30 to 3650 days. The purge job reads this table; it never
-- deletes events younger than 30 days. Deleting the organization removes its choice, so any
-- events left behind follow the instance default. audit_events itself is unchanged.
CREATE TABLE audit_log_settings (
  organization_id uuid PRIMARY KEY REFERENCES auth.organization (id) ON DELETE CASCADE,
  retention text NOT NULL,
  retention_days integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_settings_retention CHECK (
    (retention = 'forever' AND retention_days IS NULL) OR
    (retention = 'days' AND retention_days BETWEEN 30 AND 3650)
  )
);

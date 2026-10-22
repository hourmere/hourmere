CREATE TABLE waitlist (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT,
  locale TEXT,
  consent_text_version TEXT NOT NULL
);

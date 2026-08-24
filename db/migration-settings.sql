-- Simple key-value store for editable property settings — starting with terms & conditions,
-- which used to be hardcoded text in services/pdf-letterhead.js and required a code deploy
-- to change. Generic enough to hold future editable settings without a new table each time.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

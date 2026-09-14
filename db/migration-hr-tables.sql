-- HR: staff directory. Deliberately separate from `users` (system logins) — most staff
-- never need a PMS account at all. linked_user_id is optional, for the few who do.
CREATE TABLE employees (
  id              SERIAL PRIMARY KEY,
  full_name       TEXT NOT NULL,
  position        TEXT,
  phone           TEXT,
  email           TEXT,
  start_date      DATE,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  linked_user_id  INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HR: leave requests, recorded and actioned by a manager.
CREATE TABLE leave_requests (
  id            SERIAL PRIMARY KEY,
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  leave_type    TEXT NOT NULL CHECK (leave_type IN ('annual', 'sick', 'unpaid', 'other')),
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL CHECK (end_date >= start_date),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  notes         TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ
);
CREATE INDEX idx_leave_requests_employee ON leave_requests(employee_id, start_date);

-- HR: reusable letter templates.
CREATE TABLE letter_templates (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

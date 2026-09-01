-- Subla Camp PMS — Phase 1 schema
-- Covers: room inventory, guests, reservations, check-in/out, folio (billing)
-- Run against a fresh PostgreSQL database (matches the Render Postgres setup used for Subla Tea).

CREATE TABLE room_types (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,              -- e.g. 'Deluxe Tent', 'Standard Room'
  base_rate     NUMERIC(10,2) NOT NULL,
  max_adults    INTEGER NOT NULL DEFAULT 2,
  max_children  INTEGER NOT NULL DEFAULT 0,
  channex_room_type_id TEXT,                -- Channex's UUID for this room type, once mapped
  channex_rate_plan_id TEXT                 -- Channex's UUID for the rate plan tied to it
);

CREATE TABLE rooms (
  id            SERIAL PRIMARY KEY,
  room_number   TEXT NOT NULL UNIQUE,        -- e.g. 'D-04'
  room_type_id  INTEGER NOT NULL REFERENCES room_types(id),
  housekeeping_status TEXT NOT NULL DEFAULT 'clean'
                CHECK (housekeeping_status IN ('clean', 'dirty', 'out_of_order')),
  occupancy_status TEXT NOT NULL DEFAULT 'vacant'
                CHECK (occupancy_status IN ('vacant', 'occupied')),
  active        BOOLEAN NOT NULL DEFAULT TRUE, -- hidden from the live dashboard grid when false;
                                                 -- never deleted, since reservations/folio history
                                                 -- may still reference it
  notes         TEXT
);

CREATE TABLE guests (
  id            SERIAL PRIMARY KEY,
  full_name     TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  nationality   TEXT,
  date_of_birth DATE,
  place_of_birth TEXT,
  id_type       TEXT,                        -- 'passport', 'emirates_id', etc.
  id_number     TEXT,
  do_not_rent   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reservations (
  id              SERIAL PRIMARY KEY,
  reservation_code TEXT NOT NULL UNIQUE,      -- e.g. 'SC-2214'
  guest_id        INTEGER NOT NULL REFERENCES guests(id),
  room_type_id    INTEGER NOT NULL REFERENCES room_types(id),
  room_id         INTEGER REFERENCES rooms(id),   -- assigned at allocation step, nullable until then
  check_in_date   DATE NOT NULL,
  check_out_date  DATE NOT NULL,
  adults          INTEGER NOT NULL DEFAULT 1,
  children        INTEGER NOT NULL DEFAULT 0,
  rate_per_night  NUMERIC(10,2) NOT NULL,
  source          TEXT DEFAULT 'direct',       -- 'direct', 'walk_in', 'ota', 'phone', etc.
  special_requests TEXT,
  status          TEXT NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_in_at   TIMESTAMPTZ,
  checked_out_at  TIMESTAMPTZ,

  CHECK (check_out_date > check_in_date)
);

-- Every charge, payment, or deposit against a reservation's bill
CREATE TABLE folio_transactions (
  id              SERIAL PRIMARY KEY,
  reservation_id  INTEGER NOT NULL REFERENCES reservations(id),
  type            TEXT NOT NULL
                  CHECK (type IN ('room_charge', 'extra_charge', 'payment', 'deposit', 'refund', 'discount', 'pay_out')),
  description     TEXT NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,     -- always in base currency (AED); see currency/exchange_rate below
  currency        TEXT NOT NULL DEFAULT 'AED',       -- currency the guest actually paid/was charged in
  exchange_rate   NUMERIC(12,6) NOT NULL DEFAULT 1,  -- rate used to convert `original_amount` to `amount` (base currency)
  original_amount NUMERIC(10,2),                     -- amount in `currency` before conversion; NULL when currency = base
  payment_method  TEXT,                       -- 'cash', 'card', 'bank_transfer', null for charges
  reference       TEXT,                       -- receipt/slip number
  recorded_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- History log so front desk / housekeeping status changes are auditable
CREATE TABLE room_status_log (
  id            SERIAL PRIMARY KEY,
  room_id       INTEGER NOT NULL REFERENCES rooms(id),
  field         TEXT NOT NULL CHECK (field IN ('housekeeping_status', 'occupancy_status')),
  old_value     TEXT,
  new_value     TEXT NOT NULL,
  changed_by    TEXT,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Helpful indexes for the front-desk dashboard and search
CREATE INDEX idx_reservations_status ON reservations(status);
CREATE INDEX idx_reservations_dates ON reservations(check_in_date, check_out_date);
CREATE INDEX idx_rooms_status ON rooms(occupancy_status, housekeeping_status);
CREATE INDEX idx_folio_reservation ON folio_transactions(reservation_id);

-- Housekeeping task assignment (distinct from the simple clean/dirty toggle on rooms —
-- this tracks discrete jobs like "change linen" or "check minibar" assigned to staff)
CREATE TABLE housekeeping_tasks (
  id            SERIAL PRIMARY KEY,
  room_id       INTEGER NOT NULL REFERENCES rooms(id),
  task_type     TEXT NOT NULL,               -- e.g. 'clean_room', 'change_linen', 'restock_minibar', 'maintenance'
  description   TEXT,
  assigned_to   TEXT,                        -- staff name/username; free text for now, see README on auth
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

CREATE INDEX idx_housekeeping_tasks_status ON housekeeping_tasks(status, room_id);

-- Night audit — closes each business day so it can't be reopened/re-audited by accident,
-- and stores the snapshot summary the auditor reviewed at close time.
CREATE TABLE business_days (
  id              SERIAL PRIMARY KEY,
  business_date   DATE NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  room_revenue    NUMERIC(10,2),
  extra_revenue   NUMERIC(10,2),
  payments_total  NUMERIC(10,2),
  arrivals        INTEGER,
  departures      INTEGER,
  no_shows        INTEGER,
  occupied_rooms  INTEGER,
  total_rooms     INTEGER,
  closed_by       TEXT,
  closed_at       TIMESTAMPTZ
);

-- Rate plans — multiple rates per room type (standard, weekend, seasonal, corporate, promo).
-- Overlapping plans are resolved by priority (higher wins) at quote time.
CREATE TABLE rate_plans (
  id            SERIAL PRIMARY KEY,
  room_type_id  INTEGER NOT NULL REFERENCES room_types(id),
  name          TEXT NOT NULL,               -- e.g. 'Standard', 'Weekend', 'Summer Season', 'Corporate — Emirates Trading'
  rate          NUMERIC(10,2) NOT NULL,
  start_date    DATE,                        -- NULL = no start bound (always active from the beginning)
  end_date      DATE,                        -- NULL = no end bound (open-ended, e.g. the evergreen 'Standard' plan)
  days_of_week  INTEGER[],                   -- optional: restrict to specific weekdays, 0=Sunday..6=Saturday; NULL = all days
  priority      INTEGER NOT NULL DEFAULT 0,  -- higher wins when multiple plans apply to the same night
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE INDEX idx_rate_plans_room_type ON rate_plans(room_type_id, active);

-- Users & roles, matching the eZee role model:
-- receptionist: reservations, check-in/out, post charges
-- supervisor: + modify rates, approve discounts
-- manager: + reports, audit trail, user management
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('receptionist', 'supervisor', 'manager')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Multi-currency: exchange rates against the property's base currency (AED).
-- rate = how many units of base currency (AED) one unit of `code` is worth.
CREATE TABLE currencies (
  code          TEXT PRIMARY KEY,             -- ISO 4217, e.g. 'USD', 'EUR', 'AED'
  name          TEXT NOT NULL,
  rate_to_base  NUMERIC(12,6) NOT NULL,        -- e.g. USD -> AED might be 3.6725
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Electronic key card issuance log. This assumes integrated lock hardware exists;
-- this table/route models what the PMS side of that integration looks like —
-- generating and validating a key credential tied to the guest's actual stay dates
-- and assigned room, per the eZee behavior. Wiring `key_code` to real lock hardware
-- (BLE/RFID encoder API) is a separate, property-specific integration step.
CREATE TABLE electronic_keys (
  id              SERIAL PRIMARY KEY,
  reservation_id  INTEGER NOT NULL REFERENCES reservations(id),
  room_id         INTEGER NOT NULL REFERENCES rooms(id),
  key_code        TEXT NOT NULL UNIQUE,        -- credential/token handed to the lock hardware or a mobile key app
  valid_from      TIMESTAMPTZ NOT NULL,
  valid_until     TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  issued_by       TEXT,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_electronic_keys_reservation ON electronic_keys(reservation_id);

-- Internal staff-to-staff communication (Reception -> Housekeeping / Maintenance, etc.)
CREATE TABLE internal_messages (
  id            SERIAL PRIMARY KEY,
  from_dept     TEXT NOT NULL,                -- e.g. 'reception'
  to_dept       TEXT NOT NULL,                -- e.g. 'housekeeping', 'maintenance'
  room_id       INTEGER REFERENCES rooms(id), -- optional — many messages are room-specific
  message       TEXT NOT NULL,
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status        TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'acknowledged')),
  sent_by       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at       TIMESTAMPTZ
);

CREATE INDEX idx_internal_messages_dept ON internal_messages(to_dept, status);

-- OTA / travel-agent distribution: tracks bookings ingested from external channels
-- and keeps a sync log so inventory pushes can be audited (module 39).
ALTER TABLE reservations ADD COLUMN external_booking_id TEXT;
ALTER TABLE reservations ADD COLUMN channel TEXT; -- e.g. 'booking.com', 'expedia', 'direct_travel_agent'
CREATE UNIQUE INDEX idx_reservations_external_booking ON reservations(channel, external_booking_id)
  WHERE external_booking_id IS NOT NULL;

CREATE TABLE ota_sync_log (
  id              SERIAL PRIMARY KEY,
  channel         TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('inbound_booking', 'outbound_inventory')),
  room_type_id    INTEGER REFERENCES room_types(id),
  date_range_start DATE,
  date_range_end  DATE,
  payload_summary TEXT,                       -- human-readable summary, not the raw payload
  status          TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guest-facing inventory: minibar, linens, in-room amenities. Tracked per room against a
-- central stock, so restocking a room draws down the warehouse count.
CREATE TABLE inventory_items (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,               -- e.g. 'Bottled Water 500ml', 'Bath Towel', 'Chocolate Bar'
  category        TEXT NOT NULL DEFAULT 'minibar' CHECK (category IN ('minibar', 'linen', 'amenity')),
  unit_cost       NUMERIC(10,2),                -- what it costs the property to replace one unit
  guest_price     NUMERIC(10,2),                -- what's charged to the guest if consumed; NULL = never billed (e.g. towels)
  reorder_threshold INTEGER NOT NULL DEFAULT 5,  -- central stock level that should trigger a reorder
  current_stock   INTEGER NOT NULL DEFAULT 0,    -- central/warehouse stock, drawn down by restocking rooms
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Par level and current count of each item actually sitting in each room right now.
CREATE TABLE room_inventory (
  id              SERIAL PRIMARY KEY,
  room_id         INTEGER NOT NULL REFERENCES rooms(id),
  item_id         INTEGER NOT NULL REFERENCES inventory_items(id),
  par_level       INTEGER NOT NULL DEFAULT 1,    -- the standard/target quantity this room should hold
  quantity_present INTEGER NOT NULL DEFAULT 0,   -- what's actually there right now
  UNIQUE (room_id, item_id)
);

-- Every consumption or restock event, so stock counts are auditable rather than just overwritten.
CREATE TABLE inventory_transactions (
  id              SERIAL PRIMARY KEY,
  room_id         INTEGER NOT NULL REFERENCES rooms(id),
  item_id         INTEGER NOT NULL REFERENCES inventory_items(id),
  type            TEXT NOT NULL CHECK (type IN ('consume', 'restock', 'adjust')),
  quantity        INTEGER NOT NULL,              -- always positive; direction is implied by `type`
  reservation_id  INTEGER REFERENCES reservations(id), -- set when consumption is billed to a specific guest's stay
  recorded_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_transactions_room ON inventory_transactions(room_id, created_at);

-- General expense ledger: utilities, salaries, supply purchases, maintenance, etc.
-- Deliberately append-only, same philosophy as folio_transactions — corrections are new
-- entries, not edits to history.
CREATE TABLE expenses (
  id              SERIAL PRIMARY KEY,
  category        TEXT NOT NULL CHECK (category IN ('utilities', 'salaries', 'supplies', 'maintenance', 'marketing', 'other')),
  description     TEXT NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,        -- always in base currency (AED)
  currency        TEXT NOT NULL DEFAULT 'AED',
  exchange_rate   NUMERIC(12,6) NOT NULL DEFAULT 1,
  original_amount NUMERIC(10,2),                 -- amount in `currency` before conversion; NULL when currency = base
  payment_method  TEXT,                          -- 'cash', 'card', 'bank_transfer'
  vendor          TEXT,
  reference       TEXT,                          -- receipt/invoice number
  expense_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  recorded_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_expenses_date ON expenses(expense_date, category);

-- Simple key-value store for editable property settings — starting with terms & conditions,
-- which used to be hardcoded text in services/pdf-letterhead.js and required a code deploy
-- to change. Generic enough to hold future editable settings without a new table each time.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

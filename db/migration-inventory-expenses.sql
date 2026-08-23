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

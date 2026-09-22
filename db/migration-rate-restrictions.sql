-- Extends rate_plans to also carry booking restrictions (min/max stay, stop sell,
-- closed to arrival/departure), not just price. This matches how Channex's own
-- restrictions API models it — a single per-date update covering price and booking
-- constraints together for one rate plan, not two separate systems.
--
-- rate becomes nullable: a plan with no rate override can still apply restrictions on
-- its own (e.g. "close this date to new bookings" without necessarily changing the price).
ALTER TABLE rate_plans ALTER COLUMN rate DROP NOT NULL;
ALTER TABLE rate_plans ADD COLUMN min_stay INTEGER;
ALTER TABLE rate_plans ADD COLUMN max_stay INTEGER;
ALTER TABLE rate_plans ADD COLUMN stop_sell BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rate_plans ADD COLUMN closed_to_arrival BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rate_plans ADD COLUMN closed_to_departure BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rate_plans ADD CONSTRAINT rate_plans_stay_check CHECK (max_stay IS NULL OR min_stay IS NULL OR max_stay >= min_stay);

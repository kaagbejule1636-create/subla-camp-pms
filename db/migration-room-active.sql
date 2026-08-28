-- Adds an `active` flag to rooms so a room can be hidden from the live dashboard without
-- ever being deleted — reservations, folio transactions, and other history may still
-- reference it, and deleting the row outright would either fail or (worse) cascade-delete
-- real financial records.

ALTER TABLE rooms ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE;

-- Per today's request: only Deluxe Rooms (Unit 1-5) should show on the dashboard right now.
-- This deactivates every room whose type is NOT 'Deluxe Rooms' — Camping Tents (Section 1-5)
-- and Caravan Parking (Spot 1-5) — without touching any of their history. Re-activating them
-- later (when needed again) is just flipping this flag back, via the new "Manage Rooms" screen
-- or a one-line UPDATE — nothing about their past reservations or financial records is lost.
UPDATE rooms
SET active = FALSE
WHERE room_type_id NOT IN (SELECT id FROM room_types WHERE name = 'Deluxe Rooms');

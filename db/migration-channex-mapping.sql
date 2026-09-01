-- Stores the mapping between Subla Camp's own room types and Channex's equivalent
-- objects, once each room type is mapped in the Channex dashboard. Both are nullable —
-- a room type with no mapping yet simply isn't synced to Channex, rather than causing
-- an error; the integration only acts on room types that have actually been mapped.
ALTER TABLE room_types ADD COLUMN channex_room_type_id TEXT;
ALTER TABLE room_types ADD COLUMN channex_rate_plan_id TEXT;

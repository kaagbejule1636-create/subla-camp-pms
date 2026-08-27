-- Renames every room's room_number based on its room type, restarting at 1 for each type:
--   Deluxe Rooms    -> Unit 1..5
--   Caravan Parking -> Spot 1..5
--   Camping Tents   -> Section 1..5
--
-- Computes the new number from each room's current position within its type (ordered
-- numerically by whatever digits are in its existing room_number, e.g. "Unit 10" sorts
-- after "Unit 6" as 10, not as the text "10" which would otherwise sort before "6") rather
-- than assuming the exact old names, so this works correctly even if the old naming isn't
-- exactly what's expected.

UPDATE rooms r
SET room_number = renamed.new_number
FROM (
  SELECT
    r2.id,
    CASE rt.name
      WHEN 'Deluxe Rooms'    THEN 'Unit '
      WHEN 'Caravan Parking' THEN 'Spot '
      WHEN 'Camping Tents'   THEN 'Section '
      ELSE rt.name || ' '
    END || ROW_NUMBER() OVER (
      PARTITION BY r2.room_type_id
      ORDER BY COALESCE(NULLIF(regexp_replace(r2.room_number, '\D', '', 'g'), '')::INTEGER, 0)
    ) AS new_number
  FROM rooms r2
  JOIN room_types rt ON rt.id = r2.room_type_id
) renamed
WHERE r.id = renamed.id;

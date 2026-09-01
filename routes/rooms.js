const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { syncRoomTypeAvailability } = require('../services/channex-sync');

// GET /api/rooms — full room grid (used by the dashboard and room-assignment tile view)
// Optional query params: room_type_id, occupancy_status, housekeeping_status
// Only active rooms by default — pass include_inactive=true to see everything, used by the
// room-management screen where a deactivated room still needs to be visible to reactivate.
router.get('/', async (req, res) => {
  const { room_type_id, occupancy_status, housekeeping_status, include_inactive } = req.query;
  const conditions = [];
  const values = [];

  if (!include_inactive) {
    conditions.push('r.active = TRUE');
  }
  if (room_type_id) {
    values.push(room_type_id);
    conditions.push(`r.room_type_id = $${values.length}`);
  }
  if (occupancy_status) {
    values.push(occupancy_status);
    conditions.push(`r.occupancy_status = $${values.length}`);
  }
  if (housekeeping_status) {
    values.push(housekeeping_status);
    conditions.push(`r.housekeeping_status = $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.room_number, r.housekeeping_status, r.occupancy_status, r.notes, r.active,
              rt.id AS room_type_id, rt.name AS room_type, rt.base_rate,
              g.full_name AS guest_name, res.id AS reservation_id
       FROM rooms r
       JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN reservations res ON res.room_id = r.id AND res.status = 'checked_in'
       LEFT JOIN guests g ON g.id = res.guest_id
       ${where}
       ORDER BY rt.name, r.room_number`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load rooms' });
  }
});

// POST /api/rooms — add a new room to an existing category (manager only — property
// configuration, not day-to-day front-desk work).
router.post('/', requireRole('manager'), async (req, res) => {
  const { room_number, room_type_id } = req.body;
  if (!room_number || !room_type_id) {
    return res.status(400).json({ error: 'room_number and room_type_id are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO rooms (room_number, room_type_id) VALUES ($1, $2) RETURNING *`,
      [room_number, room_type_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Room "${room_number}" already exists` });
    console.error(err);
    res.status(500).json({ error: 'Failed to add room' });
  }
});

// PATCH /api/rooms/:id/active — show/hide a room from the live dashboard without ever
// deleting it, since reservations, folio transactions, and other history may reference it.
router.patch('/:id/active', requireRole('manager'), async (req, res) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be true or false' });
  const { rows } = await pool.query('UPDATE rooms SET active = $1 WHERE id = $2 RETURNING *', [active, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Room not found' });
  res.json(rows[0]);

  // Hiding or showing a room changes the total sellable count for its whole room type —
  // best-effort, same treatment as every other Channex sync trigger.
  const syncFrom = new Date().toISOString().slice(0, 10);
  const syncTo = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  syncRoomTypeAvailability(rows[0].room_type_id, syncFrom, syncTo)
    .catch((err) => console.error('Channex availability sync after room active/hide toggle failed:', err));
});

// GET /api/rooms/room-types — every category (Deluxe Rooms, Camping Tents, etc.), for the
// room-management screen and the "New Reservation" room-type picker.
router.get('/room-types', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM room_types ORDER BY name');
  res.json(rows);
});

// POST /api/rooms/room-types — add a brand-new category (manager only).
router.post('/room-types', requireRole('manager'), async (req, res) => {
  const { name, base_rate } = req.body;
  if (!name || base_rate === undefined) return res.status(400).json({ error: 'name and base_rate are required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO room_types (name, base_rate) VALUES ($1, $2) RETURNING *',
      [name, base_rate]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add category' });
  }
});

// PATCH /api/rooms/room-types/:id/channex-mapping — links a room type to its equivalent
// Channex room type and rate plan, found in the Channex dashboard after mapping this
// property's rooms there. Until this is set, the room type is simply invisible to the
// Channex sync — no bookings come in for it, no availability gets pushed out, and nothing
// errors; it's just not connected yet. Both fields accept an empty string to clear a
// mapping (e.g. if you need to remap it to a different Channex object).
router.patch('/room-types/:id/channex-mapping', requireRole('manager'), async (req, res) => {
  const { channex_room_type_id, channex_rate_plan_id } = req.body;
  const { rows } = await pool.query(
    `UPDATE room_types SET channex_room_type_id = $1, channex_rate_plan_id = $2 WHERE id = $3 RETURNING *`,
    [channex_room_type_id || null, channex_rate_plan_id || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Room type not found' });
  res.json(rows[0]);
});

// GET /api/rooms/available?room_type_id=1&check_in=2026-08-17&check_out=2026-08-19
// Rooms of the given type not already reserved/occupied for that date range,
// used by the "Assign Room" step so overbooking can't happen.
router.get('/available', async (req, res) => {
  const { room_type_id, check_in, check_out } = req.query;
  if (!room_type_id || !check_in || !check_out) {
    return res.status(400).json({ error: 'room_type_id, check_in, and check_out are required' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.room_number, r.housekeeping_status, rt.name AS room_type, rt.base_rate
       FROM rooms r
       JOIN room_types rt ON rt.id = r.room_type_id
       WHERE r.room_type_id = $1
         AND r.housekeeping_status != 'out_of_order'
         AND r.id NOT IN (
           SELECT res.room_id FROM reservations res
           WHERE res.room_id IS NOT NULL
             AND res.status IN ('confirmed', 'checked_in')
             AND res.check_in_date < $3
             AND res.check_out_date > $2
         )
       ORDER BY r.room_number`,
      [room_type_id, check_in, check_out]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load available rooms' });
  }
});

// PATCH /api/rooms/:id/housekeeping — mark clean/dirty/out_of_order (housekeeping module)
router.patch('/:id/housekeeping', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const changed_by = req.user.username;
  const valid = ['clean', 'dirty', 'out_of_order'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${valid.join(', ')}` });
  }

  try {
    const { rows: current } = await pool.query('SELECT housekeeping_status FROM rooms WHERE id = $1', [id]);
    if (!current.length) return res.status(404).json({ error: 'Room not found' });

    await pool.query('UPDATE rooms SET housekeeping_status = $1 WHERE id = $2', [status, id]);
    await pool.query(
      `INSERT INTO room_status_log (room_id, field, old_value, new_value, changed_by)
       VALUES ($1, 'housekeeping_status', $2, $3, $4)`,
      [id, current[0].housekeeping_status, status, changed_by || null]
    );
    res.json({ id, housekeeping_status: status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update housekeeping status' });
  }
});

module.exports = router;

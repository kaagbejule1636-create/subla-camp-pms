const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/rooms — full room grid (used by the dashboard and room-assignment tile view)
// Optional query params: room_type_id, occupancy_status, housekeeping_status
router.get('/', async (req, res) => {
  const { room_type_id, occupancy_status, housekeeping_status } = req.query;
  const conditions = [];
  const values = [];

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
      `SELECT r.id, r.room_number, r.housekeeping_status, r.occupancy_status, r.notes,
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

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

function generateReservationCode() {
  // Simple readable code, e.g. SC-4821. Swap for a sequence/table if you need strict ordering.
  return `SC-${Math.floor(1000 + Math.random() * 9000)}`;
}

// GET /api/reservations/search?q=Aisha — used by the check-in "search reservation" step
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    const { rows } = await pool.query(
      `SELECT res.id, res.reservation_code, res.status, res.check_in_date, res.check_out_date,
              res.adults, res.children, res.rate_per_night, res.room_id,
              g.full_name AS guest_name, g.phone, g.email, g.nationality, g.do_not_rent,
              rt.name AS room_type
       FROM reservations res
       JOIN guests g ON g.id = res.guest_id
       JOIN room_types rt ON rt.id = res.room_type_id
       WHERE res.reservation_code ILIKE $1 OR g.full_name ILIKE $1
       ORDER BY res.check_in_date DESC
       LIMIT 20`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// POST /api/reservations — create a reservation (covers both advance bookings and walk-ins;
// walk-ins just use today's date as check_in_date and typically go straight to check-in after)
router.post('/', async (req, res) => {
  const {
    guest, // { full_name, phone, email, nationality, id_type, id_number }
    room_type_id,
    check_in_date,
    check_out_date,
    adults,
    children,
    rate_per_night,
    source,
    special_requests,
  } = req.body;

  if (!guest?.full_name || !room_type_id || !check_in_date || !check_out_date || !rate_per_night) {
    return res.status(400).json({ error: 'guest.full_name, room_type_id, dates, and rate_per_night are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reuse an existing guest by phone/email if one matches, otherwise create a new profile
    let guestId;
    if (guest.phone || guest.email) {
      const { rows: existing } = await client.query(
        `SELECT id FROM guests WHERE (phone = $1 AND $1 IS NOT NULL) OR (email = $2 AND $2 IS NOT NULL) LIMIT 1`,
        [guest.phone || null, guest.email || null]
      );
      if (existing.length) guestId = existing[0].id;
    }
    if (!guestId) {
      const { rows: created } = await client.query(
        `INSERT INTO guests (full_name, phone, email, nationality, id_type, id_number)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, do_not_rent`,
        [guest.full_name, guest.phone, guest.email, guest.nationality, guest.id_type, guest.id_number]
      );
      guestId = created[0].id;
    }

    const { rows: guestCheck } = await client.query('SELECT do_not_rent FROM guests WHERE id = $1', [guestId]);
    if (guestCheck[0].do_not_rent) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This guest is flagged Do-Not-Rent' });
    }

    const { rows: reservation } = await client.query(
      `INSERT INTO reservations
        (reservation_code, guest_id, room_type_id, check_in_date, check_out_date,
         adults, children, rate_per_night, source, special_requests)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        generateReservationCode(), guestId, room_type_id, check_in_date, check_out_date,
        adults || 1, children || 0, rate_per_night, source || 'direct', special_requests || null,
      ]
    );

    await client.query('COMMIT');
    res.status(201).json(reservation[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create reservation' });
  } finally {
    client.release();
  }
});

// PATCH /api/reservations/:id/assign-room — the "Assign Room" step
router.patch('/:id/assign-room', async (req, res) => {
  const { id } = req.params;
  const { room_id } = req.body;
  if (!room_id) return res.status(400).json({ error: 'room_id is required' });

  try {
    const { rows } = await pool.query(
      `UPDATE reservations SET room_id = $1 WHERE id = $2 AND status IN ('confirmed') RETURNING *`,
      [room_id, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found or not in a state that allows room assignment' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to assign room' });
  }
});

// PATCH /api/reservations/:id/cancel
router.patch('/:id/cancel', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE reservations SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found or already checked in' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel reservation' });
  }
});

// GET /api/reservations/dashboard — today's arrivals/departures/in-house count, for the front-desk home screen
router.get('/dashboard', async (req, res) => {
  try {
    const { rows: arrivals } = await pool.query(
      `SELECT COUNT(*) FROM reservations WHERE check_in_date = CURRENT_DATE AND status = 'confirmed'`
    );
    const { rows: departures } = await pool.query(
      `SELECT COUNT(*) FROM reservations WHERE check_out_date = CURRENT_DATE AND status = 'checked_in'`
    );
    const { rows: inHouse } = await pool.query(
      `SELECT COUNT(*) FROM reservations WHERE status = 'checked_in'`
    );
    const { rows: dirty } = await pool.query(
      `SELECT COUNT(*) FROM rooms WHERE housekeeping_status = 'dirty'`
    );
    res.json({
      expected_arrivals: Number(arrivals[0].count),
      expected_departures: Number(departures[0].count),
      in_house_guests: Number(inHouse[0].count),
      rooms_to_clean: Number(dirty[0].count),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

module.exports = router;

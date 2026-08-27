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
        `INSERT INTO guests (full_name, phone, email, nationality, date_of_birth, place_of_birth, id_type, id_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, do_not_rent`,
        [
          guest.full_name, guest.phone, guest.email, guest.nationality,
          guest.date_of_birth || null, guest.place_of_birth || null, guest.id_type, guest.id_number,
        ]
      );
      guestId = created[0].id;
    } else if (guest.id_type || guest.id_number || guest.nationality || guest.date_of_birth || guest.place_of_birth) {
      // Returning guest — fill in any ID/personal details that weren't captured before.
      // Only fills gaps, never overwrites what's already on file (COALESCE keeps the
      // existing value whenever the new one is null), so a repeat visit can't accidentally
      // clobber a correct ID with a blank or mistyped one.
      await client.query(
        `UPDATE guests SET
           id_type = COALESCE(id_type, $1),
           id_number = COALESCE(id_number, $2),
           nationality = COALESCE(nationality, $3),
           date_of_birth = COALESCE(date_of_birth, $4),
           place_of_birth = COALESCE(place_of_birth, $5)
         WHERE id = $6`,
        [
          guest.id_type || null, guest.id_number || null, guest.nationality || null,
          guest.date_of_birth || null, guest.place_of_birth || null, guestId,
        ]
      );
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
    const { rows: outOfOrder } = await pool.query(
      `SELECT COUNT(*) FROM rooms WHERE housekeeping_status = 'out_of_order'`
    );
    // Guests whose checkout date has already passed but were never actually checked out.
    // This is deliberately separate from "expected departures" (which is today's checkouts,
    // and already updates on its own at midnight since it's driven by CURRENT_DATE) — these
    // are stuck reservations that need staff to actually go complete the checkout, not a
    // status the system silently flips on its own. Auto-completing a checkout would skip
    // balance settlement and could quietly lose track of money still owed, so this stays a
    // visible prompt rather than an automatic action.
    const { rows: overdue } = await pool.query(
      `SELECT COUNT(*) FROM reservations WHERE status = 'checked_in' AND check_out_date < CURRENT_DATE`
    );
    res.json({
      expected_arrivals: Number(arrivals[0].count),
      expected_departures: Number(departures[0].count),
      in_house_guests: Number(inHouse[0].count),
      rooms_to_clean: Number(dirty[0].count),
      rooms_out_of_order: Number(outOfOrder[0].count),
      overdue_departures: Number(overdue[0].count),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// POST /api/reservations/:id/charges — add an extra charge at any point during a stay
// (damage fee, extra service, airport transfer, late checkout, etc.), not just the
// last-minute one at checkout (see checkout.js's /charge route) or the automatic ones
// from consuming inventory. Blocked for cancelled/no_show reservations, since there's
// no guest folio to bill in those cases.
router.post('/:id/charges', async (req, res) => {
  const { id } = req.params;
  const { description, amount } = req.body;
  if (!description || amount === undefined) {
    return res.status(400).json({ error: 'description and amount are required' });
  }
  if (Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be positive' });
  }

  try {
    const { rows: reservationRows } = await pool.query('SELECT status FROM reservations WHERE id = $1', [id]);
    if (!reservationRows.length) return res.status(404).json({ error: 'Reservation not found' });
    if (['cancelled', 'no_show'].includes(reservationRows[0].status)) {
      return res.status(409).json({ error: `Cannot add a charge to a reservation with status '${reservationRows[0].status}'` });
    }

    const { rows } = await pool.query(
      `INSERT INTO folio_transactions (reservation_id, type, description, amount, recorded_by)
       VALUES ($1, 'extra_charge', $2, $3, $4) RETURNING *`,
      [id, description, amount, req.user.username]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add charge' });
  }
});

// GET /api/reservations/by-room/:roomId — finds the currently checked-in reservation for a
// room, if any. Built for the frontend room grid: clicking an occupied tile needs to know
// which reservation to show for checkout, and there was previously no way to look that up
// except by already knowing the reservation code or guest name.
router.get('/by-room/:roomId', async (req, res) => {
  const { roomId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT res.*, g.full_name, g.phone
       FROM reservations res JOIN guests g ON g.id = res.guest_id
       WHERE res.room_id = $1 AND res.status = 'checked_in'
       ORDER BY res.checked_in_at DESC LIMIT 1`,
      [roomId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No active reservation for this room' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to look up reservation for room' });
  }
});

// PATCH /api/reservations/:id/stay — extend or shorten a stay in place, without a
// checkout/new-checkin cycle. Works for both a guest currently in-house (checked_in) and
// an advance booking that hasn't arrived yet (confirmed).
//
// Extending automatically posts a room charge for the added nights, at the reservation's
// existing rate, so the extra revenue isn't silently missed. Shortening does NOT
// auto-refund — money already collected needs a human decision about whether it's
// refundable, so that stays a manual action via the existing folio tools rather than
// something this endpoint decides on its own.
router.patch('/:id/stay', async (req, res) => {
  const { id } = req.params;
  const { check_in_date, check_out_date } = req.body;
  if (!check_out_date) return res.status(400).json({ error: 'check_out_date is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [id]);
    if (!existingRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reservation not found' });
    }
    const existing = existingRows[0];
    if (!['confirmed', 'checked_in'].includes(existing.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot change stay dates on a reservation with status '${existing.status}'` });
    }

    const newCheckIn = check_in_date || existing.check_in_date;
    if (new Date(check_out_date) <= new Date(newCheckIn)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'check_out_date must be after check_in_date' });
    }

    // If a room's already assigned, make sure the new date range doesn't collide with
    // another booking for that same room — same overlap check used everywhere else in the
    // system, just excluding this reservation itself from the conflict search.
    if (existing.room_id) {
      const { rows: conflicts } = await client.query(
        `SELECT reservation_code FROM reservations
         WHERE room_id = $1 AND id != $2 AND status IN ('confirmed', 'checked_in')
           AND check_in_date < $4 AND check_out_date > $3`,
        [existing.room_id, id, newCheckIn, check_out_date]
      );
      if (conflicts.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Room is already booked for part of that period (conflicts with ${conflicts[0].reservation_code})` });
      }
    }

    const oldNights = (new Date(existing.check_out_date) - new Date(existing.check_in_date)) / 86400000;
    const newNights = (new Date(check_out_date) - new Date(newCheckIn)) / 86400000;
    const addedNights = newNights - oldNights;

    await client.query(
      `UPDATE reservations SET check_in_date = $1, check_out_date = $2 WHERE id = $3`,
      [newCheckIn, check_out_date, id]
    );

    let chargeAdded = null;
    if (addedNights > 0) {
      chargeAdded = addedNights * Number(existing.rate_per_night);
      await client.query(
        `INSERT INTO folio_transactions (reservation_id, type, description, amount, recorded_by)
         VALUES ($1, 'room_charge', $2, $3, $4)`,
        [id, `Stay extended by ${addedNights} night${addedNights === 1 ? '' : 's'}`, chargeAdded, req.user.username]
      );
    }

    await client.query('COMMIT');
    res.json({
      id: Number(id), check_in_date: newCheckIn, check_out_date,
      nights_added: addedNights, charge_added: chargeAdded,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to change stay dates' });
  } finally {
    client.release();
  }
});

module.exports = router;

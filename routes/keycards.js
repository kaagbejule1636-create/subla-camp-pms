const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');

function generateKeyCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

// POST /api/keycards/:reservationId/issue — generates an electronic key for the guest's
// assigned room, valid for exactly their stay dates. Intended to be called from the
// "Confirm Check-In" step (see checkin.js) when "Issue electronic key" is chosen.
router.post('/:reservationId/issue', async (req, res) => {
  const { reservationId } = req.params;

  try {
    const { rows: reservationRows } = await pool.query(
      `SELECT * FROM reservations WHERE id = $1`,
      [reservationId]
    );
    if (!reservationRows.length) return res.status(404).json({ error: 'Reservation not found' });
    const reservation = reservationRows[0];

    if (!reservation.room_id) {
      return res.status(409).json({ error: 'No room assigned yet — complete the Assign Room step first' });
    }
    if (!['confirmed', 'checked_in'].includes(reservation.status)) {
      return res.status(409).json({ error: `Cannot issue a key for a reservation with status '${reservation.status}'` });
    }

    // Key validity always matches the actual stay dates, per the eZee behavior —
    // never longer than the booking, regardless of what's requested.
    const validFrom = new Date(reservation.check_in_date);
    validFrom.setHours(14, 0, 0, 0); // standard 2pm check-in time; adjust to your property's policy
    const validUntil = new Date(reservation.check_out_date);
    validUntil.setHours(12, 0, 0, 0); // standard noon check-out time

    const { rows } = await pool.query(
      `INSERT INTO electronic_keys (reservation_id, room_id, key_code, valid_from, valid_until, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [reservationId, reservation.room_id, generateKeyCode(), validFrom, validUntil, req.user?.username || null]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to issue key' });
  }
});

// POST /api/keycards/:keyId/revoke — e.g. lost card, early departure, room change
router.post('/:keyId/revoke', async (req, res) => {
  const { keyId } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE electronic_keys SET status = 'revoked', revoked_at = now()
       WHERE id = $1 AND status = 'active' RETURNING *`,
      [keyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Key not found or already inactive' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to revoke key' });
  }
});

// GET /api/keycards/:reservationId — all keys issued for a reservation
router.get('/:reservationId', async (req, res) => {
  const { reservationId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM electronic_keys WHERE reservation_id = $1 ORDER BY issued_at DESC`,
      [reservationId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load keys' });
  }
});

module.exports = router;

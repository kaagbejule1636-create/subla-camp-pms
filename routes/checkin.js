const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { resolvePaymentAmount } = require('../services/currency');

// GET /api/checkin/:reservationId/folio — charge summary shown on the Deposit/Payment and Confirm steps
router.get('/:reservationId/folio', async (req, res) => {
  const { reservationId } = req.params;
  try {
    const { rows: reservation } = await pool.query(
      `SELECT res.*, rt.name AS room_type
       FROM reservations res JOIN room_types rt ON rt.id = res.room_type_id
       WHERE res.id = $1`,
      [reservationId]
    );
    if (!reservation.length) return res.status(404).json({ error: 'Reservation not found' });

    const r = reservation[0];
    const nights = Math.round(
      (new Date(r.check_out_date) - new Date(r.check_in_date)) / (1000 * 60 * 60 * 24)
    );
    const roomTotal = Number(r.rate_per_night) * nights;

    const { rows: transactions } = await pool.query(
      `SELECT * FROM folio_transactions WHERE reservation_id = $1 ORDER BY created_at`,
      [reservationId]
    );

    const paid = transactions
      .filter((t) => ['payment', 'deposit'].includes(t.type))
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const extraCharges = transactions
      .filter((t) => ['extra_charge', 'pay_out'].includes(t.type))
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const refundsAndDiscounts = transactions
      .filter((t) => ['refund', 'discount'].includes(t.type))
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const balanceDue = roomTotal + extraCharges - paid - refundsAndDiscounts;

    res.json({
      reservation_id: r.id,
      nights,
      room_total: roomTotal,
      extra_charges: extraCharges,
      paid,
      refunds_and_discounts: refundsAndDiscounts,
      balance_due: balanceDue,
      transactions,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load folio' });
  }
});

// POST /api/checkin/:reservationId/payment — the Deposit/Payment step
router.post('/:reservationId/payment', async (req, res) => {
  const { reservationId } = req.params;
  const { amount, payment_method, reference, type, currency } = req.body;
  const recorded_by = req.user.username;

  if (!amount || !payment_method) {
    return res.status(400).json({ error: 'amount and payment_method are required' });
  }

  try {
    const resolved = await resolvePaymentAmount(pool, amount, currency);
    const { rows } = await pool.query(
      `INSERT INTO folio_transactions
        (reservation_id, type, description, amount, currency, exchange_rate, original_amount, payment_method, reference, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        reservationId,
        type === 'deposit' ? 'deposit' : 'payment',
        type === 'deposit' ? 'Advance deposit at check-in' : 'Payment at check-in',
        resolved.amount,
        resolved.currency,
        resolved.exchange_rate,
        resolved.original_amount,
        payment_method,
        reference || null,
        recorded_by || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to record payment' });
  }
});

// POST /api/checkin/:reservationId/confirm — the final "Check In Guest" action.
// Flips reservation -> checked_in and room -> occupied in one transaction,
// and posts the room charge to the folio so night audit has something to reconcile.
router.post('/:reservationId/confirm', async (req, res) => {
  const { reservationId } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: reservationRows } = await client.query(
      `SELECT * FROM reservations WHERE id = $1 FOR UPDATE`,
      [reservationId]
    );
    if (!reservationRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reservation not found' });
    }
    const reservation = reservationRows[0];

    if (reservation.status !== 'confirmed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Reservation is '${reservation.status}', expected 'confirmed'` });
    }
    if (!reservation.room_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No room assigned yet — complete the Assign Room step first' });
    }

    const { rows: roomRows } = await client.query('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [reservation.room_id]);
    const room = roomRows[0];
    if (room.occupancy_status !== 'vacant') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Assigned room is no longer vacant' });
    }

    const nights = Math.round(
      (new Date(reservation.check_out_date) - new Date(reservation.check_in_date)) / (1000 * 60 * 60 * 24)
    );
    const roomTotal = Number(reservation.rate_per_night) * nights;

    await client.query(
      `UPDATE reservations SET status = 'checked_in', checked_in_at = now() WHERE id = $1`,
      [reservationId]
    );
    await client.query(
      `UPDATE rooms SET occupancy_status = 'occupied' WHERE id = $1`,
      [reservation.room_id]
    );
    await client.query(
      `INSERT INTO room_status_log (room_id, field, old_value, new_value, changed_by)
       VALUES ($1, 'occupancy_status', 'vacant', 'occupied', $2)`,
      [reservation.room_id, req.user.username]
    );
    await client.query(
      `INSERT INTO folio_transactions (reservation_id, type, description, amount, recorded_by)
       VALUES ($1, 'room_charge', $2, $3, $4)`,
      [reservationId, `Room charge (${nights} night${nights === 1 ? '' : 's'})`, roomTotal, req.user.username]
    );

    await client.query('COMMIT');
    res.json({ reservation_id: Number(reservationId), room_id: reservation.room_id, status: 'checked_in' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to complete check-in' });
  } finally {
    client.release();
  }
});

module.exports = router;

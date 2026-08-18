const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// POST /api/payouts — records a cash disbursement made on a guest's behalf
// (e.g. AED 50 for a taxi) as a documented voucher, rather than cash silently
// leaving the drawer. Posted to the guest's folio as an extra_charge (per the
// eZee doc: "the amount can be charged/recorded against the relevant folio"),
// so it shows up on their bill and in the cashier-shift report.
router.post('/', async (req, res) => {
  const { reservation_id, amount, reason } = req.body;
  if (!reservation_id || !amount || !reason) {
    return res.status(400).json({ error: 'reservation_id, amount, and reason are required' });
  }
  if (Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be positive' });
  }

  try {
    const { rows: reservationCheck } = await pool.query(
      `SELECT status FROM reservations WHERE id = $1`, [reservation_id]
    );
    if (!reservationCheck.length) return res.status(404).json({ error: 'Reservation not found' });

    const { rows } = await pool.query(
      `INSERT INTO folio_transactions
        (reservation_id, type, description, amount, payment_method, recorded_by)
       VALUES ($1, 'pay_out', $2, $3, 'cash', $4)
       RETURNING *`,
      [reservation_id, `Pay-out voucher: ${reason}`, amount, req.user.username]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record pay-out' });
  }
});

// GET /api/payouts?reservation_id=&start=&end= — voucher history, for cash reconciliation
router.get('/', async (req, res) => {
  const { reservation_id, start, end } = req.query;
  const conditions = [`ft.type = 'pay_out'`];
  const values = [];

  if (reservation_id) {
    values.push(reservation_id);
    conditions.push(`ft.reservation_id = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`ft.created_at::date >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`ft.created_at::date <= $${values.length}`);
  }

  try {
    const { rows } = await pool.query(
      `SELECT ft.*, res.reservation_code
       FROM folio_transactions ft
       JOIN reservations res ON res.id = ft.reservation_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ft.created_at DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load pay-outs' });
  }
});

module.exports = router;

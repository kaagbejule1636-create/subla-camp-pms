const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const PDFDocument = require('pdfkit');
const { resolvePaymentAmount } = require('../services/currency');
const { drawLetterhead } = require('../services/pdf-letterhead');

// GET /api/checkout/:reservationId/folio — full bill for review before checkout.
// Same shape as the check-in folio endpoint (room charges + extras vs payments/deposits/discounts).
router.get('/:reservationId/folio', async (req, res) => {
  const { reservationId } = req.params;
  try {
    const { rows: reservation } = await pool.query(
      `SELECT res.*, rt.name AS room_type, rm.room_number
       FROM reservations res
       JOIN room_types rt ON rt.id = res.room_type_id
       LEFT JOIN rooms rm ON rm.id = res.room_id
       WHERE res.id = $1`,
      [reservationId]
    );
    if (!reservation.length) return res.status(404).json({ error: 'Reservation not found' });
    const r = reservation[0];

    const { rows: transactions } = await pool.query(
      `SELECT * FROM folio_transactions WHERE reservation_id = $1 ORDER BY created_at`,
      [reservationId]
    );

    const charges = transactions
      .filter((t) => ['room_charge', 'extra_charge', 'pay_out'].includes(t.type))
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const credits = transactions
      .filter((t) => ['payment', 'deposit', 'refund', 'discount'].includes(t.type))
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const balanceDue = charges - credits;

    res.json({
      reservation_id: r.id,
      guest_id: r.guest_id,
      room_number: r.room_number,
      room_type: r.room_type,
      check_in_date: r.check_in_date,
      check_out_date: r.check_out_date,
      total_charges: charges,
      total_credits: credits,
      balance_due: balanceDue,
      transactions,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load folio' });
  }
});

// POST /api/checkout/:reservationId/charge — add a last-minute extra charge before settling
// (minibar, laundry, late checkout fee, etc.)
router.post('/:reservationId/charge', async (req, res) => {
  const { reservationId } = req.params;
  const { description, amount } = req.body;
  const recorded_by = req.user.username;
  if (!description || amount === undefined) {
    return res.status(400).json({ error: 'description and amount are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO folio_transactions (reservation_id, type, description, amount, recorded_by)
       VALUES ($1, 'extra_charge', $2, $3, $4) RETURNING *`,
      [reservationId, description, amount, recorded_by || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add charge' });
  }
});

// POST /api/checkout/:reservationId/settle — record the final payment that clears the balance
// (same shape as the check-in payment endpoint; kept separate so it's clearly the closing entry)
router.post('/:reservationId/settle', async (req, res) => {
  const { reservationId } = req.params;
  const { amount, payment_method, reference, currency } = req.body;
  const recorded_by = req.user.username;
  if (!amount || !payment_method) {
    return res.status(400).json({ error: 'amount and payment_method are required' });
  }
  try {
    const resolved = await resolvePaymentAmount(pool, amount, currency);
    const { rows } = await pool.query(
      `INSERT INTO folio_transactions
        (reservation_id, type, description, amount, currency, exchange_rate, original_amount, payment_method, reference, recorded_by)
       VALUES ($1, 'payment', 'Payment at check-out', $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        reservationId, resolved.amount, resolved.currency, resolved.exchange_rate,
        resolved.original_amount, payment_method, reference || null, recorded_by || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to record settlement' });
  }
});

// POST /api/checkout/:reservationId/confirm — completes checkout.
// Refuses to proceed if there's an outstanding balance (matches eZee's zero-balance-before-checkout behavior),
// unless force=true is passed (e.g. company/direct-billing accounts settled separately via city ledger).
router.post('/:reservationId/confirm', async (req, res) => {
  const { reservationId } = req.params;
  const { force } = req.body;
  const recorded_by = req.user.username;

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

    if (reservation.status !== 'checked_in') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Reservation is '${reservation.status}', expected 'checked_in'` });
    }

    const { rows: transactions } = await client.query(
      `SELECT type, amount FROM folio_transactions WHERE reservation_id = $1`,
      [reservationId]
    );
    const charges = transactions
      .filter((t) => ['room_charge', 'extra_charge', 'pay_out'].includes(t.type))
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const credits = transactions
      .filter((t) => ['payment', 'deposit', 'refund', 'discount'].includes(t.type))
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const balanceDue = charges - credits;

    if (balanceDue > 0 && !force) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Outstanding balance must be settled before checkout',
        balance_due: balanceDue,
      });
    }

    await client.query(
      `UPDATE reservations SET status = 'checked_out', checked_out_at = now() WHERE id = $1`,
      [reservationId]
    );

    if (reservation.room_id) {
      await client.query(
        `UPDATE rooms SET occupancy_status = 'vacant', housekeeping_status = 'dirty' WHERE id = $1`,
        [reservation.room_id]
      );
      await client.query(
        `INSERT INTO room_status_log (room_id, field, old_value, new_value, changed_by)
         VALUES ($1, 'occupancy_status', 'occupied', 'vacant', $2)`,
        [reservation.room_id, recorded_by || null]
      );
      await client.query(
        `INSERT INTO room_status_log (room_id, field, old_value, new_value, changed_by)
         VALUES ($1, 'housekeeping_status', 'clean', 'dirty', $2)`,
        [reservation.room_id, recorded_by || null]
      );
    }

    await client.query('COMMIT');
    res.json({
      reservation_id: Number(reservationId),
      room_id: reservation.room_id,
      status: 'checked_out',
      balance_due: balanceDue,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to complete check-out' });
  } finally {
    client.release();
  }
});

// GET /api/checkout/:reservationId/gate-pass — a short printable departure confirmation,
// distinct from the full itemized invoice (see routes/invoices.js). Meant to be handed to
// the guest or shown at the gate as proof of a completed, settled checkout — not a bill.
// Only makes sense for reservations that have actually been checked out.
router.get('/:reservationId/gate-pass', async (req, res) => {
  const { reservationId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT res.*, rt.name AS room_type, rm.room_number, g.full_name
       FROM reservations res
       JOIN room_types rt ON rt.id = res.room_type_id
       JOIN guests g ON g.id = res.guest_id
       LEFT JOIN rooms rm ON rm.id = res.room_id
       WHERE res.id = $1`,
      [reservationId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });
    const r = rows[0];

    if (r.status !== 'checked_out') {
      return res.status(409).json({ error: `Reservation is '${r.status}' — a gate pass can only be printed after checkout is confirmed` });
    }

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `inline; filename=gate-pass-${r.reservation_code}.pdf`);
    doc.pipe(res);

    drawLetterhead(doc, 'Departure Confirmation');

    doc.fontSize(11);
    doc.text(`Reservation: ${r.reservation_code}`);
    doc.moveDown();

    doc.fontSize(12).text('Guest', { underline: true });
    doc.fontSize(11).text(r.full_name);
    doc.moveDown();

    doc.fontSize(12).text('Stay', { underline: true });
    doc.fontSize(11);
    doc.text(`Room: ${r.room_number || 'N/A'} (${r.room_type})`);
    doc.text(`Check-in: ${new Date(r.check_in_date).toLocaleDateString()}`);
    doc.text(`Check-out: ${new Date(r.check_out_date).toLocaleDateString()}`);
    doc.moveDown();

    doc.fontSize(11).fillColor('#2F4B3C').text('Status: Checked out — account settled in full', { underline: false });
    doc.fillColor('#000');
    if (r.checked_out_at) {
      doc.fontSize(10).fillColor('#555').text(`Departed: ${new Date(r.checked_out_at).toLocaleString()}`);
    }
    doc.fillColor('#000');
    doc.moveDown(2);

    doc.fontSize(9).fillColor('#777').text('This confirms the guest has completed check-out with no outstanding balance.', { align: 'center' });

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate gate pass' });
  }
});

module.exports = router;

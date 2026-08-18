const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { sendWhatsAppMessage } = require('../services/whatsapp');

// All guest notifications go out over WhatsApp, reusing the same Twilio setup as
// invoices (see services/whatsapp.js) — no separate email/SMS provider is configured.
// These are explicit actions the front desk triggers, not automatic side effects of
// creating a reservation or posting a payment, so nothing gets sent without a human
// choosing to send it.

// POST /api/notifications/:reservationId/booking-confirmation
router.post('/:reservationId/booking-confirmation', async (req, res) => {
  const { reservationId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT res.reservation_code, res.check_in_date, res.check_out_date, res.rate_per_night,
              g.full_name, g.phone, rt.name AS room_type
       FROM reservations res
       JOIN room_types rt ON rt.id = res.room_type_id
       JOIN guests g ON g.id = res.guest_id
       WHERE res.id = $1`,
      [reservationId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });
    const r = rows[0];
    if (!r.phone) return res.status(400).json({ error: 'This guest has no phone number on file' });

    const message =
      `Subla Camp — Booking Confirmed\n\n` +
      `Reservation: ${r.reservation_code}\n` +
      `Guest: ${r.full_name}\n` +
      `Room: ${r.room_type}\n` +
      `Check-in: ${new Date(r.check_in_date).toLocaleDateString()}\n` +
      `Check-out: ${new Date(r.check_out_date).toLocaleDateString()}\n` +
      `Rate: AED ${Number(r.rate_per_night).toFixed(2)}/night\n\n` +
      `We look forward to hosting you!`;

    await sendWhatsAppMessage(r.phone, message);
    res.json({ sent: true, to: r.phone });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to send booking confirmation' });
  }
});

// POST /api/notifications/:reservationId/payment-receipt/:transactionId
router.post('/:reservationId/payment-receipt/:transactionId', async (req, res) => {
  const { reservationId, transactionId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT ft.*, res.reservation_code, g.full_name, g.phone
       FROM folio_transactions ft
       JOIN reservations res ON res.id = ft.reservation_id
       JOIN guests g ON g.id = res.guest_id
       WHERE ft.id = $1 AND ft.reservation_id = $2`,
      [transactionId, reservationId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found for this reservation' });
    const t = rows[0];
    if (!['payment', 'deposit'].includes(t.type)) {
      return res.status(400).json({ error: 'This transaction is not a payment or deposit' });
    }
    if (!t.phone) return res.status(400).json({ error: 'This guest has no phone number on file' });

    const message =
      `Subla Camp — Payment Receipt\n\n` +
      `Reservation: ${t.reservation_code}\n` +
      `${t.description}\n` +
      `Amount: AED ${Number(t.amount).toFixed(2)}` +
      (t.payment_method ? ` (${t.payment_method})` : '') +
      (t.reference ? `\nReference: ${t.reference}` : '') +
      `\nDate: ${new Date(t.created_at).toLocaleString()}\n\n` +
      `Thank you!`;

    await sendWhatsAppMessage(t.phone, message);
    res.json({ sent: true, to: t.phone });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to send payment receipt' });
  }
});

// POST /api/notifications/:reservationId/custom — free-form guest communication
// e.g. "Your late check-out request has been approved."
router.post('/:reservationId/custom', async (req, res) => {
  const { reservationId } = req.params;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const { rows } = await pool.query(
      `SELECT g.phone FROM reservations res JOIN guests g ON g.id = res.guest_id WHERE res.id = $1`,
      [reservationId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });
    if (!rows[0].phone) return res.status(400).json({ error: 'This guest has no phone number on file' });

    await sendWhatsAppMessage(rows[0].phone, `Subla Camp: ${message}`);
    res.json({ sent: true, to: rows[0].phone });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to send message' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const pool = require('../db/pool');
const { sendWhatsAppMessage } = require('../services/whatsapp');
const { drawLetterhead, drawTermsAndConditions } = require('../services/pdf-letterhead');

// GET /api/invoices/:reservationId — streams a PDF invoice built from the reservation's folio.
// Works for any reservation status, but is intended to be called right after checkout.
router.get('/:reservationId', async (req, res) => {
  const { reservationId } = req.params;

  try {
    const { rows: reservationRows } = await pool.query(
      `SELECT res.*, rt.name AS room_type, rm.room_number, g.full_name, g.phone, g.email
       FROM reservations res
       JOIN room_types rt ON rt.id = res.room_type_id
       JOIN guests g ON g.id = res.guest_id
       LEFT JOIN rooms rm ON rm.id = res.room_id
       WHERE res.id = $1`,
      [reservationId]
    );
    if (!reservationRows.length) return res.status(404).json({ error: 'Reservation not found' });
    const r = reservationRows[0];

    const { rows: transactions } = await pool.query(
      `SELECT * FROM folio_transactions WHERE reservation_id = $1 ORDER BY created_at`,
      [reservationId]
    );

    const charges = transactions.filter((t) => ['room_charge', 'extra_charge', 'pay_out'].includes(t.type));
    const credits = transactions.filter((t) => ['payment', 'deposit', 'refund', 'discount'].includes(t.type));
    const totalCharges = charges.reduce((sum, t) => sum + Number(t.amount), 0);
    const totalCredits = credits.reduce((sum, t) => sum + Number(t.amount), 0);
    const balance = totalCharges - totalCredits;

    // --- Build the PDF ---
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=invoice-${r.reservation_code}.pdf`);
    doc.pipe(res);

    drawLetterhead(doc, 'Guest Invoice');

    doc.fontSize(11);
    doc.text(`Invoice for reservation ${r.reservation_code}`);
    doc.text(`Issued: ${new Date().toLocaleDateString()}`);
    doc.moveDown();

    doc.fontSize(12).text('Guest', { underline: true });
    doc.fontSize(11);
    doc.text(r.full_name);
    if (r.phone) doc.text(r.phone);
    if (r.email) doc.text(r.email);
    doc.moveDown();

    doc.fontSize(12).text('Stay Details', { underline: true });
    doc.fontSize(11);
    doc.text(`Room: ${r.room_number || 'N/A'} (${r.room_type})`);
    doc.text(`Check-in: ${new Date(r.check_in_date).toLocaleDateString()}`);
    doc.text(`Check-out: ${new Date(r.check_out_date).toLocaleDateString()}`);
    doc.moveDown();

    doc.fontSize(12).text('Charges', { underline: true });
    doc.fontSize(11);
    charges.forEach((c) => {
      doc.text(`${c.description}`, { continued: true });
      doc.text(`  AED ${Number(c.amount).toFixed(2)}`, { align: 'right' });
    });
    doc.moveDown(0.5);

    doc.fontSize(12).text('Payments & Credits', { underline: true });
    doc.fontSize(11);
    credits.forEach((c) => {
      const label = c.payment_method ? `${c.description} (${c.payment_method})` : c.description;
      doc.text(label, { continued: true });
      doc.text(`  -AED ${Number(c.amount).toFixed(2)}`, { align: 'right' });
    });
    doc.moveDown();

    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fontSize(11).text(`Total charges: AED ${totalCharges.toFixed(2)}`, { align: 'right' });
    doc.text(`Total paid: AED ${totalCredits.toFixed(2)}`, { align: 'right' });
    doc.fontSize(13).text(`Balance: AED ${balance.toFixed(2)}`, { align: 'right' });

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#777').text('Thank you for staying with Subla Camp.', { align: 'center' });

    const { rows: termsRows } = await pool.query(`SELECT value FROM settings WHERE key = 'terms_and_conditions'`);
    drawTermsAndConditions(doc, termsRows[0]?.value);

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate invoice' });
  }
});

// POST /api/invoices/:reservationId/send-whatsapp — sends a text summary of the bill
// to the guest's phone via WhatsApp, plus a link to the PDF invoice.
// Reuses the same Twilio WhatsApp setup already running for Subla Tea's stock alerts,
// rather than standing up a separate email service just for this.
// Requires BASE_URL to be set (the public URL this API is deployed at) so the link resolves.
router.post('/:reservationId/send-whatsapp', async (req, res) => {
  const { reservationId } = req.params;

  try {
    const { rows: reservationRows } = await pool.query(
      `SELECT res.reservation_code, res.check_in_date, res.check_out_date,
              g.full_name, g.phone, rt.name AS room_type
       FROM reservations res
       JOIN room_types rt ON rt.id = res.room_type_id
       JOIN guests g ON g.id = res.guest_id
       WHERE res.id = $1`,
      [reservationId]
    );
    if (!reservationRows.length) return res.status(404).json({ error: 'Reservation not found' });
    const r = reservationRows[0];

    if (!r.phone) {
      return res.status(400).json({ error: 'This guest has no phone number on file' });
    }

    const { rows: transactions } = await pool.query(
      `SELECT type, amount FROM folio_transactions WHERE reservation_id = $1`,
      [reservationId]
    );
    const charges = transactions
      .filter((t) => ['room_charge', 'extra_charge', 'pay_out'].includes(t.type))
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const credits = transactions
      .filter((t) => ['payment', 'deposit', 'refund', 'discount'].includes(t.type))
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const balance = charges - credits;

    const invoiceUrl = process.env.BASE_URL
      ? `${process.env.BASE_URL}/api/invoices/${reservationId}`
      : null;

    const message =
      `Subla Camp — Invoice for ${r.reservation_code}\n\n` +
      `Guest: ${r.full_name}\n` +
      `Room: ${r.room_type}\n` +
      `Stay: ${new Date(r.check_in_date).toLocaleDateString()} – ${new Date(r.check_out_date).toLocaleDateString()}\n\n` +
      `Total charges: AED ${charges.toFixed(2)}\n` +
      `Total paid: AED ${credits.toFixed(2)}\n` +
      `Balance: AED ${balance.toFixed(2)}\n` +
      (invoiceUrl ? `\nFull invoice: ${invoiceUrl}` : '') +
      `\n\nThank you for staying with us!`;

    await sendWhatsAppMessage(r.phone, message);
    res.json({ sent: true, to: r.phone });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to send invoice via WhatsApp' });
  }
});

module.exports = router;

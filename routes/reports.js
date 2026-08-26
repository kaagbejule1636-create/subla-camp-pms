const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const PDFDocument = require('pdfkit');
const { requireRole } = require('../middleware/auth');
const { drawLetterhead } = require('../services/pdf-letterhead');

router.use(requireRole('manager'));


// GET /api/reports/occupancy?start=2026-08-01&end=2026-08-31
// Daily occupancy % across a date range, derived from checked_in reservations overlapping each date
// (not just current room state — so this works for past dates too, unlike a live room-status query).
router.get('/occupancy', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end are required' });

  try {
    const { rows: totalRoomsRow } = await pool.query('SELECT COUNT(*) FROM rooms');
    const totalRooms = Number(totalRoomsRow[0].count);

    const { rows } = await pool.query(
      `SELECT d::date AS date,
              COUNT(res.id) AS occupied_rooms
       FROM generate_series($1::date, $2::date, '1 day') d
       LEFT JOIN reservations res
         ON res.status IN ('checked_in', 'checked_out')
         AND res.check_in_date <= d::date
         AND res.check_out_date > d::date
       GROUP BY d
       ORDER BY d`,
      [start, end]
    );

    const days = rows.map((r) => ({
      date: r.date,
      occupied_rooms: Number(r.occupied_rooms),
      total_rooms: totalRooms,
      occupancy_pct: totalRooms > 0 ? Math.round((Number(r.occupied_rooms) / totalRooms) * 1000) / 10 : 0,
    }));

    const avgOccupancy = days.length
      ? Math.round((days.reduce((s, d) => s + d.occupancy_pct, 0) / days.length) * 10) / 10
      : 0;

    res.json({ start, end, total_rooms: totalRooms, average_occupancy_pct: avgOccupancy, days });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build occupancy report' });
  }
});

// GET /api/reports/revenue?start=2026-08-01&end=2026-08-31
// Revenue breakdown by transaction type over a date range, plus a daily series for charting.
router.get('/revenue', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end are required' });

  try {
    const { rows: byType } = await pool.query(
      `SELECT type, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM folio_transactions
       WHERE created_at::date BETWEEN $1 AND $2
       GROUP BY type`,
      [start, end]
    );

    const { rows: daily } = await pool.query(
      `SELECT d::date AS date,
              COALESCE(SUM(CASE WHEN ft.type = 'room_charge' THEN ft.amount ELSE 0 END), 0) AS room_revenue,
              COALESCE(SUM(CASE WHEN ft.type = 'extra_charge' THEN ft.amount ELSE 0 END), 0) AS extra_revenue,
              COALESCE(SUM(CASE WHEN ft.type IN ('payment','deposit') THEN ft.amount ELSE 0 END), 0) AS collected
       FROM generate_series($1::date, $2::date, '1 day') d
       LEFT JOIN folio_transactions ft ON ft.created_at::date = d::date
       GROUP BY d
       ORDER BY d`,
      [start, end]
    );

    const totals = byType.reduce((acc, row) => {
      acc[row.type] = { total: Number(row.total), count: Number(row.count) };
      return acc;
    }, {});
    // Room and extra charges are earned revenue. Pay-outs (module 37) are intentionally
    // excluded here — they're cash disbursed on a guest's behalf and reimbursed via their
    // folio, not revenue the property earned — but they're still visible in `by_type` below
    // for cash reconciliation.
    const totalRevenue = (totals.room_charge?.total || 0) + (totals.extra_charge?.total || 0);

    res.json({
      start,
      end,
      total_revenue: totalRevenue,
      payouts_total: totals.pay_out?.total || 0,
      by_type: totals,
      daily: daily.map((d) => ({
        date: d.date,
        room_revenue: Number(d.room_revenue),
        extra_revenue: Number(d.extra_revenue),
        collected: Number(d.collected),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build revenue report' });
  }
});

// GET /api/reports/cashier-shift?recorded_by=K.Abolaji&start=2026-08-17T06:00:00Z&end=2026-08-17T14:00:00Z
// End-of-shift accountability: every transaction a given operator handled in a time window,
// broken down by payment method, so cash on hand can be reconciled against the system total.
router.get('/cashier-shift', async (req, res) => {
  const { recorded_by, start, end } = req.query;
  if (!recorded_by || !start || !end) {
    return res.status(400).json({ error: 'recorded_by, start, and end are required' });
  }

  try {
    const { rows: transactions } = await pool.query(
      `SELECT ft.*, res.reservation_code
       FROM folio_transactions ft
       JOIN reservations res ON res.id = ft.reservation_id
       WHERE ft.recorded_by = $1 AND ft.created_at BETWEEN $2 AND $3
       ORDER BY ft.created_at`,
      [recorded_by, start, end]
    );

    const byMethod = {};
    let totalCollected = 0;
    transactions
      .filter((t) => ['payment', 'deposit'].includes(t.type))
      .forEach((t) => {
        const method = t.payment_method || 'unspecified';
        byMethod[method] = (byMethod[method] || 0) + Number(t.amount);
        totalCollected += Number(t.amount);
      });

    res.json({
      recorded_by,
      start,
      end,
      transaction_count: transactions.length,
      total_collected: totalCollected,
      by_payment_method: byMethod,
      transactions,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build cashier shift report' });
  }
});

// GET /api/reports/cashbook?start=&end= — a running cash ledger, auto-compiled from real
// transactions instead of manually re-entered into a spreadsheet. Only actual cash
// movements count: guest payments and deposits (in), refunds and drawer pay-outs (out),
// and recorded expenses (out). Room charges and other folio entries that don't represent
// money actually changing hands are deliberately excluded — this is a cash position, not
// a revenue report (see /revenue for that).
//
// Carries forward a real opening balance from everything before the period, the way a
// physical cashbook does, rather than resetting to zero every time someone picks a date
// range — otherwise the running balance shown wouldn't mean anything.
//
// Shared by both the JSON endpoint and the printable PDF, so the two can never drift apart
// from computing the numbers differently.
async function buildCashbook(start, end) {
  const { rows: openingRows } = await pool.query(
    `SELECT COALESCE(SUM(
       CASE WHEN type IN ('payment','deposit') THEN amount ELSE -amount END
     ), 0) AS total
     FROM folio_transactions
     WHERE type IN ('payment','deposit','refund','pay_out') AND created_at::date < $1`,
    [start]
  );
  const { rows: openingExpenseRows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE expense_date < $1`,
    [start]
  );
  const openingBalance = Number(openingRows[0].total) - Number(openingExpenseRows[0].total);

  const { rows: entries } = await pool.query(
    `SELECT ts, description, signed_amount, direction, source, reservation_code, expense_id FROM (
       SELECT ft.created_at AS ts, ft.description,
              CASE WHEN ft.type IN ('payment','deposit') THEN ft.amount ELSE -ft.amount END AS signed_amount,
              CASE WHEN ft.type IN ('payment','deposit') THEN 'in' ELSE 'out' END AS direction,
              'guest' AS source, r.reservation_code, NULL::INTEGER AS expense_id
       FROM folio_transactions ft
       JOIN reservations r ON r.id = ft.reservation_id
       WHERE ft.type IN ('payment','deposit','refund','pay_out')
         AND ft.created_at::date BETWEEN $1 AND $2

       UNION ALL

       SELECT e.created_at AS ts, e.description, -e.amount AS signed_amount,
              'out' AS direction, 'expense' AS source, NULL AS reservation_code, e.id AS expense_id
       FROM expenses e
       WHERE e.expense_date BETWEEN $1 AND $2
     ) combined
     ORDER BY ts ASC`,
    [start, end]
  );

  let running = openingBalance;
  const ledger = entries.map((row) => {
    running += Number(row.signed_amount);
    return {
      date: row.ts,
      description: row.description,
      direction: row.direction,
      amount: Math.abs(Number(row.signed_amount)),
      source: row.source,
      reservation_code: row.reservation_code,
      expense_id: row.expense_id,
      running_balance: running,
    };
  });

  const totalIn = ledger.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount, 0);
  const totalOut = ledger.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount, 0);

  return { start, end, opening_balance: openingBalance, closing_balance: running, total_in: totalIn, total_out: totalOut, entries: ledger };
}

router.get('/cashbook', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end are required' });

  try {
    res.json(await buildCashbook(start, end));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build cashbook' });
  }
});

// GET /api/reports/cashbook/print?start=&end= — printable PDF version of the same ledger.
router.get('/cashbook/print', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end are required' });

  try {
    const cb = await buildCashbook(start, end);

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=cashbook-${start}-to-${end}.pdf`);
    doc.pipe(res);

    drawLetterhead(doc, 'Cashbook');
    doc.fontSize(10).fillColor('#555').text(`Period: ${start} to ${end}`);
    doc.fillColor('#000');
    doc.moveDown();

    doc.fontSize(10);
    doc.text(`Opening balance: AED ${cb.opening_balance.toFixed(2)}`);
    doc.text(`Total in: AED ${cb.total_in.toFixed(2)}`);
    doc.text(`Total out: AED ${cb.total_out.toFixed(2)}`);
    doc.fontSize(11).text(`Closing balance: AED ${cb.closing_balance.toFixed(2)}`);
    doc.moveDown();

    const colX = { date: 50, desc: 130, source: 320, in: 390, out: 460, balance: 500 };
    doc.fontSize(9).fillColor('#555');
    doc.text('Date', colX.date, doc.y);
    doc.text('Description', colX.desc, doc.y - doc.currentLineHeight());
    doc.text('Source', colX.source, doc.y - doc.currentLineHeight());
    doc.text('In/Out', colX.in, doc.y - doc.currentLineHeight());
    doc.text('Balance', colX.balance, doc.y - doc.currentLineHeight());
    doc.x = 50;
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    doc.fontSize(8.5).fillColor('#000');
    cb.entries.forEach((e) => {
      const rowY = doc.y;
      const desc = e.description + (e.reservation_code ? ` (${e.reservation_code})` : '');
      doc.fillColor('#000').text(new Date(e.date).toLocaleDateString(), colX.date, rowY);
      doc.text(desc, colX.desc, rowY, { width: 180 });
      doc.text(e.source, colX.source, rowY);
      doc.fillColor(e.direction === 'in' ? '#5C8A5A' : '#C1392B')
        .text(`${e.direction === 'in' ? '+' : '-'}AED ${e.amount.toFixed(2)}`, colX.in, rowY);
      doc.fillColor('#000').text(`AED ${e.running_balance.toFixed(2)}`, colX.balance, rowY);
      doc.moveDown(0.5);
    });
    doc.x = 50;

    if (cb.entries.length === 0) {
      doc.fontSize(10).fillColor('#555').text('No cash movements in this period.');
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate cashbook PDF' });
  }
});

module.exports = router;

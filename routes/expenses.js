const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const PDFDocument = require('pdfkit');
const { requireRole } = require('../middleware/auth');
const { resolvePaymentAmount } = require('../services/currency');
const { drawLetterhead, formatCalendarDate } = require('../services/pdf-letterhead');

const VALID_CATEGORIES = ['utilities', 'salaries', 'supplies', 'maintenance', 'marketing', 'other'];

// POST /api/expenses — record an expense (supervisor+, since this is financial data)
router.post('/', requireRole('supervisor'), async (req, res) => {
  const { category, description, amount, currency, payment_method, vendor, reference, expense_date } = req.body;
  if (!category || !description || !amount) {
    return res.status(400).json({ error: 'category, description, and amount are required' });
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of ${VALID_CATEGORIES.join(', ')}` });
  }

  try {
    const resolved = await resolvePaymentAmount(pool, amount, currency);
    const { rows } = await pool.query(
      `INSERT INTO expenses
        (category, description, amount, currency, exchange_rate, original_amount,
         payment_method, vendor, reference, expense_date, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        category, description, resolved.amount, resolved.currency, resolved.exchange_rate,
        resolved.original_amount, payment_method || null, vendor || null, reference || null,
        expense_date || new Date().toISOString().slice(0, 10), req.user.username,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to record expense' });
  }
});

// GET /api/expenses?category=&start=&end= — list/filter (supervisor+)
router.get('/', requireRole('supervisor'), async (req, res) => {
  const { category, start, end } = req.query;
  const conditions = [];
  const values = [];

  if (category) {
    values.push(category);
    conditions.push(`category = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`expense_date >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`expense_date <= $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT * FROM expenses ${where} ORDER BY expense_date DESC, created_at DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load expenses' });
  }
});

// GET /api/expenses/summary?start=&end= — totals by category, for reports (manager only,
// same gating as reports.js — this is property-wide financial data)
router.get('/summary', requireRole('manager'), async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end are required' });

  try {
    const { rows: byCategory } = await pool.query(
      `SELECT category, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM expenses WHERE expense_date BETWEEN $1 AND $2
       GROUP BY category ORDER BY total DESC`,
      [start, end]
    );
    const totalExpenses = byCategory.reduce((sum, row) => sum + Number(row.total), 0);

    res.json({
      start,
      end,
      total_expenses: totalExpenses,
      by_category: byCategory.map((row) => ({
        category: row.category,
        total: Number(row.total),
        count: Number(row.count),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build expense summary' });
  }
});

// GET /api/expenses/print?start=&end=&category= — printable PDF listing (supervisor+,
// matching who can view the list at all). Same letterhead/table pattern as the other
// report PDFs.
router.get('/print', requireRole('supervisor'), async (req, res) => {
  const { start, end, category } = req.query;
  const conditions = [];
  const values = [];
  if (category) { values.push(category); conditions.push(`category = $${values.length}`); }
  if (start) { values.push(start); conditions.push(`expense_date >= $${values.length}`); }
  if (end) { values.push(end); conditions.push(`expense_date <= $${values.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows: expenseRows } = await pool.query(
      `SELECT * FROM expenses ${where} ORDER BY expense_date ASC, created_at ASC`,
      values
    );
    const total = expenseRows.reduce((s, e) => s + Number(e.amount), 0);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=expenses-${new Date().toISOString().slice(0, 10)}.pdf`);
    doc.pipe(res);

    drawLetterhead(doc, 'Expenses');
    doc.fontSize(10).fillColor('#555');
    doc.text(`Period: ${start || 'all time'} to ${end || 'present'}${category ? ` · Category: ${category}` : ''}`);
    doc.fillColor('#000');
    doc.moveDown();

    const colX = { date: 50, category: 130, desc: 230, vendor: 380, amount: 480 };
    doc.fontSize(9).fillColor('#555');
    doc.text('Date', colX.date, doc.y);
    doc.text('Category', colX.category, doc.y - doc.currentLineHeight());
    doc.text('Description', colX.desc, doc.y - doc.currentLineHeight());
    doc.text('Vendor', colX.vendor, doc.y - doc.currentLineHeight());
    doc.text('Amount', colX.amount, doc.y - doc.currentLineHeight());
    doc.x = 50;
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    doc.fontSize(9.5).fillColor('#000');
    expenseRows.forEach((e) => {
      const rowY = doc.y;
      doc.text(formatCalendarDate(e.expense_date), colX.date, rowY);
      doc.text(e.category, colX.category, rowY, { width: 95 });
      doc.text(e.description, colX.desc, rowY, { width: 145 });
      doc.text(e.vendor || '—', colX.vendor, rowY, { width: 95 });
      doc.text(`AED ${Number(e.amount).toFixed(2)}`, colX.amount, rowY);
      doc.moveDown(0.5);
    });
    doc.x = 50;

    if (expenseRows.length === 0) {
      doc.fontSize(10).fillColor('#555').text('No expenses in this period.');
    } else {
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.3);
      doc.fontSize(11).fillColor('#000').text(`Total: AED ${total.toFixed(2)}`, { align: 'right' });
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate expenses report' });
  }
});

// PATCH /api/expenses/:id — correct a mistake (wrong amount, category, typo). Supervisor+,
// matching who can record one in the first place. This is safe to allow because expenses
// are the property's own internal records — unlike a guest folio entry, there's no printed
// receipt or invoice elsewhere in the system that could end up disagreeing with it.
router.patch('/:id', requireRole('supervisor'), async (req, res) => {
  const { id } = req.params;
  const { category, description, amount, currency, payment_method, vendor, reference, expense_date } = req.body;
  if (category && !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of ${VALID_CATEGORIES.join(', ')}` });
  }

  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
    if (!existingRows.length) return res.status(404).json({ error: 'Expense not found' });
    const existing = existingRows[0];

    let resolvedAmount = existing.amount, resolvedCurrency = existing.currency,
      resolvedRate = existing.exchange_rate, resolvedOriginal = existing.original_amount;
    if (amount !== undefined) {
      const resolved = await resolvePaymentAmount(pool, amount, currency || existing.currency);
      resolvedAmount = resolved.amount;
      resolvedCurrency = resolved.currency;
      resolvedRate = resolved.exchange_rate;
      resolvedOriginal = resolved.original_amount;
    }

    const { rows } = await pool.query(
      `UPDATE expenses SET
         category = $1, description = $2, amount = $3, currency = $4, exchange_rate = $5,
         original_amount = $6, payment_method = $7, vendor = $8, reference = $9, expense_date = $10
       WHERE id = $11 RETURNING *`,
      [
        category || existing.category, description || existing.description, resolvedAmount,
        resolvedCurrency, resolvedRate, resolvedOriginal, payment_method ?? existing.payment_method,
        vendor ?? existing.vendor, reference ?? existing.reference, expense_date || existing.expense_date, id,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to update expense' });
  }
});

// DELETE /api/expenses/:id — manager only. Deletion is more destructive than a correction
// (the record is just gone, with no trace of what it used to say), so this sits one level
// higher than editing — a supervisor can fix a typo, but removing a financial record
// entirely needs manager sign-off.
router.delete('/:id', requireRole('manager'), async (req, res) => {
  const { rows } = await pool.query('DELETE FROM expenses WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
  res.json({ deleted: true, id: rows[0].id });
});

module.exports = router;

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { resolvePaymentAmount } = require('../services/currency');

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

module.exports = router;

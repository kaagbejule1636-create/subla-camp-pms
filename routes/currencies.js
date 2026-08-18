const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');

// GET /api/currencies — list configured currencies and their rate to base (AED)
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM currencies ORDER BY code');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load currencies' });
  }
});

// POST /api/currencies — add or update a currency's exchange rate (supervisor+)
// rate_to_base = how many AED one unit of this currency is worth, e.g. USD -> 3.6725
router.post('/', requireRole('supervisor'), async (req, res) => {
  const { code, name, rate_to_base } = req.body;
  if (!code || !name || !rate_to_base) {
    return res.status(400).json({ error: 'code, name, and rate_to_base are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO currencies (code, name, rate_to_base, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (code) DO UPDATE SET name = $2, rate_to_base = $3, updated_at = now()
       RETURNING *`,
      [code.toUpperCase(), name, rate_to_base]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save currency' });
  }
});

module.exports = router;

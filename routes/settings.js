const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { DEFAULT_TERMS_AND_CONDITIONS } = require('../services/pdf-letterhead');

// GET /api/settings/terms-and-conditions — any logged-in user can view (it's shown on
// printed documents everyone uses), falls back to the built-in default text if nothing's
// been saved yet, so this never 404s on a fresh install.
router.get('/terms-and-conditions', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT value, updated_at, updated_by FROM settings WHERE key = 'terms_and_conditions'`);
    if (rows.length) return res.json(rows[0]);
    res.json({ value: DEFAULT_TERMS_AND_CONDITIONS, updated_at: null, updated_by: null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load terms & conditions' });
  }
});

// PUT /api/settings/terms-and-conditions — manager-only, since this is legal-ish text
// that appears on every printed guest document.
router.put('/terms-and-conditions', requireRole('manager'), async (req, res) => {
  const { value } = req.body;
  if (!value || !value.trim()) return res.status(400).json({ error: 'value is required' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO settings (key, value, updated_by)
       VALUES ('terms_and_conditions', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()
       RETURNING value, updated_at, updated_by`,
      [value.trim(), req.user.username]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save terms & conditions' });
  }
});

module.exports = router;

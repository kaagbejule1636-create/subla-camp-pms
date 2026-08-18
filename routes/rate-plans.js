const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');

// GET /api/rate-plans?room_type_id=1 — list plans (all, or filtered to one room type)
router.get('/', async (req, res) => {
  const { room_type_id } = req.query;
  try {
    const { rows } = await pool.query(
      room_type_id
        ? `SELECT rp.*, rt.name AS room_type_name FROM rate_plans rp
           JOIN room_types rt ON rt.id = rp.room_type_id
           WHERE rp.room_type_id = $1 ORDER BY rp.priority DESC, rp.name`
        : `SELECT rp.*, rt.name AS room_type_name FROM rate_plans rp
           JOIN room_types rt ON rt.id = rp.room_type_id
           ORDER BY rp.room_type_id, rp.priority DESC, rp.name`,
      room_type_id ? [room_type_id] : []
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load rate plans' });
  }
});

// POST /api/rate-plans — create a new rate plan
// e.g. { room_type_id, name: 'Weekend', rate: 550, days_of_week: [5,6], priority: 10 }
// e.g. { room_type_id, name: 'Summer Season', rate: 600, start_date, end_date, priority: 5 }
router.post('/', requireRole('supervisor'), async (req, res) => {
  const { room_type_id, name, rate, start_date, end_date, days_of_week, priority } = req.body;
  if (!room_type_id || !name || rate === undefined) {
    return res.status(400).json({ error: 'room_type_id, name, and rate are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO rate_plans (room_type_id, name, rate, start_date, end_date, days_of_week, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [room_type_id, name, rate, start_date || null, end_date || null, days_of_week || null, priority || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create rate plan' });
  }
});

// PATCH /api/rate-plans/:id — update rate, dates, priority, or deactivate
router.patch('/:id', requireRole('supervisor'), async (req, res) => {
  const { id } = req.params;
  const fields = ['name', 'rate', 'start_date', 'end_date', 'days_of_week', 'priority', 'active'];
  const updates = [];
  const values = [];

  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      values.push(req.body[f]);
      updates.push(`${f} = $${values.length}`);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'No updatable fields provided' });

  values.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE rate_plans SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Rate plan not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update rate plan' });
  }
});

// GET /api/rate-plans/quote?room_type_id=1&check_in=2026-08-17&check_out=2026-08-19
// Resolves the applicable rate for each night of the stay (highest-priority matching plan wins,
// falling back to the room type's base_rate if nothing matches) and returns a per-night breakdown + total.
router.get('/quote', async (req, res) => {
  const { room_type_id, check_in, check_out } = req.query;
  if (!room_type_id || !check_in || !check_out) {
    return res.status(400).json({ error: 'room_type_id, check_in, and check_out are required' });
  }

  try {
    const { rows: roomTypeRows } = await pool.query('SELECT * FROM room_types WHERE id = $1', [room_type_id]);
    if (!roomTypeRows.length) return res.status(404).json({ error: 'Room type not found' });
    const baseRate = Number(roomTypeRows[0].base_rate);

    const { rows: plans } = await pool.query(
      `SELECT * FROM rate_plans WHERE room_type_id = $1 AND active = TRUE`,
      [room_type_id]
    );

    const nights = [];
    let cursor = new Date(check_in);
    const end = new Date(check_out);

    while (cursor < end) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const dow = cursor.getDay(); // 0=Sunday..6=Saturday

      const applicable = plans.filter((p) => {
        if (p.start_date && dateStr < p.start_date.toISOString().slice(0, 10)) return false;
        if (p.end_date && dateStr > p.end_date.toISOString().slice(0, 10)) return false;
        if (p.days_of_week && !p.days_of_week.includes(dow)) return false;
        return true;
      });

      applicable.sort((a, b) => b.priority - a.priority || Number(b.rate) - Number(a.rate));
      const chosen = applicable[0];

      nights.push({
        date: dateStr,
        rate: chosen ? Number(chosen.rate) : baseRate,
        rate_plan: chosen ? chosen.name : 'Standard (base rate)',
      });

      cursor.setDate(cursor.getDate() + 1);
    }

    const total = nights.reduce((sum, n) => sum + n.rate, 0);

    res.json({
      room_type_id: Number(room_type_id),
      check_in,
      check_out,
      nights,
      total,
      average_nightly_rate: nights.length ? Math.round((total / nights.length) * 100) / 100 : 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build quote' });
  }
});

module.exports = router;

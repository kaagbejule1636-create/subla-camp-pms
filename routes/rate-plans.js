const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { resolveRange } = require('../services/rate-resolver');
const { scheduleRoomTypeRates } = require('../services/channex-sync');

// A rate plan's own dates are both-inclusive (start_date to end_date means "applies on
// every one of those days, end_date included") — but computeDailyRates and every other
// range function in this codebase use an exclusive end, the same convention a
// reservation's check_out_date already follows (the night of checkout itself isn't
// occupied). A plan spanning a single day (start_date === end_date) would otherwise
// produce a range whose end is not actually after its start, and the per-date computation
// would silently walk zero nights. Adding one day converts the plan's inclusive end into
// the exclusive bound the rest of the pipeline expects.
function syncRangeForPlan(plan) {
  const toDateStr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
  const from = plan.start_date ? toDateStr(plan.start_date) : new Date().toISOString().slice(0, 10);
  const to = plan.end_date
    ? new Date(new Date(plan.end_date).getTime() + 86400000).toISOString().slice(0, 10)
    : new Date(Date.now() + 500 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

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
// e.g. { room_type_id, name: 'Closed for maintenance', stop_sell: true, start_date, end_date }
//      — rate is optional: a plan can carry only restrictions and no price override.
router.post('/', requireRole('supervisor'), async (req, res) => {
  const {
    room_type_id, name, rate, start_date, end_date, days_of_week, priority,
    min_stay, max_stay, stop_sell, closed_to_arrival, closed_to_departure,
  } = req.body;
  if (!room_type_id || !name) {
    return res.status(400).json({ error: 'room_type_id and name are required' });
  }
  if (min_stay != null && max_stay != null && Number(max_stay) < Number(min_stay)) {
    return res.status(400).json({ error: 'max_stay cannot be less than min_stay' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO rate_plans
        (room_type_id, name, rate, start_date, end_date, days_of_week, priority,
         min_stay, max_stay, stop_sell, closed_to_arrival, closed_to_departure)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        room_type_id, name, rate ?? null, start_date || null, end_date || null,
        days_of_week || null, priority || 0, min_stay ?? null, max_stay ?? null,
        stop_sell || false, closed_to_arrival || false, closed_to_departure || false,
      ]
    );
    res.status(201).json(rows[0]);

    // Best-effort, errors handled inside the scheduler itself — a new plan changes what
    // Channex should be showing for its date range, whether or not it happens to include a
    // price change (a restriction-only plan still needs the OTA told about it).
    const { from, to } = syncRangeForPlan(rows[0]);
    scheduleRoomTypeRates(room_type_id, from, to);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create rate plan' });
  }
});

// PATCH /api/rate-plans/:id — update any field, including the restriction fields, or
// deactivate a plan entirely
router.patch('/:id', requireRole('supervisor'), async (req, res) => {
  const { id } = req.params;
  const fields = [
    'name', 'rate', 'start_date', 'end_date', 'days_of_week', 'priority', 'active',
    'min_stay', 'max_stay', 'stop_sell', 'closed_to_arrival', 'closed_to_departure',
  ];
  const updates = [];
  const values = [];

  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      values.push(req.body[f]);
      updates.push(`${f} = $${values.length}`);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'No updatable fields provided' });

  const effectiveMinStay = req.body.min_stay !== undefined ? req.body.min_stay : undefined;
  const effectiveMaxStay = req.body.max_stay !== undefined ? req.body.max_stay : undefined;
  if (effectiveMinStay != null && effectiveMaxStay != null && Number(effectiveMaxStay) < Number(effectiveMinStay)) {
    return res.status(400).json({ error: 'max_stay cannot be less than min_stay' });
  }

  values.push(id);
  try {
    const { rows: beforeRows } = await pool.query('SELECT * FROM rate_plans WHERE id = $1', [id]);
    const { rows } = await pool.query(
      `UPDATE rate_plans SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Rate plan not found' });
    res.json(rows[0]);

    // Best-effort, errors handled inside the scheduler itself. If the date range itself
    // changed (not just the price or restrictions), both the plan's old coverage (which
    // needs reverting to whatever now applies there) and its new coverage need pushing —
    // so this syncs the wider of the two, same reasoning as a reservation's stay change.
    if (beforeRows.length) {
      const before = syncRangeForPlan(beforeRows[0]);
      const after = syncRangeForPlan(rows[0]);
      const from = before.from < after.from ? before.from : after.from;
      const to = before.to > after.to ? before.to : after.to;
      scheduleRoomTypeRates(rows[0].room_type_id, from, to);
    }
  } catch (err) {
    console.error(err);
    if (err.code === '23514') return res.status(400).json({ error: 'max_stay cannot be less than min_stay' });
    res.status(500).json({ error: 'Failed to update rate plan' });
  }
});

// GET /api/rate-plans/quote?room_type_id=1&check_in=2026-08-17&check_out=2026-08-19
// Resolves the applicable rate AND restrictions for each night of the stay (highest-priority
// matching plan wins, falling back to the room type's base_rate and no restrictions if nothing
// matches) and returns a per-night breakdown + total. Uses the same resolver the Channex ARI
// push uses, so a quote shown to staff can never silently disagree with what gets sent to OTAs.
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

    const nights = resolveRange(plans, baseRate, check_in, check_out);
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


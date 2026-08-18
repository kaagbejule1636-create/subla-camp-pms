const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');

// Builds today's summary numbers. Shared by preview and close so what you review
// is exactly what gets stored.
async function buildSummary(client, businessDate) {
  const { rows: arrivals } = await client.query(
    `SELECT COUNT(*) FROM reservations WHERE check_in_date = $1 AND status = 'checked_in'`,
    [businessDate]
  );
  const { rows: stillExpected } = await client.query(
    `SELECT COUNT(*) FROM reservations WHERE check_in_date = $1 AND status = 'confirmed'`,
    [businessDate]
  );
  const { rows: departures } = await client.query(
    `SELECT COUNT(*) FROM reservations WHERE check_out_date = $1 AND status = 'checked_out'`,
    [businessDate]
  );
  const { rows: roomRevenue } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM folio_transactions
     WHERE type = 'room_charge' AND created_at::date = $1`,
    [businessDate]
  );
  const { rows: extraRevenue } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM folio_transactions
     WHERE type = 'extra_charge' AND created_at::date = $1`,
    [businessDate]
  );
  const { rows: payments } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM folio_transactions
     WHERE type IN ('payment', 'deposit') AND created_at::date = $1`,
    [businessDate]
  );
  const { rows: occupied } = await client.query(
    `SELECT COUNT(*) FROM rooms WHERE occupancy_status = 'occupied'`
  );
  const { rows: totalRooms } = await client.query(`SELECT COUNT(*) FROM rooms`);

  return {
    business_date: businessDate,
    arrivals: Number(arrivals[0].count),
    expected_but_not_arrived: Number(stillExpected[0].count), // these become no-shows on close
    departures: Number(departures[0].count),
    room_revenue: Number(roomRevenue[0].total),
    extra_revenue: Number(extraRevenue[0].total),
    payments_total: Number(payments[0].total),
    occupied_rooms: Number(occupied[0].count),
    total_rooms: Number(totalRooms[0].count),
    occupancy_pct: totalRooms[0].count > 0
      ? Math.round((Number(occupied[0].count) / Number(totalRooms[0].count)) * 1000) / 10
      : 0,
  };
}

// GET /api/night-audit/preview?date=2026-08-17 (defaults to today)
// Review-before-you-close: shows the numbers and flags reservations that will
// become no-shows if the day is closed now.
router.get('/preview', async (req, res) => {
  const businessDate = req.query.date || new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    const summary = await buildSummary(client, businessDate);

    const { rows: pendingNoShows } = await client.query(
      `SELECT res.id, res.reservation_code, g.full_name
       FROM reservations res JOIN guests g ON g.id = res.guest_id
       WHERE res.check_in_date = $1 AND res.status = 'confirmed'`,
      [businessDate]
    );

    const { rows: existing } = await client.query(
      `SELECT * FROM business_days WHERE business_date = $1`,
      [businessDate]
    );

    res.json({
      ...summary,
      pending_no_shows: pendingNoShows,
      already_closed: existing.length > 0 && existing[0].status === 'closed',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build night audit preview' });
  } finally {
    client.release();
  }
});

// POST /api/night-audit/close — marks unarrived confirmed reservations as no-show,
// snapshots the day's summary, and closes the business day so it can't be re-run.
router.post('/close', requireRole('supervisor'), async (req, res) => {
  const { date } = req.body;
  const businessDate = date || new Date().toISOString().slice(0, 10);
  const closed_by = req.user.username;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      `SELECT * FROM business_days WHERE business_date = $1 FOR UPDATE`,
      [businessDate]
    );
    if (existing.length && existing[0].status === 'closed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Business day ${businessDate} is already closed` });
    }

    // No-show: still 'confirmed' with today as check-in date and nobody showed up
    const { rows: noShows } = await client.query(
      `UPDATE reservations SET status = 'no_show'
       WHERE check_in_date = $1 AND status = 'confirmed'
       RETURNING id`,
      [businessDate]
    );

    const summary = await buildSummary(client, businessDate);

    if (existing.length) {
      await client.query(
        `UPDATE business_days
         SET status = 'closed', room_revenue = $2, extra_revenue = $3, payments_total = $4,
             arrivals = $5, departures = $6, no_shows = $7, occupied_rooms = $8, total_rooms = $9,
             closed_by = $10, closed_at = now()
         WHERE business_date = $1`,
        [
          businessDate, summary.room_revenue, summary.extra_revenue, summary.payments_total,
          summary.arrivals, summary.departures, noShows.length, summary.occupied_rooms,
          summary.total_rooms, closed_by || null,
        ]
      );
    } else {
      await client.query(
        `INSERT INTO business_days
          (business_date, status, room_revenue, extra_revenue, payments_total,
           arrivals, departures, no_shows, occupied_rooms, total_rooms, closed_by, closed_at)
         VALUES ($1, 'closed', $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
        [
          businessDate, summary.room_revenue, summary.extra_revenue, summary.payments_total,
          summary.arrivals, summary.departures, noShows.length, summary.occupied_rooms,
          summary.total_rooms, closed_by || null,
        ]
      );
    }

    await client.query('COMMIT');
    res.json({
      business_date: businessDate,
      status: 'closed',
      no_shows_marked: noShows.length,
      ...summary,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to close business day' });
  } finally {
    client.release();
  }
});

// GET /api/night-audit/history?limit=30 — past closed days, for trend reporting
router.get('/history', async (req, res) => {
  const limit = Number(req.query.limit) || 30;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM business_days WHERE status = 'closed' ORDER BY business_date DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load night audit history' });
  }
});

module.exports = router;

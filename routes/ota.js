const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { sendWhatsAppMessage } = require('../services/whatsapp');

// /bookings is called BY an external channel manager/OTA, not by staff — it can't use the
// same staff JWT auth as the rest of the API. It's protected by a shared webhook secret
// instead. Set OTA_WEBHOOK_SECRET and give it to each channel manager you connect.
function requireWebhookSecret(req, res, next) {
  const provided = req.headers['x-ota-webhook-secret'];
  if (!process.env.OTA_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'OTA webhook ingestion is not configured (OTA_WEBHOOK_SECRET not set)' });
  }
  if (provided !== process.env.OTA_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing webhook secret' });
  }
  next();
}

function generateReservationCode() {
  return `SC-${Math.floor(1000 + Math.random() * 9000)}`;
}

// Alerts staff that a new OTA booking arrived, two ways:
// 1. An internal_messages entry addressed to reception — visible in-app to anyone who
//    checks the message board (GET /api/internal-messages?to_dept=reception), so it's
//    not dependent on one person's phone.
// 2. A WhatsApp ping to OTA_ALERT_PHONE (if set) — reuses the same Twilio setup as guest
//    notifications and invoices, so someone's phone actually buzzes instead of the booking
//    sitting silently in the dashboard until someone happens to look.
// Both are best-effort: failures are logged, never thrown, so they can't break booking ingestion.
async function notifyStaffOfNewBooking(reservation, guest, channel) {
  const summary =
    `New ${channel} booking: ${reservation.reservation_code} — ${guest.full_name}, ` +
    `${new Date(reservation.check_in_date).toLocaleDateString()} to ${new Date(reservation.check_out_date).toLocaleDateString()}. ` +
    `Needs a room assigned.`;

  try {
    await pool.query(
      `INSERT INTO internal_messages (from_dept, to_dept, message, priority, sent_by)
       VALUES ('reception', 'reception', $1, 'high', 'ota-webhook')`,
      [summary]
    );
  } catch (err) {
    console.error('Failed to post internal message for new OTA booking:', err);
  }

  if (process.env.OTA_ALERT_PHONE) {
    try {
      await sendWhatsAppMessage(process.env.OTA_ALERT_PHONE, `Subla Camp: ${summary}`);
    } catch (err) {
      console.error('Failed to send WhatsApp alert for new OTA booking:', err);
    }
  }
}

// POST /api/ota/bookings — ingests a booking pushed from a channel manager/OTA
// (e.g. Booking.com, Expedia). Idempotent on (channel, external_booking_id) — replaying
// the same webhook twice won't create a duplicate reservation.
router.post('/bookings', requireWebhookSecret, async (req, res) => {
  const {
    channel, external_booking_id, guest, room_type_id,
    check_in_date, check_out_date, adults, children, rate_per_night, special_requests,
  } = req.body;

  if (!channel || !external_booking_id || !guest?.full_name || !room_type_id || !check_in_date || !check_out_date || !rate_per_night) {
    return res.status(400).json({
      error: 'channel, external_booking_id, guest.full_name, room_type_id, dates, and rate_per_night are required',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency check — if we've already ingested this exact OTA booking, return it as-is
    // rather than erroring or duplicating (channel managers commonly retry webhooks).
    const { rows: existing } = await client.query(
      `SELECT * FROM reservations WHERE channel = $1 AND external_booking_id = $2`,
      [channel, external_booking_id]
    );
    if (existing.length) {
      await client.query('ROLLBACK');
      return res.status(200).json({ ...existing[0], already_existed: true });
    }

    let guestId;
    if (guest.phone || guest.email) {
      const { rows: matched } = await client.query(
        `SELECT id FROM guests WHERE (phone = $1 AND $1 IS NOT NULL) OR (email = $2 AND $2 IS NOT NULL) LIMIT 1`,
        [guest.phone || null, guest.email || null]
      );
      if (matched.length) guestId = matched[0].id;
    }
    if (!guestId) {
      const { rows: created } = await client.query(
        `INSERT INTO guests (full_name, phone, email, nationality) VALUES ($1,$2,$3,$4) RETURNING id`,
        [guest.full_name, guest.phone || null, guest.email || null, guest.nationality || null]
      );
      guestId = created[0].id;
    }

    const { rows: reservation } = await client.query(
      `INSERT INTO reservations
        (reservation_code, guest_id, room_type_id, check_in_date, check_out_date,
         adults, children, rate_per_night, source, channel, external_booking_id, special_requests)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ota',$9,$10,$11)
       RETURNING *`,
      [
        generateReservationCode(), guestId, room_type_id, check_in_date, check_out_date,
        adults || 1, children || 0, rate_per_night, channel, external_booking_id, special_requests || null,
      ]
    );

    await client.query(
      `INSERT INTO ota_sync_log (channel, direction, room_type_id, date_range_start, date_range_end, payload_summary, status)
       VALUES ($1, 'inbound_booking', $2, $3, $4, $5, 'success')`,
      [channel, room_type_id, check_in_date, check_out_date, `Booking ${external_booking_id} for ${guest.full_name}`]
    );

    await client.query('COMMIT');

    // Notify staff — outside the transaction on purpose. A booking that arrived from an
    // OTA must be saved even if the notification step fails; we don't want a Twilio hiccup
    // to roll back a real reservation. Errors here are logged, never surfaced to the caller
    // (the channel manager only cares that the booking was accepted).
    await notifyStaffOfNewBooking(reservation[0], guest, channel);

    res.status(201).json({ ...reservation[0], already_existed: false });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    try {
      await pool.query(
        `INSERT INTO ota_sync_log (channel, direction, room_type_id, date_range_start, date_range_end, status, error_message)
         VALUES ($1, 'inbound_booking', $2, $3, $4, 'failed', $5)`,
        [channel, room_type_id || null, check_in_date || null, check_out_date || null, err.message]
      );
    } catch (logErr) {
      console.error('Additionally failed to write ota_sync_log:', logErr);
    }
    res.status(500).json({ error: 'Failed to ingest OTA booking' });
  } finally {
    client.release();
  }
});

// GET /api/ota/availability?room_type_id=1&start=2026-08-17&end=2026-08-24
// Outbound inventory feed — the numbers a channel manager would poll to keep OTA
// listings in sync and avoid overbooking. Read-only; not logged per-poll (that would
// bloat ota_sync_log fast) — only actual inventory pushes should be logged via
// POST /api/ota/sync-log below.
//
// Uses the same webhook secret as /bookings, not staff login — Channex (or any channel
// manager) has no staff account to authenticate as, so this can't require the normal
// JWT auth the rest of the app uses. Both endpoints are protected the same way for
// exactly this reason.
router.get('/availability', requireWebhookSecret, async (req, res) => {
  const { room_type_id, start, end } = req.query;
  if (!room_type_id || !start || !end) {
    return res.status(400).json({ error: 'room_type_id, start, and end are required' });
  }

  try {
    const { rows: totalRooms } = await pool.query(
      `SELECT COUNT(*) FROM rooms WHERE room_type_id = $1 AND housekeeping_status != 'out_of_order' AND active = TRUE`,
      [room_type_id]
    );
    const total = Number(totalRooms[0].count);

    const { rows } = await pool.query(
      `SELECT d::date AS date,
              $1::int - COUNT(res.id) AS rooms_available
       FROM generate_series($2::date, $3::date, '1 day') d
       LEFT JOIN reservations res
         ON res.room_type_id = $4
         AND res.status IN ('confirmed', 'checked_in')
         AND res.check_in_date <= d::date
         AND res.check_out_date > d::date
       GROUP BY d
       ORDER BY d`,
      [total, start, end, room_type_id]
    );

    res.json({
      room_type_id: Number(room_type_id),
      total_rooms: total,
      availability: rows.map((r) => ({ date: r.date, rooms_available: Number(r.rooms_available) })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build availability feed' });
  }
});

// POST /api/ota/sync-log — record that an outbound inventory push happened
// (call this from whatever job actually pushes rates/availability to the channel manager)
router.post('/sync-log', requireAuth, async (req, res) => {
  const { channel, room_type_id, date_range_start, date_range_end, payload_summary, status, error_message } = req.body;
  if (!channel || !status) return res.status(400).json({ error: 'channel and status are required' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO ota_sync_log (channel, direction, room_type_id, date_range_start, date_range_end, payload_summary, status, error_message)
       VALUES ($1, 'outbound_inventory', $2, $3, $4, $5, $6, $7) RETURNING *`,
      [channel, room_type_id || null, date_range_start || null, date_range_end || null, payload_summary || null, status, error_message || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record sync log entry' });
  }
});

// GET /api/ota/sync-log?channel=&limit=50 — audit trail of inbound bookings and outbound pushes
router.get('/sync-log', requireAuth, async (req, res) => {
  const { channel, limit } = req.query;
  const conditions = [];
  const values = [];
  if (channel) {
    values.push(channel);
    conditions.push(`channel = $${values.length}`);
  }
  values.push(Number(limit) || 50);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT * FROM ota_sync_log ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load sync log' });
  }
});

module.exports = router;

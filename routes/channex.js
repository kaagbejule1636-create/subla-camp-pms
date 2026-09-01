const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { processBookingFeed, syncRoomTypeAvailability } = require('../services/channex-sync');

// Channex signs its webhook calls with whatever secret you configure for the webhook in
// their dashboard, sent back as this header — same shared-secret pattern as the generic
// OTA webhook in routes/ota.js, and for the same reason: Channex has no staff account to
// authenticate as, so this can't use the normal JWT auth the rest of the app uses.
function requireChannexSecret(req, res, next) {
  const provided = req.headers['x-channex-webhook-secret'];
  if (!process.env.CHANNEX_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Channex webhook ingestion is not configured (CHANNEX_WEBHOOK_SECRET not set)' });
  }
  if (provided !== process.env.CHANNEX_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing webhook secret' });
  }
  next();
}

// POST /api/channex/webhook — Channex calls this the moment a booking arrives, changes,
// or gets cancelled. The payload itself is just a trigger ({event, property_id,
// timestamp}) — Channex's own guidance is to treat it as "go check the feed now" rather
// than trusting its contents directly, since webhook delivery isn't guaranteed to arrive
// in order. So this always responds 200 immediately (required — Channex retries on
// anything else) and processes the feed in the background; a slow or failed webhook
// doesn't lose a booking, because the periodic backup poll (see server.js) picks up
// anything a webhook missed within its own cycle.
router.post('/webhook', requireChannexSecret, (req, res) => {
  res.status(200).json({ received: true });
  processBookingFeed().catch((err) => console.error('Background feed processing after webhook failed:', err));
});

// POST /api/channex/sync-now — manager-only manual trigger, mainly for testing the
// connection end-to-end before relying on the webhook and the periodic poll.
router.post('/sync-now', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const result = await processBookingFeed();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to process Channex booking feed' });
  }
});

// POST /api/channex/push-availability — manager-only manual trigger to push current
// availability/rate for every mapped room type over a date range, mainly for the first
// sync after mapping a room type, or to force a resync if something seems out of step.
router.post('/push-availability', requireAuth, requireRole('manager'), async (req, res) => {
  const { start, end } = req.body;
  if (!start || !end) return res.status(400).json({ error: 'start and end are required' });

  try {
    const { rows: mappedTypes } = await pool.query(
      `SELECT id, name FROM room_types WHERE channex_room_type_id IS NOT NULL`
    );
    const results = [];
    for (const type of mappedTypes) {
      const result = await syncRoomTypeAvailability(type.id, start, end);
      results.push({ room_type: type.name, ...result });
    }
    res.json({ room_types_synced: results.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to push availability to Channex' });
  }
});

module.exports = router;

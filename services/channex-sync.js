// The actual work of keeping Subla Camp PMS and Channex in sync — separated from the route
// layer so the same logic can be triggered three ways: a Channex webhook (routes/channex.js),
// a periodic backup poll (server.js, per Channex's own recommendation to always run this
// even when webhooks are also used), and directly after a booking/checkout/cancellation
// changes availability (checkin.js, checkout.js, reservations.js).

const pool = require('../db/pool');
const channex = require('./channex');
const channexQueue = require('./channex-queue');
const ariCalculator = require('./ari-calculator');
const { sendWhatsAppMessage } = require('./whatsapp');

function generateReservationCode() {
  return `SC-${Math.floor(1000 + Math.random() * 9000)}`;
}

// Channex's documented ota_name values don't always match how we'd naturally write the
// channel name elsewhere in the system (e.g. 'BookingCom' vs 'booking.com') — normalized
// here so it's consistent with the 'channel' values used everywhere else (folio, reports).
const OTA_NAME_MAP = {
  BookingCom: 'booking.com',
  Airbnb: 'airbnb',
  'A-Expedia': 'expedia',
  Expedia: 'expedia',
  Goibibo: 'goibibo',
  MakeMyTrip: 'makemytrip',
};
function normalizeChannelName(otaName) {
  return OTA_NAME_MAP[otaName] || otaName.toLowerCase().replace(/\s+/g, '_');
}

async function getChannexPropertyId(client) {
  const { rows } = await client.query(`SELECT value FROM settings WHERE key = 'channex_property_id'`);
  return rows[0]?.value || null;
}

async function logSync(client, { channel, direction, room_type_id, date_range_start, date_range_end, payload_summary, status, error_message }) {
  try {
    await client.query(
      `INSERT INTO ota_sync_log (channel, direction, room_type_id, date_range_start, date_range_end, payload_summary, status, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [channel, direction, room_type_id || null, date_range_start || null, date_range_end || null, payload_summary || null, status, error_message || null]
    );
  } catch (err) {
    console.error('Failed to write ota_sync_log entry:', err);
  }
}

async function notifyStaff(message) {
  try {
    await pool.query(
      `INSERT INTO internal_messages (from_dept, to_dept, message, priority, sent_by)
       VALUES ('reception', 'reception', $1, 'high', 'channex-sync')`,
      [message]
    );
  } catch (err) {
    console.error('Failed to post internal message for Channex sync event:', err);
  }
  if (process.env.OTA_ALERT_PHONE) {
    try {
      await sendWhatsAppMessage(process.env.OTA_ALERT_PHONE, `Subla Camp: ${message}`);
    } catch (err) {
      console.error('Failed to send WhatsApp alert for Channex sync event:', err);
    }
  }
}

// Processes one booking revision — creating, updating, or cancelling a reservation as
// appropriate — and always acknowledges it with Channex afterward, even if it couldn't be
// fully processed (an unmapped room type, for example), since re-sending the same revision
// won't fix that; it needs a human to go fix the mapping.
async function processRevision(revision) {
  const client = await pool.connect();
  const channel = normalizeChannelName(revision.ota_name);
  const room = revision.rooms?.[0];

  try {
    await client.query('BEGIN');

    if (!room) {
      await logSync(client, {
        channel, direction: 'inbound_booking', status: 'failed',
        error_message: `Revision ${revision.id} (${revision.unique_id}) has no room data`,
      });
      await client.query('COMMIT');
      return { outcome: 'skipped_no_room' };
    }

    const { rows: mappedType } = await client.query(
      `SELECT id, name FROM room_types WHERE channex_room_type_id = $1`,
      [room.room_type_id]
    );
    if (!mappedType.length) {
      await logSync(client, {
        channel, direction: 'inbound_booking', status: 'failed',
        payload_summary: `Booking ${revision.unique_id} for unmapped Channex room type ${room.room_type_id}`,
        error_message: 'No room_types row has this channex_room_type_id — map it in Manage Rooms before this can be processed automatically',
      });
      await client.query('COMMIT');
      await notifyStaff(
        `An OTA booking (${channel}, ${revision.unique_id}) arrived for a room type that isn't mapped yet — it could not be created automatically. Check Sync Log for details.`
      );
      return { outcome: 'skipped_unmapped_room_type' };
    }
    const roomTypeId = mappedType[0].id;

    const { rows: existingRes } = await client.query(
      `SELECT * FROM reservations WHERE channel = $1 AND external_booking_id = $2`,
      [channel, revision.unique_id]
    );

    if (revision.status === 'cancelled') {
      if (existingRes.length && existingRes[0].status === 'confirmed') {
        await client.query(`UPDATE reservations SET status = 'cancelled' WHERE id = $1`, [existingRes[0].id]);
        await logSync(client, { channel, direction: 'inbound_booking', room_type_id: roomTypeId, status: 'success', payload_summary: `Cancelled ${revision.unique_id}` });
        await client.query('COMMIT');
        await notifyStaff(`OTA cancellation: ${revision.unique_id} (${channel}) has been cancelled.`);
        return { outcome: 'cancelled' };
      }
      if (existingRes.length && existingRes[0].status === 'checked_in') {
        // A guest already physically checked in shouldn't be silently cancelled by an
        // OTA-side change — that needs a human decision, not an automatic one.
        await logSync(client, { channel, direction: 'inbound_booking', room_type_id: roomTypeId, status: 'failed', error_message: `${revision.unique_id} cancelled at OTA but guest is already checked in — needs manual review` });
        await client.query('COMMIT');
        await notifyStaff(`⚠️ ${channel} shows ${revision.unique_id} as cancelled, but that guest is already checked in. This needs a manual decision — nothing was changed automatically.`);
        return { outcome: 'skipped_already_checked_in' };
      }
      await client.query('COMMIT');
      return { outcome: 'skipped_cancel_no_match' };
    }

    const guestFullName = [revision.customer?.name, revision.customer?.surname].filter(Boolean).join(' ') || 'OTA Guest';
    const guestPhone = revision.customer?.phone || null;
    const guestEmail = revision.customer?.mail || null;

    if (existingRes.length) {
      // Modification of a booking we already have — update the stay details. Deliberately
      // does not touch room_id (a room may already be assigned) or status.
      await client.query(
        `UPDATE reservations SET check_in_date = $1, check_out_date = $2, adults = $3, children = $4, rate_per_night = $5
         WHERE id = $6`,
        [
          revision.arrival_date, revision.departure_date,
          room.occupancy?.adults || 1, room.occupancy?.children || 0,
          Number(room.amount) / Math.max(1, (new Date(revision.departure_date) - new Date(revision.arrival_date)) / 86400000),
          existingRes[0].id,
        ]
      );
      await logSync(client, { channel, direction: 'inbound_booking', room_type_id: roomTypeId, status: 'success', payload_summary: `Modified ${revision.unique_id}` });
      await client.query('COMMIT');
      return { outcome: 'modified', reservationId: existingRes[0].id };
    }

    // New booking — reuse an existing guest by phone/email if one matches (same rule the
    // rest of the system already follows), otherwise create a new profile.
    let guestId;
    if (guestPhone || guestEmail) {
      const { rows: matched } = await client.query(
        `SELECT id FROM guests WHERE (phone = $1 AND $1 IS NOT NULL) OR (email = $2 AND $2 IS NOT NULL) LIMIT 1`,
        [guestPhone, guestEmail]
      );
      if (matched.length) guestId = matched[0].id;
    }
    if (!guestId) {
      const { rows: created } = await client.query(
        `INSERT INTO guests (full_name, phone, email, nationality) VALUES ($1,$2,$3,$4) RETURNING id`,
        [guestFullName, guestPhone, guestEmail, revision.customer?.country || null]
      );
      guestId = created[0].id;
    }

    const nights = Math.max(1, (new Date(revision.departure_date) - new Date(revision.arrival_date)) / 86400000);
    const ratePerNight = Number(room.amount) / nights;

    const { rows: created } = await client.query(
      `INSERT INTO reservations
        (reservation_code, guest_id, room_type_id, check_in_date, check_out_date,
         adults, children, rate_per_night, source, channel, external_booking_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ota',$9,$10)
       RETURNING *`,
      [
        generateReservationCode(), guestId, roomTypeId, revision.arrival_date, revision.departure_date,
        room.occupancy?.adults || 1, room.occupancy?.children || 0, ratePerNight, channel, revision.unique_id,
      ]
    );

    await logSync(client, { channel, direction: 'inbound_booking', room_type_id: roomTypeId, status: 'success', payload_summary: `New booking ${revision.unique_id} for ${guestFullName}` });
    await client.query('COMMIT');

    await notifyStaff(
      `New ${channel} booking: ${created[0].reservation_code} — ${guestFullName}, ` +
      `${new Date(revision.arrival_date).toLocaleDateString()} to ${new Date(revision.departure_date).toLocaleDateString()}. Needs a room assigned.`
    );

    return { outcome: 'created', reservationId: created[0].id };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to process Channex booking revision:', err);
    await logSync(pool, { channel, direction: 'inbound_booking', status: 'failed', error_message: err.message });
    return { outcome: 'error', error: err.message };
  } finally {
    client.release();
  }
}

// The main entry point — pull everything unacknowledged, process each one, acknowledge it
// regardless of outcome (per Channex's own rule: an unprocessable booking still needs
// acknowledging, or it's re-sent forever; the fix for an unmapped room type is a human
// going to map it, not Channex retrying the same message).
async function processBookingFeed() {
  if (!process.env.CHANNEX_API_KEY) {
    return { skipped: true, reason: 'Channex not configured' };
  }
  const revisions = await channex.pullBookingRevisionsFeed();
  const results = [];
  for (const revision of revisions) {
    const result = await processRevision(revision);
    try {
      await channex.acknowledgeBookingRevision(revision.id);
    } catch (err) {
      console.error(`Failed to acknowledge revision ${revision.id} with Channex:`, err);
    }
    results.push({ unique_id: revision.unique_id, ...result });
  }
  return { processed: results.length, results };
}

// The actual work of pushing availability to Channex for one room type and date range —
// computes the real per-date numbers (not one blanket figure), compresses them into the
// fewest possible segments, and sends them in a single batched call. This is what the
// queue in services/channex-queue.js calls once its debounce window closes; application
// code should call scheduleRoomTypeAvailability below instead of this directly.
async function pushAvailabilityNow(roomTypeId, dateFrom, dateTo) {
  const { rows: typeRows } = await pool.query(
    `SELECT channex_room_type_id FROM room_types WHERE id = $1`,
    [roomTypeId]
  );
  if (!typeRows.length || !typeRows[0].channex_room_type_id) {
    return { skipped: true, reason: 'Room type is not mapped to Channex' };
  }
  const propertyId = await getChannexPropertyId(pool);
  if (!propertyId) return { skipped: true, reason: 'channex_property_id is not set in settings' };

  const daily = await ariCalculator.computeDailyAvailability(roomTypeId, dateFrom, dateTo);
  const segments = ariCalculator.compressToSegments(daily, ['availability']);
  await channex.pushAvailability(propertyId, typeRows[0].channex_room_type_id, segments);

  await logSync(pool, {
    channel: 'channex', direction: 'outbound_inventory', room_type_id: roomTypeId,
    date_range_start: dateFrom, date_range_end: dateTo,
    payload_summary: `Pushed availability in ${segments.length} segment(s)`, status: 'success',
  });
  return { pushed: true, segments: segments.length };
}

// Same idea for rate and restrictions, reusing the exact resolver "A" built for guest
// quotes — a price pushed to Booking.com can never silently disagree with what a guest
// would be quoted in the app.
async function pushRatesNow(roomTypeId, dateFrom, dateTo) {
  const { rows: typeRows } = await pool.query(
    `SELECT channex_rate_plan_id FROM room_types WHERE id = $1`,
    [roomTypeId]
  );
  if (!typeRows.length || !typeRows[0].channex_rate_plan_id) {
    return { skipped: true, reason: 'Room type has no mapped Channex rate plan' };
  }
  const propertyId = await getChannexPropertyId(pool);
  if (!propertyId) return { skipped: true, reason: 'channex_property_id is not set in settings' };

  const daily = await ariCalculator.computeDailyRates(roomTypeId, dateFrom, dateTo);
  const segments = ariCalculator.compressToSegments(
    daily, ['rate', 'min_stay', 'max_stay', 'stop_sell', 'closed_to_arrival', 'closed_to_departure']
  );
  await channex.pushRate(propertyId, typeRows[0].channex_rate_plan_id, segments);

  await logSync(pool, {
    channel: 'channex', direction: 'outbound_inventory', room_type_id: roomTypeId,
    date_range_start: dateFrom, date_range_end: dateTo,
    payload_summary: `Pushed rates/restrictions in ${segments.length} segment(s)`, status: 'success',
  });
  return { pushed: true, segments: segments.length };
}

// What the rest of the app actually calls after a check-in, checkout, cancellation, stay
// change, room visibility toggle, or rate plan change — schedules a debounced, rate-limited,
// retried push rather than firing immediately. Never throws: a Channex hiccup should never
// block or fail the PMS action that triggered it, the same treatment as the WhatsApp
// notifications elsewhere in this codebase.
function scheduleRoomTypeAvailability(roomTypeId, dateFrom, dateTo) {
  if (!process.env.CHANNEX_API_KEY) return;
  channexQueue.scheduleAvailabilitySync(roomTypeId, dateFrom, dateTo, async (from, to) => {
    try {
      return await pushAvailabilityNow(roomTypeId, from, to);
    } catch (err) {
      await logSync(pool, {
        channel: 'channex', direction: 'outbound_inventory', room_type_id: roomTypeId,
        date_range_start: from, date_range_end: to, status: 'failed', error_message: err.message,
      });
      throw err;
    }
  });
}

function scheduleRoomTypeRates(roomTypeId, dateFrom, dateTo) {
  if (!process.env.CHANNEX_API_KEY) return;
  channexQueue.scheduleRateSync(roomTypeId, dateFrom, dateTo, async (from, to) => {
    try {
      return await pushRatesNow(roomTypeId, from, to);
    } catch (err) {
      await logSync(pool, {
        channel: 'channex', direction: 'outbound_inventory', room_type_id: roomTypeId,
        date_range_start: from, date_range_end: to, status: 'failed', error_message: err.message,
      });
      throw err;
    }
  });
}

// Full Sync — the very first sync after going live, or a full resync if something ever
// seems out of step. Channex's own certification requirement is 2 API calls total, not 2
// per room type: every mapped room type's data for the next FULL_SYNC_DAYS days is
// combined into one availability call and one rate/restrictions call, since each segment
// already carries its own room type or rate plan ID. Bypasses the debounce queue entirely
// — a Full Sync is a rare, deliberate, explicit action where the person doing it wants to
// see the real result immediately, not "check back in a few seconds."
const FULL_SYNC_DAYS = 500;

async function fullSyncNow() {
  if (!process.env.CHANNEX_API_KEY) return { skipped: true, reason: 'Channex not configured' };
  const propertyId = await getChannexPropertyId(pool);
  if (!propertyId) return { skipped: true, reason: 'channex_property_id is not set in settings' };

  const { rows: mappedTypes } = await pool.query(
    `SELECT id, name, channex_room_type_id, channex_rate_plan_id FROM room_types WHERE channex_room_type_id IS NOT NULL`
  );
  if (!mappedTypes.length) return { skipped: true, reason: 'No room types are mapped to Channex yet' };

  const dateFrom = new Date().toISOString().slice(0, 10);
  const dateTo = new Date(Date.now() + FULL_SYNC_DAYS * 86400000).toISOString().slice(0, 10);

  const allAvailabilitySegments = [];
  const allRateSegments = [];
  const perRoomType = [];

  for (const type of mappedTypes) {
    const dailyAvailability = await ariCalculator.computeDailyAvailability(type.id, dateFrom, dateTo);
    const availabilitySegments = ariCalculator.compressToSegments(dailyAvailability, ['availability']);
    availabilitySegments.forEach((s) => allAvailabilitySegments.push({ ...s, room_type_id: type.channex_room_type_id }));

    let rateSegmentCount = 0;
    if (type.channex_rate_plan_id) {
      const dailyRates = await ariCalculator.computeDailyRates(type.id, dateFrom, dateTo);
      const rateSegments = ariCalculator.compressToSegments(
        dailyRates, ['rate', 'min_stay', 'max_stay', 'stop_sell', 'closed_to_arrival', 'closed_to_departure']
      );
      rateSegments.forEach((s) => allRateSegments.push({ ...s, rate_plan_id: type.channex_rate_plan_id }));
      rateSegmentCount = rateSegments.length;
    }

    perRoomType.push({ room_type: type.name, availability_segments: availabilitySegments.length, rate_segments: rateSegmentCount });
  }

  await channex.pushAvailabilityBatch(propertyId, allAvailabilitySegments);
  await channex.pushRateBatch(propertyId, allRateSegments);

  await logSync(pool, {
    channel: 'channex', direction: 'outbound_inventory', date_range_start: dateFrom, date_range_end: dateTo,
    payload_summary: `Full sync: ${mappedTypes.length} room type(s), ${allAvailabilitySegments.length} availability segment(s) + ${allRateSegments.length} rate segment(s), in 2 API calls`,
    status: 'success',
  });

  return {
    api_calls: 2, room_types_synced: mappedTypes.length, date_from: dateFrom, date_to: dateTo,
    total_availability_segments: allAvailabilitySegments.length, total_rate_segments: allRateSegments.length,
    per_room_type: perRoomType,
  };
}

module.exports = {
  processBookingFeed, processRevision, normalizeChannelName, getChannexPropertyId,
  scheduleRoomTypeAvailability, scheduleRoomTypeRates, fullSyncNow,
  // exposed for direct/manual use (the "push-availability" route) and tests
  pushAvailabilityNow, pushRatesNow,
};

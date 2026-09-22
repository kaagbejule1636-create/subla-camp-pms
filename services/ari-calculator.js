// Computes the TRUE availability or rate/restriction values for each individual date in a
// range, then compresses consecutive identical values into the fewest possible segments —
// so what gets sent to Channex is both byte-for-byte accurate per night (not one blanket
// number smeared across a whole range) and batched into as few entries as their own
// guidance asks for ("don't send a lot of api calls with small changes... combine messages
// together"). This file has no network code and no database code in it on purpose — it's
// pure data transformation, which is what makes it safe to test exhaustively in isolation.

const pool = require('../db/pool');
const { resolveRange } = require('./rate-resolver');

// Returns one entry per date in [dateFrom, dateTo) (check_out-style: dateTo excluded),
// each { date, availability } — the actual number of sellable rooms of this type on that
// specific night, computed independently per date rather than as one number for the whole
// range.
async function computeDailyAvailability(roomTypeId, dateFrom, dateTo) {
  const { rows: totalRows } = await pool.query(
    `SELECT COUNT(*) FROM rooms WHERE room_type_id = $1 AND housekeeping_status != 'out_of_order' AND active = TRUE`,
    [roomTypeId]
  );
  const total = Number(totalRows[0].count);

  // One query for every reservation that overlaps the range at all, then count locally per
  // date — far cheaper than one query per date, and just as accurate.
  const { rows: reservations } = await pool.query(
    `SELECT check_in_date, check_out_date FROM reservations
     WHERE room_type_id = $1 AND status IN ('confirmed', 'checked_in')
       AND check_in_date < $3 AND check_out_date > $2`,
    [roomTypeId, dateFrom, dateTo]
  );

  const days = [];
  const cursor = new Date(dateFrom);
  const end = new Date(dateTo);
  while (cursor < end) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const booked = reservations.filter((r) => {
      const ci = r.check_in_date.toISOString().slice(0, 10);
      const co = r.check_out_date.toISOString().slice(0, 10);
      return ci <= dateStr && co > dateStr;
    }).length;
    days.push({ date: dateStr, availability: Math.max(0, total - booked) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

// Returns one entry per date with the resolved rate and every restriction field, using the
// exact same resolver "A" already built and tested for guest-facing quotes — so a price
// pushed to Booking.com can never silently disagree with what a guest would be quoted here.
async function computeDailyRates(roomTypeId, dateFrom, dateTo) {
  const { rows: typeRows } = await pool.query('SELECT base_rate FROM room_types WHERE id = $1', [roomTypeId]);
  if (!typeRows.length) return [];
  const baseRate = Number(typeRows[0].base_rate);

  const { rows: plans } = await pool.query(
    `SELECT * FROM rate_plans WHERE room_type_id = $1 AND active = TRUE`,
    [roomTypeId]
  );
  return resolveRange(plans, baseRate, dateFrom, dateTo);
}

// Groups consecutive days that share identical values (compared across every key in
// `keys`) into the fewest number of { date_from, date_to, ...values } segments. Generic
// over which fields matter — availability compresses on just "availability"; rates
// compress across rate + every restriction field together, since Channex's /restrictions
// call carries all of them per segment.
function compressToSegments(dailyValues, keys) {
  if (!dailyValues.length) return [];
  const segments = [];
  let segmentStart = dailyValues[0];
  let prev = dailyValues[0];

  const sameValues = (a, b) => keys.every((k) => a[k] === b[k]);

  for (let i = 1; i < dailyValues.length; i++) {
    const current = dailyValues[i];
    if (!sameValues(current, prev)) {
      segments.push(buildSegment(segmentStart, prev, keys));
      segmentStart = current;
    }
    prev = current;
  }
  segments.push(buildSegment(segmentStart, prev, keys));
  return segments;
}

function buildSegment(start, end, keys) {
  const segment = { date_from: start.date, date_to: end.date };
  keys.forEach((k) => { segment[k] = start[k]; });
  return segment;
}

module.exports = { computeDailyAvailability, computeDailyRates, compressToSegments };

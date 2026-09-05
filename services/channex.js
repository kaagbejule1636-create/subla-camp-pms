// Thin wrapper around the Channex.io API — the channel manager connecting Subla Camp PMS
// to Booking.com and Airbnb. Built directly against Channex's own documentation
// (docs.channex.io), not guessed: every request/response shape here matches their real
// examples.
//
// Requires two env vars:
//   CHANNEX_API_KEY  — from Channex's Organisation page (Account > API Keys)
//   CHANNEX_BASE_URL — https://staging.channex.io while testing, https://channex.io once live
//
// Channex's own guidance on the flow this supports:
//   Inbound (bookings arriving from Booking.com/Airbnb):
//     - Poll GET /booking_revisions/feed regularly (this is the primary method)
//     - Optionally also receive a webhook trigger, which just means "go check the feed now"
//     - After saving a booking, POST /booking_revisions/:id/ack — mandatory, or Channex
//       keeps re-sending the same booking indefinitely
//   Outbound (telling Channex what's actually available, so it doesn't oversell you):
//     - POST /availability and POST /restrictions whenever room availability or rates change
//
// A request to Channex can fail for reasons entirely outside this system's control (their
// service being down, a network hiccup) — every function here throws a plain Error with
// a clear message on failure, so callers can decide whether that's worth blocking on or
// just logging, the same way the WhatsApp alert calls elsewhere in this codebase are
// treated as best-effort rather than something that should break a check-in.

const CHANNEX_BASE_URL = process.env.CHANNEX_BASE_URL || 'https://staging.channex.io';

function requireConfig() {
  if (!process.env.CHANNEX_API_KEY) {
    throw new Error('Channex is not configured — set CHANNEX_API_KEY (and optionally CHANNEX_BASE_URL) as environment variables');
  }
}

async function channexRequest(method, path, body) {
  requireConfig();
  const res = await fetch(`${CHANNEX_BASE_URL}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'user-api-key': process.env.CHANNEX_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`Channex returned a non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const title = json.errors?.title || `HTTP ${res.status}`;
    const details = json.errors?.details ? ` — ${JSON.stringify(json.errors.details)}` : '';
    throw new Error(`Channex API error: ${title}${details}`);
  }
  return json;
}

// Returns an array of unacknowledged Booking Revision objects, each shaped exactly like
// Channex's documented examples: { id, property_id, booking_id, unique_id, ota_name,
// status ('new'|'modified'|'cancelled'), rooms: [...], customer: {...}, arrival_date,
// departure_date, amount, currency, ... }. An empty array means nothing new to process.
async function pullBookingRevisionsFeed() {
  const json = await channexRequest('GET', '/booking_revisions/feed?order[inserted_at]=asc');
  return (json.data || []).map((row) => row.attributes);
}

// Must be called after a booking revision has been successfully saved into Subla Camp
// PMS — otherwise Channex keeps re-sending the same revision in the feed indefinitely,
// and eventually emails a warning that it was never acknowledged.
async function acknowledgeBookingRevision(revisionId) {
  await channexRequest('POST', `/booking_revisions/${revisionId}/ack`);
}

// Pushes how many rooms of a given (mapped) room type are actually free for a date or
// date range. `availability` is a plain count — Channex expects the real number of
// sellable rooms, not a delta.
async function pushAvailability(propertyId, channexRoomTypeId, dateFrom, dateTo, availability) {
  return channexRequest('POST', '/availability', {
    values: [{
      property_id: propertyId,
      room_type_id: channexRoomTypeId,
      date_from: dateFrom,
      date_to: dateTo,
      availability,
    }],
  });
}

// Pushes the nightly rate for a mapped rate plan over a date range. Channex accepts rate
// either as a decimal string ("500.00") or an integer in the currency's minor unit
// (50000) — this always sends the decimal-string form, which avoids any ambiguity about
// how many decimal places a given currency uses.
async function pushRate(propertyId, channexRatePlanId, dateFrom, dateTo, rate) {
  return channexRequest('POST', '/restrictions', {
    values: [{
      property_id: propertyId,
      rate_plan_id: channexRatePlanId,
      date_from: dateFrom,
      date_to: dateTo,
      rate: Number(rate).toFixed(2),
    }],
  });
}

module.exports = {
  CHANNEX_BASE_URL,
  pullBookingRevisionsFeed,
  acknowledgeBookingRevision,
  pushAvailability,
  pushRate,
};

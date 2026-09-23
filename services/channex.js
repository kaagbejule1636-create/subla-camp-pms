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

// Pushes availability across one or more date segments in a single API call — batched,
// as Channex's own guidance asks for, rather than one call per segment. Each segment is
// { date_from, date_to, availability }.
async function pushAvailability(propertyId, channexRoomTypeId, segments) {
  if (!segments.length) return null;
  return channexRequest('POST', '/availability', {
    values: segments.map((s) => ({
      property_id: propertyId,
      room_type_id: channexRoomTypeId,
      date_from: s.date_from,
      date_to: s.date_to,
      availability: s.availability,
    })),
  });
}

// Pushes rate and restrictions across one or more date segments in a single API call.
// Each segment is { date_from, date_to, rate, min_stay, max_stay, stop_sell,
// closed_to_arrival, closed_to_departure } — rate is optional per segment (a
// restriction-only change doesn't need to carry a price). Rate is always sent as a
// decimal string ("500.00"), which avoids any ambiguity about how many decimal places a
// given currency uses.
async function pushRate(propertyId, channexRatePlanId, segments) {
  if (!segments.length) return null;
  return channexRequest('POST', '/restrictions', {
    values: segments.map((s) => {
      const value = {
        property_id: propertyId,
        rate_plan_id: channexRatePlanId,
        date_from: s.date_from,
        date_to: s.date_to,
      };
      if (s.rate !== undefined && s.rate !== null) value.rate = Number(s.rate).toFixed(2);
      if (s.min_stay !== undefined && s.min_stay !== null) value.min_stay = s.min_stay;
      if (s.max_stay !== undefined && s.max_stay !== null) value.max_stay = s.max_stay;
      if (s.stop_sell !== undefined) value.stop_sell = s.stop_sell;
      if (s.closed_to_arrival !== undefined) value.closed_to_arrival = s.closed_to_arrival;
      if (s.closed_to_departure !== undefined) value.closed_to_departure = s.closed_to_departure;
      return value;
    }),
  });
}

module.exports = {
  CHANNEX_BASE_URL,
  pullBookingRevisionsFeed,
  acknowledgeBookingRevision,
  pushAvailability,
  pushRate,
  pushAvailabilityBatch,
  pushRateBatch,
};

// Same underlying call as pushAvailability, but for a Full Sync spanning every mapped
// room type at once — Channex's own certification requirement is 2 API calls total for a
// full sync, not 2 per room type, and their /availability endpoint already supports this:
// each segment carries its own room_type_id, so many room types' data can ride in one
// request. Deliberately a separate function from pushAvailability rather than a change to
// it — the single-room-type version is already tested and used by every day-to-day
// trigger (check-in, checkout, a rate change); this only ever gets called by an explicit
// Full Sync action.
async function pushAvailabilityBatch(propertyId, segments) {
  if (!segments.length) return null;
  return channexRequest('POST', '/availability', {
    values: segments.map((s) => ({
      property_id: propertyId,
      room_type_id: s.room_type_id,
      date_from: s.date_from,
      date_to: s.date_to,
      availability: s.availability,
    })),
  });
}

async function pushRateBatch(propertyId, segments) {
  if (!segments.length) return null;
  return channexRequest('POST', '/restrictions', {
    values: segments.map((s) => {
      const value = {
        property_id: propertyId,
        rate_plan_id: s.rate_plan_id,
        date_from: s.date_from,
        date_to: s.date_to,
      };
      if (s.rate !== undefined && s.rate !== null) value.rate = Number(s.rate).toFixed(2);
      if (s.min_stay !== undefined && s.min_stay !== null) value.min_stay = s.min_stay;
      if (s.max_stay !== undefined && s.max_stay !== null) value.max_stay = s.max_stay;
      if (s.stop_sell !== undefined) value.stop_sell = s.stop_sell;
      if (s.closed_to_arrival !== undefined) value.closed_to_arrival = s.closed_to_arrival;
      if (s.closed_to_departure !== undefined) value.closed_to_departure = s.closed_to_departure;
      return value;
    }),
  });
}

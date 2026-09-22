// Everything Channex's certification explicitly requires and the old fire-and-forget code
// didn't have: updates are debounced (several quick changes to the same room type collapse
// into one push, not one call each), rate-limited against their real published limits (10
// availability calls/minute, 10 restrictions/rate calls/minute, per property), and retried
// with exponential backoff on a 429 or 5xx instead of being silently dropped. Channex also
// processes messages FIFO — this queue keeps that same order per category, never lets a
// later change overtake an earlier one.
//
// This is a single in-memory queue — correct for how this app actually runs (Render's
// WEB_CONCURRENCY=1, a single Node process), not something that would need to coordinate
// across multiple instances.

const RATE_LIMIT_PER_MINUTE = Number(process.env.CHANNEX_RATE_LIMIT_PER_MINUTE) || 10; // per category, per Channex's published limit
const RATE_LIMIT_WINDOW_MS = Number(process.env.CHANNEX_RATE_LIMIT_WINDOW_MS) || 60000;  // overridable for fast tests
const DEBOUNCE_MS = Number(process.env.CHANNEX_DEBOUNCE_MS) || 3000;     // collapse rapid successive changes to the same room type
const MAX_RETRIES = Number(process.env.CHANNEX_MAX_RETRIES) || 5;
const BASE_BACKOFF_MS = Number(process.env.CHANNEX_BASE_BACKOFF_MS) || 1000;     // 1s, 2s, 4s, 8s, 16s

function createLimiter(label) {
  const callTimestamps = [];
  const queue = [];
  let processing = false;

  async function waitForCapacity() {
    const now = Date.now();
    while (callTimestamps.length && now - callTimestamps[0] > RATE_LIMIT_WINDOW_MS) callTimestamps.shift();
    if (callTimestamps.length >= RATE_LIMIT_PER_MINUTE) {
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - callTimestamps[0]) + 50;
      console.log(`Channex ${label} queue: at rate limit, waiting ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      return waitForCapacity();
    }
  }

  async function processNext() {
    if (processing || !queue.length) return;
    processing = true;
    const { fn, resolve, reject } = queue.shift();

    await waitForCapacity();

    let attempt = 0;
    while (true) {
      try {
        callTimestamps.push(Date.now());
        const result = await fn();
        resolve(result);
        break;
      } catch (err) {
        const isRateLimit = err.message && err.message.includes('429');
        const isServerError = err.message && /HTTP 5\d\d/.test(err.message);
        if ((isRateLimit || isServerError) && attempt < MAX_RETRIES) {
          const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
          console.log(`Channex ${label} queue: attempt ${attempt + 1} failed (${err.message}), retrying in ${backoff}ms`);
          await new Promise((r) => setTimeout(r, backoff));
          attempt++;
          continue;
        }
        reject(err);
        break;
      }
    }
    processing = false;
    processNext();
  }

  // Runs `fn` (an async function making one Channex API call) through this category's
  // rate limiter and retry logic, in FIFO order relative to every other call already
  // queued on this same category.
  function enqueue(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      processNext();
    });
  }

  return { enqueue };
}

const availabilityLimiter = createLimiter('availability');
const ratesLimiter = createLimiter('rates');

const pendingByRoomType = new Map(); // roomTypeId -> { availability: {timer, dateFrom, dateTo}|null, rates: {...}|null }

function getPending(roomTypeId) {
  if (!pendingByRoomType.has(roomTypeId)) {
    pendingByRoomType.set(roomTypeId, { availability: null, rates: null });
  }
  return pendingByRoomType.get(roomTypeId);
}

// Schedules an availability push for this room type, debounced. If a push is already
// pending for this room type when another change comes in, the date range is widened to
// cover both, rather than the second change being silently dropped — a checkout at 2pm and
// a cancellation at 2:01pm on different date ranges must both end up reflected in whatever
// eventually gets sent to Channex.
function scheduleAvailabilitySync(roomTypeId, dateFrom, dateTo, runFn) {
  schedule('availability', availabilityLimiter, roomTypeId, dateFrom, dateTo, runFn);
}

function scheduleRateSync(roomTypeId, dateFrom, dateTo, runFn) {
  schedule('rates', ratesLimiter, roomTypeId, dateFrom, dateTo, runFn);
}

function schedule(kind, limiter, roomTypeId, dateFrom, dateTo, runFn) {
  const pending = getPending(roomTypeId);
  const existing = pending[kind];

  if (existing) {
    if (dateFrom < existing.dateFrom) existing.dateFrom = dateFrom;
    if (dateTo > existing.dateTo) existing.dateTo = dateTo;
    return;
  }

  const entry = {
    dateFrom, dateTo,
    timer: setTimeout(() => {
      const { dateFrom: finalFrom, dateTo: finalTo } = pending[kind];
      pending[kind] = null;
      limiter.enqueue(() => runFn(finalFrom, finalTo)).catch((err) => {
        console.error(`Channex ${kind} push failed for room type ${roomTypeId} after retries:`, err.message);
      });
    }, DEBOUNCE_MS),
  };
  pending[kind] = entry;
}

module.exports = {
  scheduleAvailabilitySync, scheduleRateSync,
  // exposed for tests only — not used by application code
  _internal: { createLimiter, RATE_LIMIT_PER_MINUTE, DEBOUNCE_MS, MAX_RETRIES, BASE_BACKOFF_MS },
};

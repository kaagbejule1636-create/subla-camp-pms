// Resolves the effective rate and booking restrictions for a room type, night by night.
// This is the one place this logic lives — the /quote endpoint uses it to price a stay,
// and it's meant to be the same function the Channex ARI push (still to be built) uses to
// decide what to actually send Channex for each date. Two different call sites computing
// this differently would be a real, hard-to-notice source of bugs — someone books a room
// at one price while a different price gets pushed to Booking.com.
//
// Resolution rule, matching what was already established for rate alone: for a given
// night, the single highest-priority plan whose date range and weekday (if any) match
// that night wins — both its rate (if it has one; a plan can carry only restrictions and
// no price) and all of its restriction fields. A plan's restriction fields don't mix
// across plans — the winning plan's restrictions apply as a whole, or none do if no plan
// matches, so the interaction between rate and restrictions stays easy to reason about,
// not a rule that pulls the rate from one plan and the restrictions from another.

function findApplicablePlan(plans, dateStr, dayOfWeek) {
  const applicable = plans.filter((p) => {
    if (p.start_date && dateStr < toDateStr(p.start_date)) return false;
    if (p.end_date && dateStr > toDateStr(p.end_date)) return false;
    if (p.days_of_week && !p.days_of_week.includes(dayOfWeek)) return false;
    return true;
  });
  applicable.sort((a, b) => b.priority - a.priority || Number(b.rate || 0) - Number(a.rate || 0));
  return applicable[0] || null;
}

function toDateStr(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

// Resolves one night. Returns { rate, rate_plan, min_stay, max_stay, stop_sell,
// closed_to_arrival, closed_to_departure } — restrictions default to "none" (null/false)
// when nothing matches or the winning plan doesn't set them.
function resolveNight(plans, baseRate, dateStr, dayOfWeek) {
  const plan = findApplicablePlan(plans, dateStr, dayOfWeek);
  return {
    date: dateStr,
    rate: plan && plan.rate !== null && plan.rate !== undefined ? Number(plan.rate) : baseRate,
    rate_plan: plan ? plan.name : 'Standard (base rate)',
    min_stay: plan ? plan.min_stay : null,
    max_stay: plan ? plan.max_stay : null,
    stop_sell: plan ? plan.stop_sell : false,
    closed_to_arrival: plan ? plan.closed_to_arrival : false,
    closed_to_departure: plan ? plan.closed_to_departure : false,
  };
}

// Resolves every night from check_in (inclusive) to check_out (exclusive) — the usual
// hotel convention, matching how the rest of the system already treats a stay's date range.
function resolveRange(plans, baseRate, checkIn, checkOut) {
  const nights = [];
  const cursor = new Date(checkIn);
  const end = new Date(checkOut);
  while (cursor < end) {
    const dateStr = cursor.toISOString().slice(0, 10);
    nights.push(resolveNight(plans, baseRate, dateStr, cursor.getDay()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return nights;
}

module.exports = { resolveNight, resolveRange, findApplicablePlan };

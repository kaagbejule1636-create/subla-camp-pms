const path = require('path');
const fs = require('fs');

const LOGO_PATH = path.join(__dirname, '..', 'public', 'subla-camp-logo.jpeg');
const LOGO_WIDTH = 90;
const LOGO_ASPECT_RATIO = 675 / 1176; // actual logo file dimensions: 1176x675px

const PROPERTY_NAME = 'Subla Camp';
const PROPERTY_ADDRESS = 'Near Masfout Adventure Park, Masfout, Ajman, UAE';
const PROPERTY_TIMEZONE = 'Asia/Dubai';

// The server this runs on isn't necessarily in the UAE — Render can run it in any region,
// and its system clock is very likely UTC. Every date/time shown on a printed document
// needs to read correctly against Dubai wall-clock time regardless of where the server
// itself physically sits, so every route uses these two helpers instead of calling
// toLocaleString()/toLocaleDateString() directly.
//
// formatDubaiDateTime — for an actual moment in time (when a document was printed, when
// a guest departed): forces Asia/Dubai so the clock time shown is correct.
function formatDubaiDateTime(date) {
  return new Date(date).toLocaleString(undefined, { timeZone: PROPERTY_TIMEZONE });
}

// formatCalendarDate — for a pure calendar date with no time-of-day (check-in/check-out
// dates, date of birth, an expense's date). Postgres returns these as UTC-midnight of
// that date; forcing UTC on the way back out (rather than the server's local timezone,
// or nothing at all) guarantees the date shown always matches the date actually stored,
// instead of silently shifting a day earlier depending on what timezone the server
// happens to be running in.
function formatCalendarDate(date, options) {
  return new Date(date).toLocaleDateString(undefined, { timeZone: 'UTC', ...options });
}

// formatDubaiDate — the date portion only (no time) of a genuine timestamp (a folio
// transaction's created_at, for example), shown as whatever calendar date that moment
// falls on in Dubai — distinct from formatCalendarDate, which is for values that were
// already a plain date with no time component to begin with.
function formatDubaiDate(date) {
  return new Date(date).toLocaleDateString(undefined, { timeZone: PROPERTY_TIMEZONE });
}

// Draws the logo (or a text fallback if the file's ever missing) plus the property
// name and address at the current cursor position, and advances doc.y past it —
// so whatever's called next doesn't have to think about layout math.
function drawLetterhead(doc, subtitle) {
  if (fs.existsSync(LOGO_PATH)) {
    const startY = doc.y;
    doc.image(LOGO_PATH, doc.x, startY, { width: LOGO_WIDTH });
    doc.y = startY + LOGO_WIDTH * LOGO_ASPECT_RATIO + 8;
  } else {
    doc.fontSize(20).fillColor('#000').text(PROPERTY_NAME, { continued: false });
    doc.moveDown(0.3);
  }

  doc.fontSize(9).fillColor('#555').text(PROPERTY_ADDRESS);
  if (subtitle) {
    doc.fontSize(10).fillColor('#555').text(subtitle);
  }
  doc.moveDown(1);
  doc.fillColor('#000');
}

// Standard hotel policy language — drafted as a reasonable default, not legal advice.
// Stored as one line per point; the settings table can override this with the manager's
// own text in the same format. Exported so routes/settings.js can fall back to it before
// anything's been saved.
const DEFAULT_TERMS_AND_CONDITIONS = [
  'Check-in time is 12:00 PM (noon); check-out time is 2:00 PM. Early check-in and late check-out are subject to availability and may incur an additional charge.',
  'Cancellations must be made at least 48 hours before the scheduled arrival date to avoid a cancellation charge. No-shows forfeit any deposit paid.',
  'Guests are responsible for any loss or damage to property, furnishings, or equipment caused during their stay, beyond normal wear and tear.',
  'Rates are quoted in AED and are subject to change without notice for future bookings; confirmed reservations are honored at the rate agreed at booking.',
  'Management reserves the right to refuse service or end a stay without refund in cases of misconduct, damage, or violation of property rules.',
].join('\n');

// `termsText` is the raw saved value — one point per line, exactly what the manager typed
// into the settings editor. Falls back to the built-in default if not provided, so every
// existing call site keeps working unchanged even before anyone's customized it.
function drawTermsAndConditions(doc, termsText) {
  const lines = (termsText || DEFAULT_TERMS_AND_CONDITIONS)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  doc.moveDown(1);
  doc.fontSize(9).fillColor('#777').text('Terms & Conditions', { underline: false });
  doc.moveDown(0.3);
  lines.forEach((line, i) => {
    doc.fontSize(7.5).fillColor('#888').text(`${i + 1}. ${line}`, { align: 'left' });
  });
  doc.fillColor('#000');
}

module.exports = {
  drawLetterhead, drawTermsAndConditions, PROPERTY_NAME, PROPERTY_ADDRESS, DEFAULT_TERMS_AND_CONDITIONS,
  formatDubaiDateTime, formatCalendarDate, formatDubaiDate, PROPERTY_TIMEZONE,
};

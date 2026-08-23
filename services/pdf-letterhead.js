const path = require('path');
const fs = require('fs');

const LOGO_PATH = path.join(__dirname, '..', 'public', 'subla-camp-logo.jpeg');
const LOGO_WIDTH = 90;
const LOGO_ASPECT_RATIO = 675 / 1176; // actual logo file dimensions: 1176x675px

const PROPERTY_NAME = 'Subla Camp';
const PROPERTY_ADDRESS = 'Near Masfout Adventure Park, Masfout, Ajman, UAE';

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
// Kept as plain constants so it's easy to find and edit later without touching layout code.
const TERMS_AND_CONDITIONS = [
  'Check-in time is 12:00 PM (noon); check-out time is 2:00 PM. Early check-in and late check-out are subject to availability and may incur an additional charge.',
  'Cancellations must be made at least 48 hours before the scheduled arrival date to avoid a cancellation charge. No-shows forfeit any deposit paid.',
  'Guests are responsible for any loss or damage to property, furnishings, or equipment caused during their stay, beyond normal wear and tear.',
  'Rates are quoted in AED and are subject to change without notice for future bookings; confirmed reservations are honored at the rate agreed at booking.',
  'Management reserves the right to refuse service or end a stay without refund in cases of misconduct, damage, or violation of property rules.',
];

function drawTermsAndConditions(doc) {
  doc.moveDown(1);
  doc.fontSize(9).fillColor('#777').text('Terms & Conditions', { underline: false });
  doc.moveDown(0.3);
  TERMS_AND_CONDITIONS.forEach((line, i) => {
    doc.fontSize(7.5).fillColor('#888').text(`${i + 1}. ${line}`, { align: 'left' });
  });
  doc.fillColor('#000');
}

module.exports = { drawLetterhead, drawTermsAndConditions, PROPERTY_NAME, PROPERTY_ADDRESS };

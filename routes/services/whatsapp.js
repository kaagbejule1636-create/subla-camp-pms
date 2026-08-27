// Thin wrapper around Twilio's WhatsApp API, matching the setup already used for
// Subla Tea's stock alerts. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and
// TWILIO_WHATSAPP_FROM (e.g. 'whatsapp:+14155238886' for the Sandbox) as env vars.
let twilioClient = null;

function getClient() {
  if (twilioClient) return twilioClient;
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return twilioClient;
}

// Sends a plain-text WhatsApp message. `to` should be a phone number in E.164 format
// (e.g. '+9715XXXXXXXX') — the 'whatsapp:' prefix is added automatically.
async function sendWhatsAppMessage(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_WHATSAPP_FROM) {
    throw new Error('Twilio WhatsApp is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM');
  }
  const client = getClient();
  const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  return client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: formattedTo,
    body,
  });
}

module.exports = { sendWhatsAppMessage };

const express = require('express');
const app = express();
const { requireAuth } = require('./middleware/auth');

app.use(express.json());

// Serves logo.png, favicon, etc. — anything in /public is reachable at /assets/<filename>,
// no auth required (a logo isn't sensitive data, and the login screen needs to show it
// before anyone has a token).
app.use('/assets', express.static('public'));

// Login is the only unauthenticated endpoint; everything else requires a valid token.
app.use('/api/auth', require('./routes/auth'));

app.use('/api/rooms', requireAuth, require('./routes/rooms'));
app.use('/api/reservations', requireAuth, require('./routes/reservations'));
app.use('/api/checkin', requireAuth, require('./routes/checkin'));
app.use('/api/checkout', requireAuth, require('./routes/checkout'));
app.use('/api/invoices', requireAuth, require('./routes/invoices'));
app.use('/api/housekeeping', requireAuth, require('./routes/housekeeping'));
app.use('/api/night-audit', requireAuth, require('./routes/night-audit'));
app.use('/api/rate-plans', requireAuth, require('./routes/rate-plans'));
app.use('/api/reports', requireAuth, require('./routes/reports'));
app.use('/api/keycards', requireAuth, require('./routes/keycards'));
app.use('/api/notifications', requireAuth, require('./routes/notifications'));
app.use('/api/internal-messages', requireAuth, require('./routes/internal-messages'));
app.use('/api/payouts', requireAuth, require('./routes/payouts'));
app.use('/api/currencies', requireAuth, require('./routes/currencies'));
// OTA handles its own auth per-route: /bookings uses a webhook secret (external channel
// managers can't hold a staff JWT), while /availability and /sync-log require staff auth.
app.use('/api/ota', require('./routes/ota'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Subla Camp PMS API listening on port ${PORT}`));

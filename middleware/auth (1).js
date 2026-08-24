const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}

// Verifies the Bearer token and attaches { id, username, full_name, role } to req.user.
// Every route except /api/auth/login should sit behind this.
//
// Accepts the token either as an Authorization header (used by all normal API calls from
// the frontend's JS) or as a ?token= query parameter — needed because a plain <a href>
// link opened in a new tab (used for the printable PDF documents) is just a browser
// navigation with no custom headers attached; there's no other way for it to carry auth.
// The tradeoff: a token used this way is visible in the browser's address bar/history for
// that tab. Given tokens already expire after 12 hours and this only affects viewing a PDF
// (not any data-modifying action), that's an acceptable exchange for print links that
// actually work — but it's a real tradeoff, not a free fix.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = (header.startsWith('Bearer ') ? header.slice(7) : null) || req.query.token || null;
  if (!token) return res.status(401).json({ error: 'Missing or malformed Authorization header' });

  try {
    req.user = jwt.verify(token, JWT_SECRET || 'dev-only-insecure-secret');
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Role hierarchy: manager > supervisor > receptionist.
// requireRole('supervisor') allows supervisor and manager, not receptionist.
const ROLE_RANK = { receptionist: 1, supervisor: 2, manager: 3 };

function requireRole(minimumRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const userRank = ROLE_RANK[req.user.role] || 0;
    const requiredRank = ROLE_RANK[minimumRole] || 99;
    if (userRank < requiredRank) {
      return res.status(403).json({ error: `Requires ${minimumRole} role or higher` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, JWT_SECRET };

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}

// Verifies the Bearer token and attaches { id, username, full_name, role } to req.user.
// Every route except /api/auth/login should sit behind this.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
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

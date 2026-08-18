const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth, requireRole, JWT_SECRET } = require('../middleware/auth');

// POST /api/auth/login — { username, password } -> { token, user }
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND active = TRUE',
      [username]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid username or password' });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid username or password' });

    const payload = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
    const token = jwt.sign(payload, JWT_SECRET || 'dev-only-insecure-secret', { expiresIn: '12h' });

    res.json({ token, user: payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me — confirms the current token and returns the user it belongs to
router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// POST /api/auth/users — manager-only: create a new staff account
router.post('/users', requireAuth, requireRole('manager'), async (req, res) => {
  const { username, password, full_name, role } = req.body;
  if (!username || !password || !full_name || !role) {
    return res.status(400).json({ error: 'username, password, full_name, and role are required' });
  }
  if (!['receptionist', 'supervisor', 'manager'].includes(role)) {
    return res.status(400).json({ error: "role must be 'receptionist', 'supervisor', or 'manager'" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4) RETURNING id, username, full_name, role, active, created_at`,
      [username, passwordHash, full_name, role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// GET /api/auth/users — manager-only: staff list
router.get('/users', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, full_name, role, active, created_at FROM users ORDER BY full_name'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// PATCH /api/auth/users/:id — manager-only: deactivate/reactivate or change role
router.patch('/users/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const { id } = req.params;
  const { role, active } = req.body;
  const updates = [];
  const values = [];

  if (role !== undefined) {
    if (!['receptionist', 'supervisor', 'manager'].includes(role)) {
      return res.status(400).json({ error: "role must be 'receptionist', 'supervisor', or 'manager'" });
    }
    values.push(role);
    updates.push(`role = $${values.length}`);
  }
  if (active !== undefined) {
    values.push(active);
    updates.push(`active = $${values.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: 'No updatable fields provided' });

  values.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${values.length}
       RETURNING id, username, full_name, role, active, created_at`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

module.exports = router;

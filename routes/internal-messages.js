const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

const VALID_DEPTS = ['reception', 'housekeeping', 'maintenance', 'management'];

// POST /api/internal-messages — e.g. Reception -> Housekeeping: "VIP guest arriving in Room 302"
router.post('/', async (req, res) => {
  const { to_dept, room_id, message, priority } = req.body;
  const from_dept = req.body.from_dept || 'reception';

  if (!to_dept || !message) return res.status(400).json({ error: 'to_dept and message are required' });
  if (!VALID_DEPTS.includes(to_dept) || !VALID_DEPTS.includes(from_dept)) {
    return res.status(400).json({ error: `dept must be one of ${VALID_DEPTS.join(', ')}` });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO internal_messages (from_dept, to_dept, room_id, message, priority, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [from_dept, to_dept, room_id || null, message, priority || 'normal', req.user.username]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// GET /api/internal-messages?to_dept=housekeeping&status=unread — a department's inbox
router.get('/', async (req, res) => {
  const { to_dept, status } = req.query;
  const conditions = [];
  const values = [];

  if (to_dept) {
    values.push(to_dept);
    conditions.push(`im.to_dept = $${values.length}`);
  }
  if (status) {
    values.push(status);
    conditions.push(`im.status = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT im.*, r.room_number
       FROM internal_messages im
       LEFT JOIN rooms r ON r.id = im.room_id
       ${where}
       ORDER BY
         CASE im.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
         im.created_at DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// PATCH /api/internal-messages/:id/read — mark read or acknowledged
router.patch('/:id/read', async (req, res) => {
  const { id } = req.params;
  const status = req.body.status === 'acknowledged' ? 'acknowledged' : 'read';
  try {
    const { rows } = await pool.query(
      `UPDATE internal_messages SET status = $1, read_at = COALESCE(read_at, now())
       WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update message' });
  }
});

module.exports = router;

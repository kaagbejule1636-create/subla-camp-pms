const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const PDFDocument = require('pdfkit');
const { drawLetterhead } = require('../services/pdf-letterhead');

// GET /api/housekeeping/tasks — the housekeeping team's task board.
// Optional filters: status, assigned_to, room_id
router.get('/tasks', async (req, res) => {
  const { status, assigned_to, room_id } = req.query;
  const conditions = [];
  const values = [];

  if (status) {
    values.push(status);
    conditions.push(`ht.status = $${values.length}`);
  }
  if (assigned_to) {
    values.push(assigned_to);
    conditions.push(`ht.assigned_to = $${values.length}`);
  }
  if (room_id) {
    values.push(room_id);
    conditions.push(`ht.room_id = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT ht.*, r.room_number
       FROM housekeeping_tasks ht
       JOIN rooms r ON r.id = ht.room_id
       ${where}
       ORDER BY
         CASE ht.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
         ht.created_at`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

// POST /api/housekeeping/tasks — create and optionally assign a task
router.post('/tasks', async (req, res) => {
  const { room_id, task_type, description, assigned_to, priority } = req.body;
  const created_by = req.user.username;
  if (!room_id || !task_type) {
    return res.status(400).json({ error: 'room_id and task_type are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO housekeeping_tasks (room_id, task_type, description, assigned_to, priority, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [room_id, task_type, description || null, assigned_to || null, priority || 'normal', created_by || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// PATCH /api/housekeeping/tasks/:id/assign — assign or reassign to a staff member
router.patch('/tasks/:id/assign', async (req, res) => {
  const { id } = req.params;
  const { assigned_to } = req.body;
  if (!assigned_to) return res.status(400).json({ error: 'assigned_to is required' });

  try {
    const { rows } = await pool.query(
      `UPDATE housekeeping_tasks SET assigned_to = $1
       WHERE id = $2 AND status != 'done' RETURNING *`,
      [assigned_to, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Task not found or already completed' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to assign task' });
  }
});

// PATCH /api/housekeeping/tasks/:id/status — move a task through pending -> in_progress -> done
// When a task is marked done, and it's the room's clean-up task, this also clears the room's
// dirty flag automatically so front desk sees it become available without a separate step.
router.patch('/tasks/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const valid = ['pending', 'in_progress', 'done', 'cancelled'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${valid.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const timestampField =
      status === 'in_progress' ? 'started_at = now()' :
      status === 'done' ? 'completed_at = now()' : null;

    const { rows: taskRows } = await client.query(
      `UPDATE housekeeping_tasks
       SET status = $1 ${timestampField ? ', ' + timestampField : ''}
       WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (!taskRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Task not found' });
    }
    const task = taskRows[0];

    // Auto-clear room dirty status when a room-cleaning task completes
    if (status === 'done' && task.task_type === 'clean_room') {
      const { rows: current } = await client.query('SELECT housekeeping_status FROM rooms WHERE id = $1', [task.room_id]);
      if (current.length && current[0].housekeeping_status === 'dirty') {
        await client.query(`UPDATE rooms SET housekeeping_status = 'clean' WHERE id = $1`, [task.room_id]);
        await client.query(
          `INSERT INTO room_status_log (room_id, field, old_value, new_value, changed_by)
           VALUES ($1, 'housekeeping_status', 'dirty', 'clean', $2)`,
          [task.room_id, task.assigned_to || null]
        );
      }
    }

    await client.query('COMMIT');
    res.json(task);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to update task status' });
  } finally {
    client.release();
  }
});

// GET /api/housekeeping/report — printable PDF combining the current room status board
// and the open task list, intended for a supervisor's morning walkthrough or shift handover.
router.get('/report', async (req, res) => {
  try {
    const { rows: rooms } = await pool.query(
      `SELECT r.room_number, rt.name AS room_type, r.housekeeping_status, r.occupancy_status
       FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
       ORDER BY r.room_number`
    );
    const { rows: tasks } = await pool.query(
      `SELECT ht.task_type, ht.priority, ht.status, ht.assigned_to, r.room_number
       FROM housekeeping_tasks ht JOIN rooms r ON r.id = ht.room_id
       WHERE ht.status != 'done'
       ORDER BY CASE ht.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, ht.created_at`
    );

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=housekeeping-report-${new Date().toISOString().slice(0, 10)}.pdf`);
    doc.pipe(res);

    drawLetterhead(doc, 'Housekeeping Report');
    doc.fontSize(10).fillColor('#555').text(`Generated: ${new Date().toLocaleString()}`);
    doc.fillColor('#000');
    doc.moveDown();

    // --- Room status table ---
    doc.fontSize(13).text('Room Status', { underline: true });
    doc.moveDown(0.3);
    const colX = { room: 50, type: 140, hk: 320, occ: 430 };
    doc.fontSize(9).fillColor('#555');
    doc.text('Room', colX.room, doc.y, { continued: false });
    doc.text('Type', colX.type, doc.y - doc.currentLineHeight());
    doc.text('Housekeeping', colX.hk, doc.y - doc.currentLineHeight());
    doc.text('Occupancy', colX.occ, doc.y - doc.currentLineHeight());
    doc.x = 50;
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    doc.fontSize(10).fillColor('#000');
    rooms.forEach((room) => {
      const rowY = doc.y;
      const hkColor = room.housekeeping_status === 'dirty' ? '#C1392B'
        : room.housekeeping_status === 'out_of_order' ? '#888' : '#5C8A5A';
      doc.fillColor('#000').text(room.room_number, colX.room, rowY);
      doc.text(room.room_type, colX.type, rowY);
      doc.fillColor(hkColor).text(room.housekeeping_status, colX.hk, rowY);
      doc.fillColor('#000').text(room.occupancy_status, colX.occ, rowY);
      doc.moveDown(0.4);
    });

    // Explicit-coordinate text() calls above leave doc.x at the last column's position,
    // not the left margin — reset both before the next section, or its heading and any
    // plain (no-x) text() call after it lands in the wrong place.
    doc.x = 50;

    doc.moveDown();
    doc.fontSize(13).fillColor('#000').text('Open Tasks', { underline: true });
    doc.moveDown(0.3);

    if (tasks.length === 0) {
      doc.fontSize(10).fillColor('#555').text('No open tasks.');
    } else {
      const tColX = { room: 50, task: 140, assigned: 320, priority: 430, status: 500 };
      doc.fontSize(9).fillColor('#555');
      doc.text('Room', tColX.room, doc.y);
      doc.text('Task', tColX.task, doc.y - doc.currentLineHeight());
      doc.text('Assigned', tColX.assigned, doc.y - doc.currentLineHeight());
      doc.text('Priority', tColX.priority, doc.y - doc.currentLineHeight());
      doc.x = 50;
      doc.moveDown(0.3);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.3);

      doc.fontSize(10).fillColor('#000');
      tasks.forEach((t) => {
        const rowY = doc.y;
        const priColor = t.priority === 'high' ? '#C1392B' : '#000';
        doc.fillColor('#000').text(t.room_number, tColX.room, rowY);
        doc.text(t.task_type, tColX.task, rowY);
        doc.text(t.assigned_to || '—', tColX.assigned, rowY);
        doc.fillColor(priColor).text(t.priority, tColX.priority, rowY);
        doc.fillColor('#000');
        doc.moveDown(0.4);
      });
      doc.x = 50;
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate housekeeping report' });
  }
});

module.exports = router;

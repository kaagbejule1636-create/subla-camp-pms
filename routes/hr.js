const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { drawLetterhead, formatDubaiDateTime, formatCalendarDate } = require('../services/pdf-letterhead');

// ============================================================================
// Employees — a staff directory, deliberately separate from PMS logins (`users`),
// since most staff (housekeeping, kitchen, etc.) never need a system account at all.
// ============================================================================

// GET /api/hr/employees — active by default; pass include_inactive=true to also see
// former staff (kept on record, never deleted, same pattern as rooms/inventory items).
router.get('/employees', requireRole('manager'), async (req, res) => {
  const where = req.query.include_inactive ? '' : 'WHERE active = TRUE';
  try {
    const { rows } = await pool.query(`SELECT * FROM employees ${where} ORDER BY full_name`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load employees' });
  }
});

router.post('/employees', requireRole('manager'), async (req, res) => {
  const { full_name, position, phone, email, start_date, notes } = req.body;
  if (!full_name || !full_name.trim()) return res.status(400).json({ error: 'full_name is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO employees (full_name, position, phone, email, start_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [full_name.trim(), position || null, phone || null, email || null, start_date || null, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add employee' });
  }
});

router.patch('/employees/:id', requireRole('manager'), async (req, res) => {
  const { full_name, position, phone, email, start_date, notes } = req.body;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM employees WHERE id = $1', [req.params.id]);
    if (!existingRows.length) return res.status(404).json({ error: 'Employee not found' });
    const existing = existingRows[0];
    const { rows } = await pool.query(
      `UPDATE employees SET full_name=$1, position=$2, phone=$3, email=$4, start_date=$5, notes=$6 WHERE id=$7 RETURNING *`,
      [
        full_name?.trim() || existing.full_name, position ?? existing.position, phone ?? existing.phone,
        email ?? existing.email, start_date ?? existing.start_date, notes ?? existing.notes, req.params.id,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// PATCH /api/hr/employees/:id/active — hides a former staff member from the directory
// without deleting their record, same reasoning as everywhere else this pattern is used:
// their leave history stays intact and valid.
router.patch('/employees/:id/active', requireRole('manager'), async (req, res) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be true or false' });
  const { rows } = await pool.query('UPDATE employees SET active = $1 WHERE id = $2 RETURNING *', [active, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
  res.json(rows[0]);
});

// ============================================================================
// Leave requests — recorded and actioned by a manager. There's no separate staff login
// for most employees, so this models "manager logs it and approves/rejects it," not
// true self-service leave requests.
// ============================================================================

router.get('/leave', requireRole('manager'), async (req, res) => {
  const { employee_id, status } = req.query;
  const conditions = [];
  const values = [];
  if (employee_id) { values.push(employee_id); conditions.push(`lr.employee_id = $${values.length}`); }
  if (status) { values.push(status); conditions.push(`lr.status = $${values.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT lr.*, e.full_name AS employee_name FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       ${where} ORDER BY lr.start_date DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load leave requests' });
  }
});

router.post('/leave', requireRole('manager'), async (req, res) => {
  const { employee_id, leave_type, start_date, end_date, notes } = req.body;
  if (!employee_id || !leave_type || !start_date || !end_date) {
    return res.status(400).json({ error: 'employee_id, leave_type, start_date, and end_date are required' });
  }
  if (new Date(end_date) < new Date(start_date)) {
    return res.status(400).json({ error: 'end_date must be on or after start_date' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [employee_id, leave_type, start_date, end_date, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record leave request' });
  }
});

router.patch('/leave/:id/approve', requireRole('manager'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE leave_requests SET status = 'approved', approved_by = $1, approved_at = now()
     WHERE id = $2 AND status = 'pending' RETURNING *`,
    [req.user.username, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Leave request not found or already actioned' });
  res.json(rows[0]);
});

router.patch('/leave/:id/reject', requireRole('manager'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE leave_requests SET status = 'rejected', approved_by = $1, approved_at = now()
     WHERE id = $2 AND status = 'pending' RETURNING *`,
    [req.user.username, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Leave request not found or already actioned' });
  res.json(rows[0]);
});

// ============================================================================
// Letter templates — reusable starting points for the letterhead print tool below.
// ============================================================================

router.get('/templates', requireRole('manager'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM letter_templates ORDER BY title');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

router.post('/templates', requireRole('manager'), async (req, res) => {
  const { title, content } = req.body;
  if (!title || !title.trim() || !content || !content.trim()) {
    return res.status(400).json({ error: 'title and content are required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO letter_templates (title, content, created_by) VALUES ($1,$2,$3) RETURNING *',
      [title.trim(), content, req.user.username]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

router.delete('/templates/:id', requireRole('manager'), async (req, res) => {
  const { rows } = await pool.query('DELETE FROM letter_templates WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Template not found' });
  res.json({ deleted: true });
});

// POST /api/hr/letter/print — turns any typed or pasted text into a printable PDF with
// Subla Camp's logo, address, and a consistent professional layout — offer letters,
// warning letters, memos, certificates, anything HR needs on letterhead. Deliberately not
// saved anywhere: this is a print tool, not a document management system, so there's no
// history to browse later. Manager-only, since these are typically sensitive
// staff-facing documents (warnings, terminations, salary matters), not day-to-day
// front-desk work.
//
// This is a POST, not a GET like the other print links in the app — the letter's body
// text can be long, and cramming that into a URL's query string is both awkward (URL
// length limits) and ugly. The frontend fetches this as a PDF blob and opens it in a new
// tab, rather than using a plain <a href> link the way the other print buttons do.
router.post('/letter/print', requireRole('manager'), (req, res) => {
  const { title, content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `inline; filename=letter-${Date.now()}.pdf`);
  doc.pipe(res);

  drawLetterhead(doc, title || 'Internal Memo');
  doc.fontSize(10).fillColor('#555').text(`Date: ${formatDubaiDateTime(new Date())}`);
  doc.fillColor('#000');
  doc.moveDown();

  // Plain paragraphs, one blank line between them — preserves whatever line breaks the
  // person actually typed or pasted, rather than trying to reformat their text.
  doc.fontSize(11);
  content.split('\n').forEach((line) => {
    if (line.trim()) {
      doc.text(line, { align: 'left' });
    } else {
      doc.moveDown(0.5);
    }
  });

  doc.end();
});

module.exports = router;

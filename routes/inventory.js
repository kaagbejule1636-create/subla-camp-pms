const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');

// GET /api/inventory/items — list item types
router.get('/items', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM inventory_items WHERE active = TRUE ORDER BY category, name');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load inventory items' });
  }
});

// POST /api/inventory/items — create a new item type (supervisor+, since it sets pricing)
router.post('/items', requireRole('supervisor'), async (req, res) => {
  const { name, category, unit_cost, guest_price, reorder_threshold, current_stock } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO inventory_items (name, category, unit_cost, guest_price, reorder_threshold, current_stock)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, category || 'minibar', unit_cost || null, guest_price || null, reorder_threshold ?? 5, current_stock ?? 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create inventory item' });
  }
});

// GET /api/inventory/low-stock — central stock items at or below their reorder threshold
router.get('/low-stock', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM inventory_items WHERE active = TRUE AND current_stock <= reorder_threshold ORDER BY current_stock ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load low-stock items' });
  }
});

// GET /api/inventory/rooms/:roomId — what's currently stocked in a specific room
router.get('/rooms/:roomId', async (req, res) => {
  const { roomId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT ri.*, ii.name, ii.category, ii.guest_price
       FROM room_inventory ri JOIN inventory_items ii ON ii.id = ri.item_id
       WHERE ri.room_id = $1 ORDER BY ii.category, ii.name`,
      [roomId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load room inventory' });
  }
});

// POST /api/inventory/rooms/:roomId/restock — bring a room's stock of an item up to par,
// drawing down central stock. Creates the room_inventory row on first use (with the given
// or a default par level) so a room doesn't need pre-seeding before it can be stocked.
router.post('/rooms/:roomId/restock', async (req, res) => {
  const { roomId } = req.params;
  const { item_id, quantity, par_level } = req.body;
  if (!item_id || !quantity) return res.status(400).json({ error: 'item_id and quantity are required' });
  if (Number(quantity) <= 0) return res.status(400).json({ error: 'quantity must be positive' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: itemRows } = await client.query(
      'SELECT * FROM inventory_items WHERE id = $1 FOR UPDATE', [item_id]
    );
    if (!itemRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Inventory item not found' });
    }
    const item = itemRows[0];
    if (item.current_stock < quantity) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Not enough central stock: ${item.current_stock} available, ${quantity} requested` });
    }

    await client.query('UPDATE inventory_items SET current_stock = current_stock - $1 WHERE id = $2', [quantity, item_id]);

    await client.query(
      `INSERT INTO room_inventory (room_id, item_id, par_level, quantity_present)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_id, item_id)
       DO UPDATE SET quantity_present = room_inventory.quantity_present + $4,
                     par_level = COALESCE($3, room_inventory.par_level)`,
      [roomId, item_id, par_level || null, quantity]
    );

    await client.query(
      `INSERT INTO inventory_transactions (room_id, item_id, type, quantity, recorded_by)
       VALUES ($1, $2, 'restock', $3, $4)`,
      [roomId, item_id, quantity, req.user.username]
    );

    await client.query('COMMIT');
    res.status(201).json({ room_id: Number(roomId), item_id, restocked: quantity });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to restock room' });
  } finally {
    client.release();
  }
});

// POST /api/inventory/rooms/:roomId/consume — a guest used an item. Decrements the room's
// stock and, if the item has a guest_price and a reservation_id is given, posts an
// extra_charge to that reservation's folio in the same transaction — so a minibar item
// consumed shows up on the guest's bill automatically, the same pattern as room charges.
router.post('/rooms/:roomId/consume', async (req, res) => {
  const { roomId } = req.params;
  const { item_id, quantity, reservation_id } = req.body;
  if (!item_id || !quantity) return res.status(400).json({ error: 'item_id and quantity are required' });
  if (Number(quantity) <= 0) return res.status(400).json({ error: 'quantity must be positive' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: stockRows } = await client.query(
      'SELECT * FROM room_inventory WHERE room_id = $1 AND item_id = $2 FOR UPDATE',
      [roomId, item_id]
    );
    if (!stockRows.length || stockRows[0].quantity_present < quantity) {
      await client.query('ROLLBACK');
      const have = stockRows.length ? stockRows[0].quantity_present : 0;
      return res.status(409).json({ error: `Not enough stock in this room: ${have} present, ${quantity} requested` });
    }

    await client.query(
      'UPDATE room_inventory SET quantity_present = quantity_present - $1 WHERE room_id = $2 AND item_id = $3',
      [quantity, roomId, item_id]
    );

    await client.query(
      `INSERT INTO inventory_transactions (room_id, item_id, type, quantity, reservation_id, recorded_by)
       VALUES ($1, $2, 'consume', $3, $4, $5)`,
      [roomId, item_id, quantity, reservation_id || null, req.user.username]
    );

    let charged = null;
    if (reservation_id) {
      const { rows: itemRows } = await client.query('SELECT name, guest_price FROM inventory_items WHERE id = $1', [item_id]);
      const item = itemRows[0];
      if (item && item.guest_price) {
        const chargeAmount = Number(item.guest_price) * Number(quantity);
        await client.query(
          `INSERT INTO folio_transactions (reservation_id, type, description, amount, recorded_by)
           VALUES ($1, 'extra_charge', $2, $3, $4)`,
          [reservation_id, `${item.name} x${quantity} (minibar)`, chargeAmount, req.user.username]
        );
        charged = chargeAmount;
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ room_id: Number(roomId), item_id, consumed: quantity, charged_to_folio: charged });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to record consumption' });
  } finally {
    client.release();
  }
});

module.exports = router;

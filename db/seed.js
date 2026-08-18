// One-time setup script: seeds room_types and rooms.
// Edit the arrays below to match Subla Camp's actual inventory, then run:
//   node db/seed.js
require('dotenv').config();
const pool = require('./pool');

const ROOM_TYPES = [
  { name: 'Standard Tent', base_rate: 350, max_adults: 2, max_children: 1 },
  { name: 'Deluxe Tent', base_rate: 480, max_adults: 2, max_children: 2 },
  { name: 'Family Tent', base_rate: 650, max_adults: 4, max_children: 2 },
];

// room_number, room_type name (must match one of the names above)
const ROOMS = [
  ['S-01', 'Standard Tent'], ['S-02', 'Standard Tent'], ['S-03', 'Standard Tent'],
  ['D-04', 'Deluxe Tent'], ['D-06', 'Deluxe Tent'], ['D-07', 'Deluxe Tent'],
  ['D-09', 'Deluxe Tent'], ['D-11', 'Deluxe Tent'], ['D-12', 'Deluxe Tent'],
  ['F-15', 'Family Tent'], ['F-16', 'Family Tent'],
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const typeIds = {};
    for (const rt of ROOM_TYPES) {
      const { rows: existing } = await client.query('SELECT id FROM room_types WHERE name = $1', [rt.name]);
      if (existing.length) {
        typeIds[rt.name] = existing[0].id;
        continue;
      }
      const { rows: created } = await client.query(
        `INSERT INTO room_types (name, base_rate, max_adults, max_children)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [rt.name, rt.base_rate, rt.max_adults, rt.max_children]
      );
      typeIds[rt.name] = created[0].id;
    }

    let created = 0;
    for (const [roomNumber, typeName] of ROOMS) {
      const { rowCount } = await client.query(
        `INSERT INTO rooms (room_number, room_type_id)
         VALUES ($1, $2)
         ON CONFLICT (room_number) DO NOTHING`,
        [roomNumber, typeIds[typeName]]
      );
      created += rowCount;
    }

    await client.query('COMMIT');
    console.log(`Seeded ${ROOM_TYPES.length} room types and ${created} new rooms (existing rooms left untouched).`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();

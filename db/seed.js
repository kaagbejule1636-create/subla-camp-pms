// One-time setup script: seeds room_types and rooms.
// Edit the arrays below to match Subla Camp's actual inventory, then run:
//   node db/seed.js
require('dotenv').config();
const pool = require('./pool');

const ROOM_TYPES = [
  { name: 'Camping Tents', base_rate: 500, max_adults: 2, max_children: 1 },
  { name: 'Deluxe Rooms', base_rate: 2500, max_adults: 2, max_children: 2 },
  { name: 'Caravan Parking', base_rate: 1000, max_adults: 2, max_children: 1 },
];

// room_number, room_type name (must match one of the names above)
const ROOMS = [
  ['Unit 1', 'Camping Tents'], ['Unit 2', 'Camping Tents'], ['Unit 3', 'Camping Tents'],
  ['Unit 4', 'Camping Tents'], ['Unit 5', 'Camping Tents'],
  ['Unit 6', 'Deluxe Rooms'], ['Unit 7', 'Deluxe Rooms'], ['Unit 8', 'Deluxe Rooms'],
  ['Unit 9', 'Deluxe Rooms'], ['Unit 10', 'Deluxe Rooms'],
  ['Unit 11', 'Caravan Parking'], ['Unit 12', 'Caravan Parking'], ['Unit 13', 'Caravan Parking'],
  ['Unit 14', 'Caravan Parking'], ['Unit 15', 'Caravan Parking'],
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

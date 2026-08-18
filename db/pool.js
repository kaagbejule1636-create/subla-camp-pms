// Shared Postgres connection pool.
// Expects DATABASE_URL to be set (Render provides this automatically when you
// link a PostgreSQL instance to the web service — same pattern as subla-tea-db).
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

module.exports = pool;

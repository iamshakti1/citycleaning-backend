// db.js
// Connects to PostgreSQL (hosted on Aiven) and creates our tables if they
// don't exist yet. Replaces the old SQLite file, which reset every time
// Render restarted the server — Postgres data lives on Aiven's own storage
// and survives restarts/deploys.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      phone TEXT,
      pin TEXT,
      active INTEGER DEFAULT 1
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id SERIAL PRIMARY KEY,
      client_name TEXT NOT NULL,
      address TEXT,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      geofence_radius_m INTEGER NOT NULL DEFAULT 80
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff(id),
      site_id INTEGER NOT NULL REFERENCES sites(id),
      action TEXT NOT NULL,
      tap_time TEXT NOT NULL,
      tap_lat DOUBLE PRECISION NOT NULL,
      tap_lng DOUBLE PRECISION NOT NULL,
      distance_m INTEGER NOT NULL,
      accepted INTEGER NOT NULL
    )
  `);

  // Ensure every active staff member has a PIN. Runs on every startup —
  // only fills in missing PINs, never overwrites one that's already set.
  const missing = await pool.query(
    "SELECT id FROM staff WHERE active = 1 AND (pin IS NULL OR pin = '')"
  );
  for (const s of missing.rows) {
    const defaultPin = String(1000 + s.id).padStart(4, '0');
    await pool.query('UPDATE staff SET pin = $1 WHERE id = $2', [defaultPin, s.id]);
    console.log(`Assigned default PIN to staff id ${s.id}`);
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  init,
};

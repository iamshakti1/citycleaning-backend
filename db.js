// db.js
// Sets up the SQLite database and creates our tables if they don't exist yet.
// Later, moving to PostgreSQL means swapping this file only — the routes stay the same.

const Database = require('better-sqlite3');
const db = new Database('citycleaning.db');

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    phone TEXT,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name TEXT NOT NULL,
    address TEXT,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    geofence_radius_m INTEGER NOT NULL DEFAULT 80
  );

  CREATE TABLE IF NOT EXISTS time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    site_id INTEGER NOT NULL,
    action TEXT NOT NULL,            -- 'clock_in' or 'clock_out'
    tap_time TEXT NOT NULL,
    tap_lat REAL NOT NULL,
    tap_lng REAL NOT NULL,
    distance_m INTEGER NOT NULL,
    accepted INTEGER NOT NULL,       -- 1 if within geofence, 0 if rejected
    FOREIGN KEY (staff_id) REFERENCES staff(id),
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );
`);

module.exports = db;

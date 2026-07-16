// server.js
// The main backend. This is what both the staff app and the admin dashboard
// will talk to. The geofence check happens here, not on the phone, so it
// can't be bypassed by editing the app.

const express = require('express');
const cors = require('cors');
const db = require('./db');
const { isWithinGeofence } = require('./geofence');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- STAFF ----------

// Add a new staff member
app.post('/api/staff', (req, res) => {
  const { name, role, phone, pin } = req.body;
  if (!name || !role) {
    return res.status(400).json({ error: 'name and role are required' });
  }
  if (pin && !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'pin must be exactly 4 digits' });
  }
  if (pin) {
    const existing = db.prepare('SELECT id FROM staff WHERE pin = ? AND active = 1').get(pin);
    if (existing) {
      return res.status(400).json({ error: 'That PIN is already in use by another staff member' });
    }
  }
  const stmt = db.prepare('INSERT INTO staff (name, role, phone, pin) VALUES (?, ?, ?, ?)');
  const result = stmt.run(name, role, phone || null, pin || null);
  res.json({ id: result.lastInsertRowid, name, role, phone: phone || null, pin: pin || null });
});

// List all staff
app.get('/api/staff', (req, res) => {
  const rows = db.prepare('SELECT * FROM staff WHERE active = 1').all();
  res.json(rows);
});

// Identify a staff member by their PIN — used by the app before tap in/out,
// so staff enter their own code instead of picking their name off a list.
// TEMPORARY — remove after use
app.get('/api/setup-pins-temp', (req, res) => {
  db.prepare("UPDATE staff SET pin = '1111' WHERE id = 1").run();
  db.prepare("UPDATE staff SET pin = '2222' WHERE id = 2").run();
  db.prepare("UPDATE staff SET pin = '3333' WHERE id = 3").run();
  res.json({ done: true });
});
app.post('/api/staff/verify-pin', (req, res) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ error: 'pin is required' });
  }
  const staff = db.prepare('SELECT id, name, role FROM staff WHERE pin = ? AND active = 1').get(pin);
  if (!staff) {
    return res.status(404).json({ error: 'No staff member found with that PIN' });
  }
  res.json(staff);
});

// ---------- SITES ----------

// Add a new client site
app.post('/api/sites', (req, res) => {
  const { client_name, address, latitude, longitude, geofence_radius_m } = req.body;
  if (!client_name || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'client_name, latitude and longitude are required' });
  }
  const stmt = db.prepare(
    'INSERT INTO sites (client_name, address, latitude, longitude, geofence_radius_m) VALUES (?, ?, ?, ?, ?)'
  );
  const result = stmt.run(
    client_name,
    address || null,
    latitude,
    longitude,
    geofence_radius_m || 80
  );
  res.json({ id: result.lastInsertRowid, client_name, address, latitude, longitude, geofence_radius_m: geofence_radius_m || 80 });
});

// List all sites
app.get('/api/sites', (req, res) => {
  const rows = db.prepare('SELECT * FROM sites').all();
  res.json(rows);
});

// ---------- TAP IN / TAP OUT (the core feature) ----------

app.post('/api/tap', (req, res) => {
  const { staff_id, site_id, action, latitude, longitude } = req.body;

  if (!staff_id || !site_id || !action || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'staff_id, site_id, action, latitude and longitude are required' });
  }
  if (action !== 'clock_in' && action !== 'clock_out') {
    return res.status(400).json({ error: "action must be 'clock_in' or 'clock_out'" });
  }

  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(site_id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(staff_id);
  if (!staff) return res.status(404).json({ error: 'Staff member not found' });

  // THE ENFORCEMENT: this check happens on the server, using the coordinates
  // the phone sent, compared against the site's saved location and radius.
  const { distance, accepted } = isWithinGeofence(latitude, longitude, site);

  const tapTime = new Date().toISOString();
  db.prepare(
    `INSERT INTO time_entries (staff_id, site_id, action, tap_time, tap_lat, tap_lng, distance_m, accepted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(staff_id, site_id, action, tapTime, latitude, longitude, distance, accepted ? 1 : 0);

  if (!accepted) {
    return res.status(403).json({
      accepted: false,
      message: `${action.replace('_', ' ')} rejected — you are ${distance}m from ${site.client_name}, outside the ${site.geofence_radius_m}m allowed radius`,
      distance,
    });
  }

  res.json({
    accepted: true,
    message: `${action.replace('_', ' ')} accepted at ${site.client_name} — ${distance}m from site (within ${site.geofence_radius_m}m)`,
    distance,
    tap_time: tapTime,
  });
});

// ---------- TIMESHEETS ----------

// All time entries for one staff member (accepted taps only, for a real timesheet)
app.get('/api/timesheets/:staff_id', (req, res) => {
  const rows = db
    .prepare(
      `SELECT te.*, s.client_name FROM time_entries te
       JOIN sites s ON s.id = te.site_id
       WHERE te.staff_id = ? AND te.accepted = 1
       ORDER BY te.tap_time DESC`
    )
    .all(req.params.staff_id);
  res.json(rows);
});

// Everything (admin view — including rejected attempts, useful for spotting abuse)
app.get('/api/time-entries', (req, res) => {
  const rows = db
    .prepare(
      `SELECT te.*, st.name AS staff_name, s.client_name FROM time_entries te
       JOIN staff st ON st.id = te.staff_id
       JOIN sites s ON s.id = te.site_id
       ORDER BY te.tap_time DESC`
    )
    .all();
  res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CityCleaning backend running on http://localhost:${PORT}`);
});
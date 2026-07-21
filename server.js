// server.js
// The main backend. This is what both the staff app and the admin dashboard
// will talk to. The geofence check happens here, not on the phone, so it
// can't be bypassed by editing the app.

const express = require('express');
const cors = require('cors');
const basicAuth = require('express-basic-auth');
const db = require('./db');
const { isWithinGeofence } = require('./geofence');

const app = express();

if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
  throw new Error('ADMIN_USER and ADMIN_PASS environment variables must be set');
}

// Protects the admin dashboard and any route that manages staff/sites data.
// Does NOT protect the routes the staff phone app itself needs (verify-pin,
// tap in/out, site list) — those stay open so staff can clock in without
// logging in.
const adminAuth = basicAuth({
  users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
  challenge: true,
  realm: 'CityClean Admin',
});

app.use(cors());
app.use(express.json());
app.use('/admin.html', adminAuth);
app.use(express.static('public'));

// ---------- STAFF ----------

// Add a new staff member
app.post('/api/staff', adminAuth, async (req, res) => {
  const { name, role, phone, pin } = req.body;
  if (!name || !role) {
    return res.status(400).json({ error: 'name and role are required' });
  }
  if (pin && !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'pin must be exactly 4 digits' });
  }
  if (pin) {
    const existing = await db.query('SELECT id FROM staff WHERE pin = $1 AND active = 1', [pin]);
    if (existing.rows.length) {
      return res.status(400).json({ error: 'That PIN is already in use by another staff member' });
    }
  }
  const result = await db.query(
    'INSERT INTO staff (name, role, phone, pin) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, role, phone || null, pin || null]
  );
  res.json({ id: result.rows[0].id, name, role, phone: phone || null, pin: pin || null });
});

// List all staff
app.get('/api/staff', adminAuth, async (req, res) => {
  const result = await db.query('SELECT * FROM staff WHERE active = 1');
  res.json(result.rows);
});

// Delete a staff member entirely (used for cleaning up test/wrong records)
app.delete('/api/staff/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM time_entries WHERE staff_id = $1', [req.params.id]);
    const result = await db.query('DELETE FROM staff WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('Failed to delete staff:', err);
    res.status(500).json({ error: 'Failed to delete staff member' });
  }
});

// Identify a staff member by their PIN — used by the app before tap in/out,
// so staff enter their own code instead of picking their name off a list.
app.post('/api/staff/verify-pin', async (req, res) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ error: 'pin is required' });
  }
  const result = await db.query('SELECT id, name, role FROM staff WHERE pin = $1 AND active = 1', [pin]);
  if (!result.rows.length) {
    return res.status(404).json({ error: 'No staff member found with that PIN' });
  }
  res.json(result.rows[0]);
});

// ---------- SITES ----------

// Add a new client site
app.post('/api/sites', adminAuth, async (req, res) => {
  const { client_name, address, latitude, longitude, geofence_radius_m } = req.body;
  if (!client_name || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'client_name, latitude and longitude are required' });
  }
  const result = await db.query(
    'INSERT INTO sites (client_name, address, latitude, longitude, geofence_radius_m) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [client_name, address || null, latitude, longitude, geofence_radius_m || 80]
  );
  res.json({ id: result.rows[0].id, client_name, address, latitude, longitude, geofence_radius_m: geofence_radius_m || 80 });
});

// List all sites
app.get('/api/sites', async (req, res) => {
  const result = await db.query('SELECT * FROM sites');
  res.json(result.rows);
});

// Delete a site entirely (used for cleaning up test/wrong records)
app.delete('/api/sites/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM time_entries WHERE site_id = $1', [req.params.id]);
    const result = await db.query('DELETE FROM sites WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Site not found' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('Failed to delete site:', err);
    res.status(500).json({ error: 'Failed to delete site' });
  }
});

// ---------- TAP IN / TAP OUT (the core feature) ----------

app.post('/api/tap', async (req, res) => {
  const { staff_id, site_id, action, latitude, longitude } = req.body;

  if (!staff_id || !site_id || !action || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'staff_id, site_id, action, latitude and longitude are required' });
  }
  if (action !== 'clock_in' && action !== 'clock_out') {
    return res.status(400).json({ error: "action must be 'clock_in' or 'clock_out'" });
  }

  const siteResult = await db.query('SELECT * FROM sites WHERE id = $1', [site_id]);
  const site = siteResult.rows[0];
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const staffResult = await db.query('SELECT * FROM staff WHERE id = $1', [staff_id]);
  const staff = staffResult.rows[0];
  if (!staff) return res.status(404).json({ error: 'Staff member not found' });

  // Prevent duplicate taps: check this staff member's most recent accepted
  // tap (at any site). Can't clock in if already clocked in, and can't
  // clock out if not currently clocked in.
  const lastTapResult = await db.query(
    'SELECT * FROM time_entries WHERE staff_id = $1 AND accepted = 1 ORDER BY tap_time DESC LIMIT 1',
    [staff_id]
  );
  const lastTap = lastTapResult.rows[0];
  if (action === 'clock_in' && lastTap && lastTap.action === 'clock_in') {
    return res.status(409).json({
      accepted: false,
      message: `you are already clocked in — clock out first`,
    });
  }
  if (action === 'clock_out' && (!lastTap || lastTap.action === 'clock_out')) {
    return res.status(409).json({
      accepted: false,
      message: `you are not currently clocked in`,
    });
  }

  // THE ENFORCEMENT: this check happens on the server, using the coordinates
  // the phone sent, compared against the site's saved location and radius.
  const { distance, accepted } = isWithinGeofence(latitude, longitude, site);

  const tapTime = new Date().toISOString();
  await db.query(
    `INSERT INTO time_entries (staff_id, site_id, action, tap_time, tap_lat, tap_lng, distance_m, accepted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [staff_id, site_id, action, tapTime, latitude, longitude, distance, accepted ? 1 : 0]
  );

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
app.get('/api/timesheets/:staff_id', async (req, res) => {
  const result = await db.query(
    `SELECT te.*, s.client_name FROM time_entries te
     JOIN sites s ON s.id = te.site_id
     WHERE te.staff_id = $1 AND te.accepted = 1
     ORDER BY te.tap_time DESC`,
    [req.params.staff_id]
  );
  res.json(result.rows);
});

// Everything (admin view — including rejected attempts, useful for spotting abuse)
app.get('/api/time-entries', adminAuth, async (req, res) => {
  const result = await db.query(
    `SELECT te.*, st.name AS staff_name, s.client_name FROM time_entries te
     JOIN staff st ON st.id = te.staff_id
     JOIN sites s ON s.id = te.site_id
     ORDER BY te.tap_time DESC`
  );
  res.json(result.rows);
});


// ---------- REPORTS ----------

// Total hours worked per staff member, computed by pairing each accepted
// clock_in with the next accepted clock_out for that person.
app.get('/api/reports/hours', adminAuth, async (req, res) => {
  const staffResult = await db.query('SELECT id, name FROM staff WHERE active = 1');
  const entriesResult = await db.query(
    `SELECT staff_id, action, tap_time FROM time_entries
     WHERE accepted = 1
     ORDER BY staff_id, tap_time ASC`
  );

  const totalsMs = {};
  const openClockIn = {};

  for (const row of entriesResult.rows) {
    if (row.action === 'clock_in') {
      openClockIn[row.staff_id] = row.tap_time;
    } else if (row.action === 'clock_out' && openClockIn[row.staff_id]) {
      const start = new Date(openClockIn[row.staff_id]).getTime();
      const end = new Date(row.tap_time).getTime();
      totalsMs[row.staff_id] = (totalsMs[row.staff_id] || 0) + (end - start);
      delete openClockIn[row.staff_id];
    }
  }

  const report = staffResult.rows.map((s) => ({
    staff_id: s.id,
    name: s.name,
    total_hours: Math.round(((totalsMs[s.id] || 0) / 3600000) * 100) / 100,
    currently_clocked_in: Boolean(openClockIn[s.id]),
  }));

  res.json(report);
});

const PORT = process.env.PORT || 3000;

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CityCleaning backend running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

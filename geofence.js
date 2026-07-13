// geofence.js
// Calculates the real-world distance (in metres) between two GPS points
// using the Haversine formula, then checks it against a site's allowed radius.

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth's radius in metres
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function isWithinGeofence(staffLat, staffLng, site) {
  const distance = distanceMeters(staffLat, staffLng, site.latitude, site.longitude);
  return { distance, accepted: distance <= site.geofence_radius_m };
}

module.exports = { distanceMeters, isWithinGeofence };

'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Risk scoring (TG-015). Explainable weighted model; weights in risk/model-v1.json.
// Every factor is returned with its points, the features are hashed (featureHash)
// and kept off-chain in risk_assessments together with the incident outcome later
// read back from the ledger — that table is the training set for a learned model.
// Scoring reads only local SQLite, so it adds ~1 ms to the SOS path.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const tg    = require('../../common/tgnet');   // per-client files: config/client/<name>, else the shipped example
const MODEL = JSON.parse(fs.readFileSync(process.env.RISK_MODEL_FILE ||
                tg.clientFile('model-v1.json', path.join(__dirname, 'model-v1.json')), 'utf8'));
const SITES = (() => {
  try { return JSON.parse(fs.readFileSync(tg.clientFile('sites.json', path.join(__dirname, '..', 'oracle', 'sites.json')), 'utf8')).sites; }
  catch { return []; }
})();

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_assessments (
      incident_id   TEXT PRIMARY KEY,
      device_id     TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      event_time    TEXT NOT NULL,
      model_version TEXT NOT NULL,
      score         INTEGER NOT NULL,
      features_json TEXT NOT NULL,
      feature_hash  TEXT NOT NULL,
      factors_json  TEXT NOT NULL,
      oracle_ref    TEXT,
      created_at    TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS incident_status (
      incident_id TEXT PRIMARY KEY,
      status      TEXT,
      outcome     TEXT,
      checked_at  TEXT NOT NULL);`);
}

const siteOf = deviceId => SITES.find(s => (s.devices || []).includes(deviceId)) || null;

function latestReading(db, siteId, eventMs) {
  try {
    const row = db.prepare(`SELECT reading_id, observed_at, data_json FROM oracle_readings
                            WHERE site_id = ? AND status = 'ANCHORED' AND observed_at <= ?
                            ORDER BY observed_at DESC LIMIT 1`)
                  .get(siteId, new Date(eventMs + 15 * 60000).toISOString());
    if (!row) return null;
    const ageMin = (eventMs - Date.parse(row.observed_at)) / 60000;
    if (ageMin > MODEL.heat.maxAgeMinutes) return null;
    return { readingId: row.reading_id, ageMin: Math.round(ageMin), ...JSON.parse(row.data_json) };
  } catch { return null; }   // oracle table not there yet
}

function deviceHistory(db, deviceId, incidentId, eventMs) {
  const since24 = new Date(eventMs - 24 * 3600e3).toISOString();
  const since30 = new Date(eventMs - 30 * 24 * 3600e3).toISOString();
  const recent24h = db.prepare(`SELECT COUNT(*) n FROM raw_events
                                WHERE device_id = ? AND incident_id != ? AND received_at >= ?`)
                      .get(deviceId, incidentId, since24).n;
  const o = db.prepare(`SELECT
                          SUM(s.outcome IS NOT NULL)        resolved,
                          SUM(s.outcome = 'GENUINE')        genuine,
                          SUM(s.outcome = 'FALSE_ALARM')    falseAlarm
                        FROM raw_events r JOIN incident_status s ON s.incident_id = r.incident_id
                        WHERE r.device_id = ? AND r.incident_id != ? AND r.received_at >= ?`)
              .get(deviceId, incidentId, since30);
  return { recent24h, resolved30d: o.resolved || 0, genuine30d: o.genuine || 0, falseAlarm30d: o.falseAlarm || 0 };
}

// input: { incidentId, deviceId, eventType, timestamp, rssi, snr }
function score(db, input) {
  ensureTables(db);
  const M = MODEL, eventMs = Date.parse(input.timestamp) || Date.now();
  const site = siteOf(input.deviceId);
  const reading = site ? latestReading(db, site.siteId, eventMs) : null;
  const hist = deviceHistory(db, input.deviceId, input.incidentId, eventMs);
  const localHour = new Date(eventMs + M.night.utcOffsetMinutes * 60000).getUTCHours();

  const features = {
    eventType: input.eventType, siteId: site?.siteId || null,
    heatBand: reading?.heatBand || null, heatIndexC: reading?.heatIndexC ?? null, weatherAgeMin: reading?.ageMin ?? null,
    localHour, ...hist,
    rssi: Number.isFinite(input.rssi) ? input.rssi : null, snr: Number.isFinite(input.snr) ? input.snr : null,
  };

  const f = {};                                                   // factor → points
  f.base = M.base[input.eventType] ?? M.base._default;
  if (reading) {
    const mult = M.heat.multiplier[input.eventType] || 1;
    f.heat = Math.round((M.heat.points[reading.heatBand] || 0) * mult);
  }
  const n = M.night;
  if (n.startHour > n.endHour ? (localHour >= n.startHour || localHour < n.endHour)
                              : (localHour >= n.startHour && localHour < n.endHour)) f.night = n.points;
  if (hist.recent24h >= 3) f.repeat = M.repeat24h.atLeast3;
  else if (hist.recent24h >= 1) f.repeat = M.repeat24h.atLeast1;
  const H = M.history30d;
  if (hist.genuine30d > 0) f.genuineHistory = H.genuinePoints;
  if (hist.resolved30d >= H.minResolved && hist.falseAlarm30d / hist.resolved30d >= H.falseAlarmRate) f.falseAlarmHistory = H.falseAlarmPoints;
  if ((features.rssi != null && features.rssi < M.weakSignal.rssiBelow) ||
      (features.snr != null && features.snr < M.weakSignal.snrBelow)) f.weakSignal = M.weakSignal.points;

  const raw = Object.values(f).reduce((a, b) => a + b, 0);
  const total = Math.max(M.clamp.min, Math.min(M.clamp.max, Math.round(raw)));

  const featureJson = JSON.stringify(features);
  const featureHash = crypto.createHash('sha256').update(featureJson).digest('hex');
  const oracleRef = reading ? `${site.siteId}|${reading.readingId}` : undefined;
  const factors = { ...f, ...(reading ? { heatBand: reading.heatBand, heatIndexC: reading.heatIndexC } : { weather: 'unavailable' }) };
  const context = { modelVersion: M.modelVersion, featureHash, factors, ...(oracleRef ? { oracleRef } : {}) };

  db.prepare(`INSERT OR REPLACE INTO risk_assessments
      (incident_id, device_id, event_type, event_time, model_version, score, features_json, feature_hash, factors_json, oracle_ref, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(input.incidentId, input.deviceId, input.eventType, new Date(eventMs).toISOString(), M.modelVersion,
         total, featureJson, featureHash, JSON.stringify(f), oracleRef || null, new Date().toISOString());

  return { score: total, contextJson: JSON.stringify(context), factors: f, features, oracleRef, modelVersion: M.modelVersion };
}

// Background: copy status/outcome of recent incidents from the ledger into incident_status
// (labels for training + false-alarm history). Runs off the SOS path.
async function refreshOutcomes(db, contract, limit = 200) {
  ensureTables(db);
  const since = new Date(Date.now() - 30 * 24 * 3600e3).toISOString();
  const ids = db.prepare(`SELECT r.incident_id id FROM raw_events r
                          LEFT JOIN incident_status s ON s.incident_id = r.incident_id
                          WHERE r.received_at >= ? AND (s.status IS NULL OR s.status != 'RESOLVED')
                          ORDER BY r.received_at DESC LIMIT ?`).all(since, limit).map(r => r.id);
  const up = db.prepare(`INSERT OR REPLACE INTO incident_status (incident_id, status, outcome, checked_at) VALUES (?,?,?,?)`);
  let updated = 0;
  for (const id of ids) {
    try {
      const inc = JSON.parse(Buffer.from(await contract.evaluateTransaction('GetIncident', id)).toString('utf8'));
      up.run(id, inc.status || null, inc.outcome || null, new Date().toISOString()); updated++;
    } catch { /* not on ledger (e.g. failed submit) — skip */ }
  }
  return updated;
}

module.exports = { score, refreshOutcomes, ensureTables, MODEL };

// node test/riskModel.test.js   — risk model v1 checks (TG-015)
const assert = require('assert');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { score } = require('../risk/riskModel');

const db = new Database(':memory:');
db.exec(`CREATE TABLE raw_events (incident_id TEXT PRIMARY KEY, device_id TEXT, event_type TEXT, raw_payload TEXT, payload_hash TEXT, received_at TEXT);
         CREATE TABLE oracle_readings (site_id TEXT, reading_id TEXT, observed_at TEXT, data_json TEXT, data_hash TEXT, status TEXT, tx_id TEXT, error TEXT, created_at TEXT, anchored_at TEXT, PRIMARY KEY(site_id, reading_id));`);
const reading = (t, band, hi, status = 'ANCHORED') => db.prepare('INSERT OR REPLACE INTO oracle_readings VALUES (?,?,?,?,?,?,?,?,?,?)')
  .run('vsp-telecom', 'om-' + t, t, JSON.stringify({ heatBand: band, heatIndexC: hi }), 'h', status, null, null, t, t);
const event = (id, dev, t) => db.prepare('INSERT INTO raw_events VALUES (?,?,?,?,?,?)').run(id, dev, 'SOS', '{}', 'h', t);
let n = 0; const check = (name, got, want) => { assert.strictEqual(got, want, `${name}: got ${got}, want ${want}`); n++; console.log(`  ✓ ${name} = ${got}`); };

// Day time 10:00 IST = 04:30Z
const DAY = '2026-10-26T04:30:00Z', NIGHT = '2026-10-26T17:45:00Z';   // 23:15 IST
let r = score(db, { incidentId: 'A1', deviceId: 'loneworker-2', eventType: 'SOS', timestamp: DAY });
check('SOS, no weather yet', r.score, 80); assert.strictEqual(JSON.parse(r.contextJson).factors.weather, 'unavailable');

reading('2026-10-26T04:15:00Z', 'DANGER', 43.4);
r = score(db, { incidentId: 'A2', deviceId: 'loneworker-2', eventType: 'INACTIVITY', timestamp: DAY });
check('INACTIVITY in DANGER heat (55 + 18×1.5)', r.score, 82);
assert.strictEqual(r.oracleRef, 'vsp-telecom|om-2026-10-26T04:15:00Z');

r = score(db, { incidentId: 'A3', deviceId: 'loneworker-2', eventType: 'SOS', timestamp: DAY });
check('SOS in DANGER heat (80 + 18)', r.score, 98);

reading('2026-10-26T17:30:00Z', 'CAUTION', 30.1);
r = score(db, { incidentId: 'A4', deviceId: 'loneworker-3', eventType: 'FALL', timestamp: NIGHT });
check('FALL at 23:15 IST in CAUTION (75 + 5×1.5→8 + 8 night)', r.score, 91);

r = score(db, { incidentId: 'A5', deviceId: 'loneworker-3', eventType: 'INACTIVITY', timestamp: '2026-10-26T20:00:00Z' });
check('weather 2.5 h old is ignored (55 + night 8)', r.score, 63);

for (const [i, t] of ['2026-10-26T01:00:00Z', '2026-10-26T02:00:00Z', '2026-10-26T03:00:00Z'].entries()) event('P' + i, 'loneworker-4', t);
r = score(db, { incidentId: 'A6', deviceId: 'loneworker-4', eventType: 'SOS', timestamp: DAY });
check('3 earlier events in 24 h (80 + 18 heat + 10 repeat → capped)', r.score, 100);

db.exec(`CREATE TABLE IF NOT EXISTS incident_status (incident_id TEXT PRIMARY KEY, status TEXT, outcome TEXT, checked_at TEXT)`);
for (const [i, o] of ['FALSE_ALARM', 'FALSE_ALARM', 'FALSE_ALARM', 'NEAR_MISS'].entries()) {
  event('H' + i, 'loneworker-5', '2026-10-10T05:00:00Z');
  db.prepare('INSERT INTO incident_status VALUES (?,?,?,?)').run('H' + i, 'RESOLVED', o, DAY);
}
r = score(db, { incidentId: 'A7', deviceId: 'loneworker-5', eventType: 'SOS', timestamp: DAY });
check('device with 3/4 false alarms in 30 d (80 + 18 − 10)', r.score, 88);

db.prepare('INSERT INTO incident_status VALUES (?,?,?,?)').run('P0', 'RESOLVED', 'GENUINE', DAY);
r = score(db, { incidentId: 'A8', deviceId: 'loneworker-4', eventType: 'INACTIVITY', timestamp: DAY });
check('genuine history present', r.factors.genuineHistory, 5);

r = score(db, { incidentId: 'A9', deviceId: 'loneworker-1', eventType: 'INACTIVITY', timestamp: '2026-10-26T04:20:00Z', rssi: -121, snr: -3 });
check('weak signal (55 + 27 heat + 4)', r.score, 86);

r = score(db, { incidentId: 'B1', deviceId: 'unknown-dev', eventType: 'SOS', timestamp: DAY });
check('device not mapped to a site gets no heat factor', r.score, 80);

const row = db.prepare('SELECT * FROM risk_assessments WHERE incident_id = ?').get('A2');
assert.strictEqual(crypto.createHash('sha256').update(row.features_json).digest('hex'), row.feature_hash); n++;
console.log('  ✓ features stored off-chain and featureHash matches');

// The context string must be accepted by the real chaincode 1.1
let CC; try { CC = require(process.env.CC_PATH || '../../safety-chaincode/lib/safetyContract.js'); }
catch (e) { console.log(`  - chaincode check skipped (${e.message.split('\n')[0]})\n\nriskModel: ${n} checks passed`); process.exit(0); }
const cc = new CC(), state = new Map();
const ctx = role => ({ clientIdentity: { getAttributeValue: () => role, getID: () => role },
  stub: { async getState(k) { return state.has(k) ? Buffer.from(state.get(k)) : Buffer.alloc(0); }, async putState(k, v) { state.set(k, v.toString()); },
          createCompositeKey(t, a) { return '\u0000' + t + '\u0000' + a.join('\u0000') + '\u0000'; }, setEvent() {} } });
(async () => {
  const data = '{"heatBand":"DANGER"}';
  await cc.SubmitOracleData(ctx('oracle'), 'vsp-telecom', 'om-2026-10-26T04:15:00Z', 'open-meteo', '2026-10-26T04:15:00Z', crypto.createHash('sha256').update(data).digest('hex'), data);
  const a2 = score(db, { incidentId: 'A2', deviceId: 'loneworker-2', eventType: 'INACTIVITY', timestamp: DAY });
  const out = JSON.parse(await cc.LogIncidentWithContext(ctx('gateway'), 'A2', 'loneworker-2', 'INACTIVITY', 'a'.repeat(64), DAY, String(a2.score), a2.contextJson));
  assert.strictEqual(out.riskScore, '82'); assert.strictEqual(out.risk.factors.heat, 27); assert.strictEqual(out.risk.modelVersion, 'risk-v1'); n++;
  console.log(`  ✓ chaincode 1.1 accepts the context (${a2.contextJson.length} bytes): risk ${out.riskScore}, factors ${JSON.stringify(out.risk.factors)}`);
  console.log(`\nriskModel: ${n} checks passed`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

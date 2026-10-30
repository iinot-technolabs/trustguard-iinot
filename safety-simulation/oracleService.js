'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// oracleService.js — TrustGuard IIoT weather / heat-stress oracle (TG-014)
//
// Every 15 minutes, for each site in sites.json (config/client/sites.json, else oracle/sites.json):
//   1. fetch current conditions from Open-Meteo (CC BY 4.0, free for non-commercial use)
//   2. compute heat index + NWS heat band
//   3. store the reading in offchain.db (table oracle_readings)
//   4. anchor it on the ledger: SubmitOracleData(siteId, readingId, source, observedAt,
//      sha256(dataJson), dataJson) signed by the network's oracle identity (role=oracle).
//      The chaincode recomputes the hash, so the ledger copy is exactly what was fetched.
//
// The risk scoring links incidents to the latest reading via oracleRef "<siteId>|<readingId>".
//
// Usage:  node oracleService.js            run forever (systemd: trustguard-oracle.service)
//         node oracleService.js --once     one cycle, then exit
//         node oracleService.js --dry-run  fetch + print only, no ledger, no DB
// ─────────────────────────────────────────────────────────────────────────────
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const grpc     = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const { heatIndexC, heatBand } = require('./oracle/heatStress');

const ONCE    = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');

// Network, identity and per-client sites come from the deployed network model (common/tgnet.js).
// ORACLE_IDENTITY overrides the default: the first identity with role "oracle".
const tg           = require('../common/tgnet');
const DB_PATH      = tg.offchainDb();
const SITES        = JSON.parse(fs.readFileSync(tg.clientFile('sites.json', path.join(__dirname, 'oracle', 'sites.json')), 'utf8')).sites;
function oracleIdentity() {
  const id = process.env.ORACLE_IDENTITY ? tg.identity(process.env.ORACLE_IDENTITY) : tg.identityForRole('oracle');
  if (!id) throw new Error('The deployed network has no identity with role "oracle". Add one (regulator org) in the Network Designer.');
  return id;
}
const INTERVAL_MIN = parseInt(process.env.ORACLE_INTERVAL_MIN || '15', 10);
const SOURCE       = 'open-meteo.com/v1/forecast';
const CURRENT_VARS = [
  'temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'precipitation',
  'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'is_day',
];

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── Weather fetch ────────────────────────────────────────────────────────────
async function fetchReading(site) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${site.latitude}&longitude=${site.longitude}`
    + `&current=${CURRENT_VARS.join(',')}&timezone=UTC&wind_speed_unit=kmh`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const body = await res.json();
  const c = body.current;
  if (!c || !c.time) throw new Error('Open-Meteo response has no current block');

  const observedAt = `${c.time}:00Z`;                              // "2026-10-26T10:15" → ISO UTC
  const readingId  = `om-${c.time.replace(/[-:]/g, '')}Z`;          // "om-20261026T1015Z"
  const hi = heatIndexC(c.temperature_2m, c.relative_humidity_2m);
  // Fixed key order → identical JSON (and hash) for identical data
  const data = {
    siteId: site.siteId, siteName: site.name,
    latitude: site.latitude, longitude: site.longitude,
    observedAt, provider: 'Open-Meteo (CC BY 4.0)',
    tempC: c.temperature_2m, humidityPct: c.relative_humidity_2m,
    apparentTempC: c.apparent_temperature, heatIndexC: hi, heatBand: heatBand(hi),
    precipMm: c.precipitation, windKmh: c.wind_speed_10m, gustKmh: c.wind_gusts_10m,
    weatherCode: c.weather_code, isDay: c.is_day,
  };
  const dataJson = JSON.stringify(data);
  const dataHash = crypto.createHash('sha256').update(dataJson).digest('hex');
  return { siteId: site.siteId, readingId, observedAt, data, dataJson, dataHash };
}

// ── Off-chain store ──────────────────────────────────────────────────────────
function openDb() {
  const db = new Database(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS oracle_readings (
    site_id     TEXT NOT NULL,
    reading_id  TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    data_json   TEXT NOT NULL,
    data_hash   TEXT NOT NULL,
    status      TEXT NOT NULL,      -- PENDING | ANCHORED | FAILED
    tx_id       TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL,
    anchored_at TEXT,
    PRIMARY KEY (site_id, reading_id))`);
  return db;
}

// ── Fabric ───────────────────────────────────────────────────────────────────
let fabric = null;
function getContract() {
  if (fabric) return fabric.contract;
  const id = oracleIdentity();
  fabric = tg.connect(id, { grpc, connect, signers }, {
    endorseOptions: () => ({ deadline: Date.now() + 15000 }),
    submitOptions:  () => ({ deadline: Date.now() + 15000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
  });
  log(`Fabric connected as ${id.name} (${id.mspId}) via ${id.peerEndpoint}, channel ${id.channel}`);
  return fabric.contract;
}

function resetFabric() {
  try { fabric?.gateway.close(); fabric?.client.close(); } catch { /* ignore */ }
  fabric = null;
}

async function anchor(db, r) {
  const contract = getContract();
  try {
    const sub = await contract.submitAsync('SubmitOracleData', {
      arguments: [r.siteId, r.readingId, SOURCE, r.observedAt, r.dataHash, r.dataJson],
    });
    const status = await sub.getStatus();
    if (!status.successful) throw new Error(`commit status ${status.code}`);
    db.prepare(`UPDATE oracle_readings SET status='ANCHORED', tx_id=?, error=NULL, anchored_at=?
                WHERE site_id=? AND reading_id=?`).run(sub.getTransactionId(), new Date().toISOString(), r.siteId, r.readingId);
    log(`⛓  anchored ${r.siteId}|${r.readingId} tx ${sub.getTransactionId().slice(0, 16)}…`);
  } catch (err) {
    const msg = err.details?.map(d => d.message).join('; ') || err.message;
    if (/already exists/.test(msg)) {
      db.prepare(`UPDATE oracle_readings SET status='ANCHORED', error=NULL WHERE site_id=? AND reading_id=?`).run(r.siteId, r.readingId);
      log(`⛓  ${r.siteId}|${r.readingId} already on ledger`);
      return;
    }
    if (/UNAVAILABLE|DEADLINE|connect/i.test(msg)) resetFabric();
    db.prepare(`UPDATE oracle_readings SET status='FAILED', error=? WHERE site_id=? AND reading_id=?`).run(msg.slice(0, 500), r.siteId, r.readingId);
    log(`✗ anchor failed ${r.siteId}|${r.readingId}: ${msg}`);
  }
}

// ── One cycle ────────────────────────────────────────────────────────────────
async function cycle(db) {
  for (const site of SITES) {
    let r;
    try { r = await fetchReading(site); }
    catch (err) { log(`✗ fetch failed for ${site.siteId}: ${err.message}`); continue; }

    const d = r.data;
    log(`☀  ${site.siteId} ${r.observedAt}  ${d.tempC}°C  RH ${d.humidityPct}%  HI ${d.heatIndexC}°C ${d.heatBand}`);
    if (DRY_RUN) { console.log(r.dataJson, '\nsha256', r.dataHash); continue; }

    const row = db.prepare('SELECT status FROM oracle_readings WHERE site_id=? AND reading_id=?').get(r.siteId, r.readingId);
    if (row?.status === 'ANCHORED') { log(`   ${r.readingId} already anchored — waiting for the next update`); continue; }
    if (!row) {
      db.prepare(`INSERT INTO oracle_readings (site_id, reading_id, observed_at, data_json, data_hash, status, created_at)
                  VALUES (?,?,?,?,?,'PENDING',?)`).run(r.siteId, r.readingId, r.observedAt, r.dataJson, r.dataHash, new Date().toISOString());
    }
    await anchor(db, r);
  }
  // Retry earlier failures (newest first, max 5 per cycle)
  if (!DRY_RUN) {
    const failed = db.prepare(`SELECT site_id siteId, reading_id readingId, observed_at observedAt, data_json dataJson, data_hash dataHash
                               FROM oracle_readings WHERE status IN ('FAILED','PENDING') ORDER BY observed_at DESC LIMIT 5`).all();
    for (const f of failed) await anchor(db, f);
  }
}

// Run at 1 minute past each quarter hour, so Open-Meteo has published the new value
function msToNextSlot() {
  const now = new Date(), slot = INTERVAL_MIN * 60000;
  const next = Math.ceil((now.getTime() - 60000) / slot) * slot + 60000;
  return Math.max(next - now.getTime(), 5000);
}

async function main() {
  const who = DRY_RUN ? 'DRY RUN' : (id => `as ${id.name}@${id.mspId}`)(oracleIdentity());
  log(`Oracle starting: ${SITES.length} site(s), every ${INTERVAL_MIN} min, ${who}`);
  const db = DRY_RUN ? null : openDb();
  await cycle(db);
  if (ONCE || DRY_RUN) { resetFabric(); return; }
  const loop = async () => {
    try { await cycle(db); } catch (err) { log('✗ cycle error:', err.message); }
    setTimeout(loop, msToNextSlot());
  };
  setTimeout(loop, msToNextSlot());
}

process.on('SIGTERM', () => { resetFabric(); process.exit(0); });
process.on('SIGINT',  () => { resetFabric(); process.exit(0); });
main().catch(err => { console.error(err); process.exit(1); });

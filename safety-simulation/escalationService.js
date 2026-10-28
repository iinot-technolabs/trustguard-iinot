'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// escalationService.js — TrustGuard IIoT auto-escalation (TG-016)
//
// Every 15 s: reads recent incidents from the ledger (GetIncident, as the gateway identity),
//   • announces new TRIGGERED incidents,
//   • escalates unacknowledged ones one level at a time per escalation/policy.json
//     via EscalateIncident (chaincode 1.1) — each level is its own ledger transaction,
//   • notifies the groups named for that level (log always; Telegram if configured).
// Only incidents created after the service was first started are touched, so the
// existing test backlog is never escalated. Decisions: escalation/policy.js (unit-tested).
// ─────────────────────────────────────────────────────────────────────────────
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const grpc     = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const { nextStep, isNewAlert } = require('./escalation/policy');
const notify = require('./escalation/notify');

// optional secrets (Telegram) — simple KEY=VALUE file
const envFile = path.join(__dirname, 'escalation', '.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// Network and identity from the deployed network model (common/tgnet.js); policy and sites per client.
// ESCALATION_IDENTITY overrides the default: the first identity with role "gateway".
const tg      = require('../common/tgnet');
const POLICY  = JSON.parse(fs.readFileSync(tg.clientFile('policy.json', path.join(__dirname, 'escalation', 'policy.json')), 'utf8'));
const SITES   = (() => { try { return JSON.parse(fs.readFileSync(tg.clientFile('sites.json', path.join(__dirname, 'oracle', 'sites.json')), 'utf8')).sites; } catch { return []; } })();
const DB_PATH = tg.offchainDb();
const ONCE    = process.argv.includes('--once');
const log = (...a) => console.log(new Date().toISOString(), ...a);

function openDb() {
  const db = new Database(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS escalation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS escalation_log (
             incident_id TEXT NOT NULL, level INTEGER NOT NULL, action TEXT NOT NULL,
             tx_ok INTEGER, channel TEXT, sent INTEGER, failed INTEGER, detail TEXT, at TEXT NOT NULL,
             PRIMARY KEY (incident_id, level, action));`);
  if (!db.prepare(`SELECT value FROM escalation_meta WHERE key='since'`).get()) {
    db.prepare(`INSERT INTO escalation_meta VALUES ('since', ?)`).run(new Date().toISOString());
  }
  return db;
}

let fabric = null;
function contract() {
  if (fabric) return fabric.contract;
  const id = process.env.ESCALATION_IDENTITY ? tg.identity(process.env.ESCALATION_IDENTITY) : tg.identityForRole('gateway');
  if (!id) throw new Error('The deployed network has no identity with role "gateway" for escalations.');
  fabric = tg.connect(id, { grpc, connect, signers });
  return fabric.contract;
}
function resetFabric() { try { fabric?.gateway.close(); fabric?.client.close(); } catch { /* ignore */ } fabric = null; }
const errText = e => (e.details || []).map(d => d.message).join('; ') || e.message;

function message(inc, headline) {
  const site = SITES.find(s => (s.devices || []).includes(inc.deviceId));
  const ist = new Date(Date.parse(inc.timestamp) + 330 * 60000).toISOString().slice(11, 16);
  return `${headline}\n${inc.eventType} · ${inc.deviceId} · risk ${inc.riskScore}` +
         `${site ? `\n${site.name}` : ''}\nRaised ${ist} IST · ${inc.incidentId}\n${POLICY.dashboardUrl}`;
}

async function scan(db) {
  const since = db.prepare(`SELECT value FROM escalation_meta WHERE key='since'`).get().value;
  const sinceMs = Date.parse(since), now = Date.now();
  const from = new Date(Math.max(sinceMs, now - POLICY.maxAgeHours * 3600e3)).toISOString();
  const ids = db.prepare(`SELECT incident_id FROM raw_events WHERE received_at >= ? ORDER BY received_at`).all(from).map(r => r.incident_id);
  const done = db.prepare(`SELECT 1 FROM escalation_log WHERE incident_id=? AND level=? AND action=?`);
  const record = db.prepare(`INSERT OR REPLACE INTO escalation_log VALUES (?,?,?,?,?,?,?,?,?)`);

  for (const id of ids) {
    let inc;
    try { inc = JSON.parse(Buffer.from(await contract().evaluateTransaction('GetIncident', id)).toString('utf8')); }
    catch (e) { const m = errText(e); if (/UNAVAILABLE|DEADLINE/.test(m)) { resetFabric(); throw e; } continue; }  // not on ledger yet

    if (isNewAlert(inc, now, POLICY, sinceMs) && !done.get(id, 0, 'new')) {
      const r = await notify.send(['supervisors'], message(inc, `🚨 New ${inc.eventType} alert`));
      record.run(id, 0, 'new', null, r.channel, r.sent, r.failed, null, new Date().toISOString());
      log(`🚨 new ${inc.eventType} ${id} (${inc.deviceId}, risk ${inc.riskScore}) → ${r.channel}${r.sent ? ` ×${r.sent}` : ''}`);
    }

    const step = nextStep(inc, now, POLICY, sinceMs);
    if (!step) continue;
    try {
      await contract().submitTransaction('EscalateIncident', id, step.reason, new Date().toISOString());
    } catch (e) {
      const m = errText(e);
      if (/cannot change to ESCALATED|MVCC/.test(m)) { log(`↷ ${id}: ${m.split(',').pop().trim()} — skipped`); continue; } // acknowledged meanwhile
      if (/UNAVAILABLE|DEADLINE/.test(m)) resetFabric();
      log(`✗ escalate ${id} L${step.level} failed: ${m}`); continue;
    }
    const r = await notify.send(step.notify, message(inc, `⚠️ ESCALATED to level ${step.level}: ${step.reason}`));
    record.run(id, step.level, 'escalate', 1, r.channel, r.sent, r.failed, step.reason, new Date().toISOString());
    log(`⬆ ${id} → level ${step.level} (${step.reason}) → ${step.notify.join('+')} via ${r.channel}${r.sent ? ` ×${r.sent}` : ''}`);
  }
}

async function main() {
  if (process.argv.includes('--telegram-test')) {
    if (!process.env.TELEGRAM_BOT_TOKEN) { console.log('TELEGRAM_BOT_TOKEN not set in escalation/.env'); process.exit(1); }
    for (const g of ['supervisors', 'safetyOfficer', 'regulator']) {
      const r = await notify.send([g], `✅ TrustGuard IIoT test message for group "${g}"`);
      console.log(`${g}: ${r.sent} sent, ${r.failed} failed (${notify.chatIds([g]).length} chat ids)`);
    }
    return;
  }
  const db = openDb();
  const since = db.prepare(`SELECT value FROM escalation_meta WHERE key='since'`).get().value;
  const tg = process.env.TELEGRAM_BOT_TOKEN ? `Telegram on (${notify.chatIds(['supervisors', 'safetyOfficer', 'regulator']).length} chats)` : 'Telegram off (log only)';
  log(`Escalation service: levels ${POLICY.levels.map(l => `L${l.level}@${l.afterMinutes}m`).join(', ')}; incidents since ${since}; ${tg}`);
  const loop = async () => {
    try { await scan(db); } catch (e) { log('✗ scan error:', errText(e)); }
    if (!ONCE) setTimeout(loop, POLICY.scanIntervalSec * 1000);
  };
  await loop();
  if (ONCE) { resetFabric(); db.close(); }
}
process.on('SIGTERM', () => { resetFabric(); process.exit(0); });
main().catch(e => { console.error(e); process.exit(1); });

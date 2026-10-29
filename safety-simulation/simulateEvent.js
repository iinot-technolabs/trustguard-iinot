'use strict';
/**
 * simulateEvent.js — end-to-end smoke test of a deployed TrustGuard network (test T5).
 *
 * Uses the app identities from the network config (one per role) and walks an incident
 * through the safetycc 1.3 lifecycle, checking each role's permissions on the way:
 *
 *   gateway     LogIncidentWithContext (raw payload kept off-chain, SHA-256 on-chain)
 *   supervisor  acknowledge → resolve GENUINE → reportable → record Form 18 hash
 *   gateway     escalate a second, unacknowledged incident
 *   oracle      SubmitOracleData (if the network has an oracle identity)
 *   auditor     GetAllIncidents, GetComplianceScore, GetIncidentHistory
 *   insurer     GetIncidentsByDevice allowed, GetAllIncidents refused (if an insurer exists)
 *   negative    supervisor may not log incidents; gateway may not resolve
 *
 * Usage: node simulateEvent.js            exit code 0 = every check passed
 * Writes only test incidents (ids SIM-…) and one test reading (site "sim-test").
 */
const crypto   = require('crypto');
const Database = require('better-sqlite3');
const grpc     = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const tg       = require('../common/tgnet');

const deps = { grpc, connect, signers };
const now = () => new Date().toISOString();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const text = b => Buffer.from(b).toString('utf8');
const errText = e => (e.details || []).map(d => d.message).join('; ') || e.message;

let passed = 0, failed = 0;
async function check(name, fn) {
  try { const r = await fn(); console.log(`  ✓ ${name}${typeof r === 'string' ? `  ${r}` : ''}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${errText(e)}`); failed++; }
}
async function refused(name, fn, pattern) {
  try { await fn(); console.log(`  ✗ ${name}: was allowed`); failed++; }
  catch (e) {
    const msg = errText(e);
    if (pattern.test(msg)) { console.log(`  ✓ ${name} (refused)`); passed++; }
    else { console.log(`  ✗ ${name}: refused for another reason: ${msg}`); failed++; }
  }
}

function as(role, orgType) {
  const id = tg.identityForRole(role, orgType);
  if (!id) return null;
  const c = tg.connect(id, deps);
  c.id = id;
  return c;
}

async function main() {
  const net = tg.summary();
  console.log(`Network: ${net.network} · channel ${net.channel} · ${net.chaincode} ${net.chaincodeVersion} · policy ${net.endorsementPolicy}\n`);

  const gw  = as('gateway');
  const sup = as('supervisor');
  const aud = as('auditor');
  const ora = as('oracle');
  const ins = as('claims-reviewer');
  if (!gw || !sup || !aud) throw new Error('The network needs identities with roles gateway, supervisor and auditor.');
  console.log(`Identities: ${[gw, sup, aud, ora, ins].filter(Boolean).map(c => `${c.id.name}=${c.id.role}@${c.id.mspId}`).join(', ')}\n`);

  const db = new Database(tg.offchainDb());
  db.exec(`CREATE TABLE IF NOT EXISTS raw_events (incident_id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
           event_type TEXT NOT NULL, raw_payload TEXT NOT NULL, payload_hash TEXT NOT NULL, received_at TEXT NOT NULL)`);

  const tag = crypto.randomBytes(3).toString('hex').toUpperCase();
  const device = `sim-beacon-${tag.toLowerCase()}`;
  const incA = `SIM-${tag}-A`, incB = `SIM-${tag}-B`;
  const raw = JSON.stringify({ deviceId: device, wakeReason: 4, battery: 87, receivedAt: now(), simulated: true });
  const hash = sha(raw);
  db.prepare('INSERT INTO raw_events VALUES (?,?,?,?,?,?)').run(incA, device, 'SOS', raw, hash, now());

  console.log('Gateway');
  await check(`log ${incA} with context`, async () => {
    await gw.contract.submitTransaction('LogIncidentWithContext', incA, device, 'SOS', hash, now(), '90',
      JSON.stringify({ modelVersion: 'sim', featureHash: sha('sim'), factors: { simulated: 1 } }));
  });
  await check(`log ${incB}`, async () => {
    await gw.contract.submitTransaction('LogIncident', incB, device, 'FALL', sha(raw + 'B'), now(), '85');
  });
  await check(`escalate ${incB} (unacknowledged)`, async () => {
    const r = JSON.parse(text(await gw.contract.submitTransaction('EscalateIncident', incB, 'L1: not acknowledged (simulation)', now())));
    return `status ${r.status}, level ${r.escalationLevel}`;
  });
  await refused('gateway may not resolve', () =>
    gw.contract.submitTransaction('ResolveIncident', incA, 'GENUINE', 'x', now()), /denied|not allowed|cannot|role/i);

  console.log('Supervisor');
  await check('acknowledge', () => sup.contract.submitTransaction('UpdateIncidentStatus', incA, 'ACKNOWLEDGED', now()));
  await check('resolve as GENUINE', () => sup.contract.submitTransaction('ResolveIncident', incA, 'GENUINE', 'Simulation: worker assisted', now()));
  await check('mark reportable', () => sup.contract.submitTransaction('SetReportability', incA, 'REPORTABLE', 'Simulation', now()));
  await check('record Form 18 hash', async () => {
    const r = JSON.parse(text(await sup.contract.submitTransaction('RecordStatutoryReport', incA, 'FORM18', sha(`form18:${incA}`), now())));
    return `${(r.statutoryReports || []).length} report(s) on record`;
  });
  await refused('supervisor may not log incidents', () =>
    sup.contract.submitTransaction('LogIncident', `SIM-${tag}-X`, device, 'SOS', hash, now(), '50'), /denied|not allowed|cannot|role/i);

  if (ora) {
    console.log('Oracle');
    await check('anchor a test reading', async () => {
      const data = JSON.stringify({ siteId: 'sim-test', observedAt: now(), tempC: 30, humidityPct: 50, heatBand: 'CAUTION', simulated: true });
      await ora.contract.submitTransaction('SubmitOracleData', 'sim-test', `sim-${tag}`, 'simulation', now(), sha(data), data);
    });
  } else console.log('Oracle: no identity with role oracle in this network — skipped');

  console.log('Auditor');
  await check('read the incident', async () => {
    const r = JSON.parse(text(await aud.contract.evaluateTransaction('GetIncident', incA)));
    if (r.eventHash !== hash) throw new Error('on-chain hash differs from the off-chain payload');
    return `${r.status}, outcome ${r.outcome}, hash matches off-chain payload`;
  });
  await check('list all incidents', async () => `${JSON.parse(text(await aud.contract.evaluateTransaction('GetAllIncidents'))).length} incidents`);
  await check('history of the incident', async () => `${JSON.parse(text(await aud.contract.evaluateTransaction('GetIncidentHistory', incA))).length} ledger entries`);
  await check('compliance score', async () => {
    const r = JSON.parse(text(await aud.contract.evaluateTransaction('GetComplianceScore', new Date(Date.now() - 864e5).toISOString(), '', now())));
    return `overall ${r.overall.score} (${r.overall.grade})`;
  });

  if (ins) {
    console.log('Insurer');
    await check('incidents for one device', async () =>
      `${JSON.parse(text(await ins.contract.evaluateTransaction('GetIncidentsByDevice', device, '', ''))).length} incident(s)`);
    await refused('insurer may not list all incidents', () => ins.contract.evaluateTransaction('GetAllIncidents'), /denied|not allowed|cannot|role/i);
  } else console.log('Insurer: not part of this network — skipped');

  for (const c of [gw, sup, aud, ora, ins]) if (c) { c.gateway.close(); c.client.close(); }
  db.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(`\nSmoke test could not run: ${errText(e)}`); process.exit(2); });

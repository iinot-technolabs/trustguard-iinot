'use strict';

/**
 * TrustGuard IIoT — Latency Load Test (VM Edition)
 *
 * Tests all four scenarios and saves results to latency_log table.
 * Run with: node loadTestVM.js --scenario <name> --beacons <1|3|5>
 *
 * Scenarios:
 *   laptop-ttn        Local laptop + TTN (import from existing SQLite)
 *   vm-ttn            Cloud VM + TTN (run this on the VM)
 *   vm-chirpstack     Cloud VM + ChirpStack (run after migration)
 *   vm-optimised      Cloud VM + ChirpStack + BatchTimeout=500ms
 */

const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const grpc     = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const tg = require('../common/tgnet');   // network, identities, paths from the deployed config

// ── Config ────────────────────────────────────────────────────────────────────
const SCENARIO    = process.argv.includes('--scenario')
  ? process.argv[process.argv.indexOf('--scenario') + 1]
  : 'vm-ttn';
const BEACON_COUNTS = process.argv.includes('--beacons')
  ? [parseInt(process.argv[process.argv.indexOf('--beacons') + 1])]
  : [1, 3, 5];

const DB_PATH    = tg.offchainDb();

const WAKE_REASON_MAP = {
  2: { eventType: 'FALL',       riskScore: '85' },
  3: { eventType: 'INACTIVITY', riskScore: '70' },
  4: { eventType: 'SOS',        riskScore: '95' },
};

// ── DB setup ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS raw_events (
    incident_id   TEXT PRIMARY KEY,
    device_id     TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    raw_payload   TEXT NOT NULL,
    payload_hash  TEXT NOT NULL,
    received_at   TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS latency_log (
    incident_id    TEXT PRIMARY KEY,
    device_id      TEXT,
    event_type     TEXT,
    beacon_count   INTEGER,
    scenario       TEXT,
    L3_mqtt_ms     REAL,
    L4_hash_ms     REAL,
    L5_fabric_ms   REAL,
    total_e2e_ms   REAL,
    recorded_at    TEXT
  )
`);

// Add scenario column if upgrading from old schema
try {
  db.exec(`ALTER TABLE latency_log ADD COLUMN scenario TEXT`);
} catch(e) { /* column already exists */ }

// ── Fabric connection ─────────────────────────────────────────────────────────
async function getFabricConnection() {
  const { gateway, client: grpcClient } = tg.connect(tg.identityForRole('gateway'), { grpc, connect, signers });

  return {
    gateway,
    grpcClient,
    contract: gateway.getNetwork(tg.load().network.channel).getContract(tg.load().chaincode.name)
  };
}

// ── Simulate one beacon event and record all latencies ────────────────────────
async function simulateBeaconEvent(beaconName, eventType, beaconCount, scenario) {
  const entry = Object.entries(WAKE_REASON_MAP).find(([,v]) => v.eventType === eventType);
  const wakeReason = parseInt(entry[0]);
  const { riskScore } = entry[1];

  const now = new Date().toISOString();
  const simulatedPayload = {
    end_device_ids: { device_id: beaconName },
    received_at: now,
    uplink_message: {
      decoded_payload: {
        digital_in_3: wakeReason,
        digital_in_5: 1
      }
    },
    _scenario: scenario
  };

  const t_start   = Date.now();
  const incidentId = `LOAD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const rawStr     = JSON.stringify(simulatedPayload);

  // L4: hash + SQLite write
  const t4 = Date.now();
  const payloadHash = crypto.createHash('sha256').update(rawStr).digest('hex');
  db.prepare(`
    INSERT OR IGNORE INTO raw_events
      (incident_id, device_id, event_type, raw_payload, payload_hash, received_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(incidentId, beaconName, eventType, rawStr, payloadHash, now);
  const L4_hash_ms = Date.now() - t4;

  // L5: Fabric endorse + order + commit
  const t5 = Date.now();
  const { gateway, grpcClient, contract } = await getFabricConnection();
  await contract.submitTransaction(
    'LogIncident', incidentId, beaconName,
    eventType, payloadHash, now, riskScore
  );
  gateway.close();
  grpcClient.close();
  const L5_fabric_ms = Date.now() - t5;

  const total_e2e_ms = Date.now() - t_start;
  const L3_mqtt_ms   = 0; // 0 in simulation — real value comes from live MQTT

  db.prepare(`
    INSERT OR REPLACE INTO latency_log
      (incident_id, device_id, event_type, beacon_count, scenario,
       L3_mqtt_ms, L4_hash_ms, L5_fabric_ms, total_e2e_ms, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    incidentId, beaconName, eventType, beaconCount, scenario,
    L3_mqtt_ms, L4_hash_ms, L5_fabric_ms,
    total_e2e_ms, new Date().toISOString()
  );

  return { incidentId, L4_hash_ms, L5_fabric_ms, total_e2e_ms };
}

// ── Run one scenario with N concurrent beacons ────────────────────────────────
async function runScenario(beaconCount, scenario, eventType = 'SOS') {
  console.log(`\n🔥 [${scenario}] ${beaconCount} beacon(s) simultaneously`);
  const beacons = Array.from({ length: beaconCount }, (_, i) => `loneworker-${i + 1}`);
  const t_scenario = Date.now();

  const results = await Promise.all(
    beacons.map(name => simulateBeaconEvent(name, eventType, beaconCount, scenario))
  );

  const elapsed = Date.now() - t_scenario;
  console.log(`✅ Completed in ${elapsed}ms`);
  results.forEach((r, i) => {
    console.log(
      `   ${beacons[i].padEnd(14)} ` +
      `L4=${String(r.L4_hash_ms+'ms').padEnd(8)} ` +
      `L5=${String(r.L5_fabric_ms+'ms').padEnd(8)} ` +
      `total=${r.total_e2e_ms}ms`
    );
  });
  return results;
}

// ── Print summary table from DB ───────────────────────────────────────────────
function printSummary() {
  console.log('\n' + '═'.repeat(90));
  console.log('📊 LATENCY SUMMARY — ALL SCENARIOS');
  console.log('═'.repeat(90));

  const rows = db.prepare(`
    SELECT
      scenario,
      beacon_count,
      COUNT(*)                        AS events,
      ROUND(AVG(L4_hash_ms),   1)    AS avg_L4_ms,
      ROUND(AVG(L5_fabric_ms), 1)    AS avg_L5_ms,
      ROUND(MIN(L5_fabric_ms), 1)    AS min_L5_ms,
      ROUND(MAX(L5_fabric_ms), 1)    AS max_L5_ms,
      ROUND(AVG(total_e2e_ms), 1)    AS avg_total_ms,
      ROUND(MIN(total_e2e_ms), 1)    AS min_total_ms,
      ROUND(MAX(total_e2e_ms), 1)    AS max_total_ms
    FROM latency_log
    WHERE scenario IS NOT NULL
    GROUP BY scenario, beacon_count
    ORDER BY scenario, beacon_count
  `).all();

  if (rows.length === 0) {
    console.log('No data yet — run with a scenario first.');
    return;
  }

  console.log(
    '\nScenario              Beacons  Events  L4(hash)  L5 avg    L5 min    L5 max    Total avg  Total min  Total max'
  );
  console.log('-'.repeat(115));
  rows.forEach(r => {
    console.log(
      `${String(r.scenario||'unknown').padEnd(22)}` +
      `${String(r.beacon_count).padEnd(9)}` +
      `${String(r.events).padEnd(8)}` +
      `${String(r.avg_L4_ms+'ms').padEnd(10)}` +
      `${String(r.avg_L5_ms+'ms').padEnd(10)}` +
      `${String(r.min_L5_ms+'ms').padEnd(10)}` +
      `${String(r.max_L5_ms+'ms').padEnd(10)}` +
      `${String(r.avg_total_ms+'ms').padEnd(11)}` +
      `${String(r.min_total_ms+'ms').padEnd(11)}` +
      `${r.max_total_ms}ms`
    );
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('TrustGuard IIoT — Latency Load Test');
  console.log(`Scenario : ${SCENARIO}`);
  console.log(`Beacons  : ${BEACON_COUNTS.join(', ')}`);
  console.log(`DB       : ${DB_PATH}`);
  console.log(`Network  : ${tg.load().network.name} (${tg.load().network.channel})`);

  if (process.argv.includes('--summary')) {
    printSummary();
    db.close();
    return;
  }

  for (const count of BEACON_COUNTS) {
    await runScenario(count, SCENARIO, 'SOS');
    if (count < BEACON_COUNTS[BEACON_COUNTS.length - 1]) {
      console.log('\n⏳ Waiting 8s for Fabric to settle...');
      await new Promise(r => setTimeout(r, 8000));
    }
  }

  printSummary();
  db.close();
}

main().catch(err => {
  console.error('❌ Load test failed:', err.message);
  process.exit(1);
});

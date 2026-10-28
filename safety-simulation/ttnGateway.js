'use strict';

// ttnGateway.js — IINoT Live Gateway (TTN + ChirpStack dual mode)
//
// Subscribes to TTN or ChirpStack MQTT feed, decodes beacon uplinks,
// stores raw payloads off-chain in SQLite, computes SHA-256 hash, and
// submits LogIncident transactions to the Fabric network as the identity
// with role=gateway from the network config (GATEWAY_IDENTITY overrides).
//
// Usage:
//   TTN mode (default):
//     export TTN_APP_ID=iiot-india TTN_ACCESS_KEY=... TTN_REGION=au1
//     node ttnGateway.js
//
//   ChirpStack mode:
//     export GATEWAY_MODE=chirpstack CHIRPSTACK_HOST=localhost
//     export CHIRPSTACK_APP_ID=<your ChirpStack application ID>
//     node ttnGateway.js

const mqtt     = require('mqtt');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const grpc     = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const risk     = require('./risk/riskModel');            // TG-015 risk scoring

// ─────────────────────────────────────────────────────────────
// GATEWAY MODE — set GATEWAY_MODE=chirpstack to use ChirpStack
// Default is 'ttn' — existing behaviour unchanged
// ─────────────────────────────────────────────────────────────
const GATEWAY_MODE        = process.env.GATEWAY_MODE        || 'ttn';

// TTN credentials (used when GATEWAY_MODE=ttn)
const TTN_APP_ID          = process.env.TTN_APP_ID;
const TTN_ACCESS_KEY      = process.env.TTN_ACCESS_KEY;
const TTN_REGION          = process.env.TTN_REGION;

// ChirpStack credentials (used when GATEWAY_MODE=chirpstack)
const CHIRPSTACK_HOST     = process.env.CHIRPSTACK_HOST     || 'localhost';
const CHIRPSTACK_PORT     = parseInt(process.env.CHIRPSTACK_PORT || '1883');
const CHIRPSTACK_USERNAME = process.env.CHIRPSTACK_USERNAME || 'admin';
const CHIRPSTACK_PASSWORD = process.env.CHIRPSTACK_PASSWORD || '';
const CHIRPSTACK_APP_ID   = process.env.CHIRPSTACK_APP_ID;   // per client: ChirpStack → Applications → ID

// Scenario tag for latency report
const SCENARIO = process.env.SCENARIO || (GATEWAY_MODE === 'chirpstack' ? 'vm-chirpstack' : 'vm-ttn');

// ─────────────────────────────────────────────────────────────
// NETWORK — channel, chaincode, peer, TLS, MSP and wallet come from the
// deployed network model (common/tgnet.js). GATEWAY_IDENTITY overrides the
// default: the first identity with role "gateway" in the network config.
// ─────────────────────────────────────────────────────────────
const tg      = require('../common/tgnet');
const DB_PATH = tg.offchainDb();
function gatewayIdentity() {
    const id = process.env.GATEWAY_IDENTITY ? tg.identity(process.env.GATEWAY_IDENTITY) : tg.identityForRole('gateway');
    if (!id) throw new Error('The deployed network has no identity with role "gateway". Add one in the Network Designer.');
    return id;
}

// ─────────────────────────────────────────────────────────────
// BEACON WAKE REASON MAPPING
//   0 = Normal heartbeat  → ignore
//   1 = Motion detected   → ignore
//   2 = Fall detected     → FALL event
//   3 = Inactivity        → INACTIVITY event
//   4 = SOS button        → SOS event
// ─────────────────────────────────────────────────────────────
const WAKE_REASON_MAP = {
    2: { eventType: 'FALL',       riskScore: '85' },
    3: { eventType: 'INACTIVITY', riskScore: '70' },
    4: { eventType: 'SOS',        riskScore: '95' }
};

// ─────────────────────────────────────────────────────────────
// Fabric connection — cached to reuse gRPC across uplinks
// ─────────────────────────────────────────────────────────────
let fabricConnection = null;

async function getFabricConnection() {
    if (fabricConnection) return fabricConnection;
    const id = gatewayIdentity();
    fabricConnection = tg.connect(id, { grpc, connect, signers });
    console.log(`✅ Fabric connection established (${id.name} / ${id.mspId} → ${id.peerEndpoint}, channel ${id.channel})`);
    return fabricConnection;
}

// ─────────────────────────────────────────────────────────────
// SQLite setup — creates tables including latency_log
// ─────────────────────────────────────────────────────────────
function setupDatabase() {
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
            incident_id   TEXT PRIMARY KEY,
            device_id     TEXT,
            event_type    TEXT,
            beacon_count  INTEGER,
            scenario      TEXT,
            L3_mqtt_ms    REAL,
            L4_hash_ms    REAL,
            L5_fabric_ms  REAL,
            total_e2e_ms  REAL,
            recorded_at   TEXT
        )
    `);
    // Add columns if upgrading from old schema
    try { db.exec('ALTER TABLE latency_log ADD COLUMN scenario TEXT'); }     catch(e) {}
    try { db.exec('ALTER TABLE latency_log ADD COLUMN beacon_count INTEGER'); } catch(e) {}
    return db;
}

// ─────────────────────────────────────────────────────────────
// ChirpStack payload parser
// msg.deviceInfo.deviceName       → device name
// msg.object.digitalInput["3"]    → wakeReason (0–4)
// msg.object.digitalInput["5"]    → GPS fix flag
// msg.rxInfo[0].location          → gateway GPS location
// msg.time                        → ISO 8601 timestamp
// ─────────────────────────────────────────────────────────────
function parseChirpStackUplink(raw) {
    const msg          = JSON.parse(raw);
    const deviceId     = msg.deviceInfo?.deviceName || msg.deviceInfo?.devEui || 'unknown';
    const digitalInput = msg.object?.digitalInput || {};
    const wakeReason   = Number(digitalInput['3'] ?? -1);
    const gpsFix       = Number(digitalInput['5'] ?? 0);
    const rxInfo       = msg.rxInfo?.[0] || {};
    const latitude     = rxInfo.location?.latitude  || null;
    const longitude    = rxInfo.location?.longitude || null;
    const rssi         = rxInfo.rssi || null;
    const snr          = rxInfo.snr  || null;
    const timestamp    = msg.time || new Date().toISOString();
    return { deviceId, wakeReason, gpsFix, latitude, longitude, rssi, snr, timestamp };
}

// ─────────────────────────────────────────────────────────────
// Process a single uplink message (TTN or ChirpStack)
// ─────────────────────────────────────────────────────────────
async function processUplink(topic, message) {
    // L3 start — moment MQTT message arrives in Node.js
    const t_mqtt_received = Date.now();
    const raw = message.toString();

    let wakeReason, gpsFix, deviceId, timestamp, rssi = null, snr = null;

    if (GATEWAY_MODE === 'chirpstack') {
        // ── ChirpStack mode ──────────────────────────────────
        let parsed;
        try { parsed = parseChirpStackUplink(raw); }
        catch (err) { console.error('ChirpStack parse error:', err.message); return; }
        ({ deviceId, wakeReason, gpsFix, timestamp, rssi, snr } = parsed);
    } else {
        // ── TTN mode (original) ──────────────────────────────
        const payload = JSON.parse(raw);
        if (!payload.uplink_message || !payload.uplink_message.decoded_payload) { return; }
        const decoded = payload.uplink_message.decoded_payload;
        wakeReason    = decoded.digital_in_3;
        gpsFix        = decoded.digital_in_5;
        deviceId      = payload.end_device_ids?.device_id || 'UNKNOWN';
        timestamp     = payload.received_at || new Date().toISOString();
        rssi          = payload.uplink_message.rx_metadata?.[0]?.rssi ?? null;
        snr           = payload.uplink_message.rx_metadata?.[0]?.snr ?? null;
    }

    // Ignore heartbeats (wakeReason 0 and 1)
    const eventMapping = WAKE_REASON_MAP[wakeReason];
    if (!eventMapping) {
        console.log(`⏭️  Heartbeat ignored (wakeReason: ${wakeReason})`);
        return;
    }

    const { eventType, riskScore } = eventMapping;
    const receivedAt = timestamp;

    // L3: MQTT delivery latency
    const t_chirpstack = new Date(receivedAt).getTime();
    const L3_mqtt_ms   = t_mqtt_received - t_chirpstack;

    const prefix        = GATEWAY_MODE === 'chirpstack' ? 'CS' : 'TTN';
    const incidentId    = prefix + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const rawPayloadStr = raw;

    // L4 start: hash + SQLite write
    const t4_start    = Date.now();
    const payloadHash = crypto.createHash('sha256').update(rawPayloadStr).digest('hex');

    console.log(`\n🚨 ${eventType} alert from ${deviceId}`);
    console.log(`   Wake reason : ${wakeReason}`);
    console.log(`   GPS fix     : ${gpsFix === 1 ? 'Fixed ✓' : 'No fix ✗'}`);
    console.log(`   Incident ID : ${incidentId}`);
    console.log(`   Hash        : ${payloadHash.slice(0, 20)}...`);

    // Store full raw payload off-chain in SQLite
    const db = setupDatabase();
    db.prepare(`
        INSERT OR IGNORE INTO raw_events
            (incident_id, device_id, event_type, raw_payload, payload_hash, received_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(incidentId, deviceId, eventType, rawPayloadStr, payloadHash, receivedAt);
    console.log(`📦 Stored off-chain in SQLite`);

    // L4 end
    const L4_hash_ms = Date.now() - t4_start;

    // Risk score (TG-015) — falls back to the fixed v0 score if anything goes wrong
    let scoreStr = riskScore, contextJson = null;
    try {
        const t_risk = Date.now();
        const r = risk.score(db, { incidentId, deviceId, eventType, timestamp: receivedAt, rssi, snr });
        scoreStr = String(r.score); contextJson = r.contextJson;
        const parts = Object.entries(r.factors).map(([k, v]) => `${k} ${v >= 0 && k !== 'base' ? '+' : ''}${v}`).join(', ');
        console.log(`🧮 Risk ${r.score} (${r.modelVersion}: ${parts}${r.oracleRef ? `; weather ${r.features.heatBand} HI ${r.features.heatIndexC}°C` : '; no weather'}) in ${Date.now() - t_risk}ms`);
    } catch (err) {
        console.warn(`⚠️  Risk scoring failed (${err.message}) — using fixed score ${riskScore}`);
    }
    db.close();

    // L5 start: Fabric endorsement + ordering + commit
    const t5_start = Date.now();
    const fn = await submitIncident([incidentId, deviceId, eventType, payloadHash, receivedAt, scoreStr], contextJson);
    const L5_fabric_ms = Date.now() - t5_start;
    if (!fn) {
        console.log(`⏳ ${incidentId} queued — will retry every 60 s until it reaches the ledger\n`);
        return;
    }
    console.log(`✅ ${fn} committed to ${gatewayIdentity().channel}`);
    if (process.env.DASHBOARD_URL) console.log(`   Dashboard: ${process.env.DASHBOARD_URL}\n`);

    // Total end-to-end
    const total_e2e_ms = Date.now() - t_chirpstack;

    // Print latency summary
    console.log(`📊 LATENCY — ${incidentId}`);
    console.log(`   L3  MQTT delivery  : ${L3_mqtt_ms}ms`);
    console.log(`   L4  Hash + SQLite  : ${L4_hash_ms}ms`);
    console.log(`   L5  Fabric commit  : ${L5_fabric_ms}ms`);
    console.log(`   ─────────────────────────────────`);
    console.log(`   Total end-to-end   : ${total_e2e_ms}ms\n`);

    // Persist latency to SQLite for report generation
    const db2 = setupDatabase();
    db2.prepare(`
        INSERT OR REPLACE INTO latency_log
            (incident_id, device_id, event_type,
             beacon_count, scenario,
             L3_mqtt_ms, L4_hash_ms, L5_fabric_ms,
             total_e2e_ms, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        incidentId, deviceId, eventType,
        1, SCENARIO,
        L3_mqtt_ms, L4_hash_ms, L5_fabric_ms,
        total_e2e_ms, new Date().toISOString()
    );
    db2.close();
}

// ─────────────────────────────────────────────────────────────
// Reliable submission (TG-015)
//   • LogIncidentWithContext when a risk context exists, else LogIncident
//   • a context the chaincode rejects → same incident via LogIncident (never lose an SOS)
//   • connection errors → reconnect and retry (1 s, 3 s); still failing → submit_queue,
//     retried every 60 s until committed
// ─────────────────────────────────────────────────────────────
function errText(err) { return (err.details || []).map(d => d.message).join('; ') || err.message || String(err); }

function resetFabric() {
    if (fabricConnection) {
        try { fabricConnection.gateway.close(); fabricConnection.grpcClient.close(); } catch (_) {}
        fabricConnection = null;
    }
}

async function submitIncident(args, contextJson) {
    let withContext = !!contextJson;
    for (const waitMs of [0, 1000, 3000]) {
        if (waitMs) await new Promise(r => setTimeout(r, waitMs));
        const fn = withContext ? 'LogIncidentWithContext' : 'LogIncident';
        try {
            const { contract } = await getFabricConnection();
            await contract.submitTransaction(fn, ...args, ...(withContext ? [contextJson] : []));
            dequeue(args[0]);
            return fn;
        } catch (err) {
            const msg = errText(err);
            if (/already exists/.test(msg)) { dequeue(args[0]); return fn + ' (already on ledger)'; }
            if (withContext && /oracleRef/.test(msg) && contextJson.includes('"oracleRef"')) {
                // Weather reading not on the ledger: keep the score breakdown, drop only the reference
                const c = JSON.parse(contextJson); delete c.oracleRef; c.factors.weather = 'reference rejected';
                contextJson = JSON.stringify(c);
                console.warn(`⚠️  Oracle reference rejected (${msg}) — retrying without it`);
                continue;
            }
            if (withContext && /contextJson|oracleRef|factors|modelVersion|featureHash|LogIncidentWithContext/.test(msg)) {
                console.warn(`⚠️  Context rejected (${msg}) — submitting with LogIncident`);
                withContext = false; continue;
            }
            console.error(`❌ ${fn} failed: ${msg}`);
            resetFabric();
        }
    }
    enqueue(args, withContext ? contextJson : null);
    return null;
}

function queueDb() {
    const db = setupDatabase();
    db.exec(`CREATE TABLE IF NOT EXISTS submit_queue (
        incident_id TEXT PRIMARY KEY, args_json TEXT NOT NULL, context_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL)`);
    return db;
}
function enqueue(args, contextJson) {
    const db = queueDb();
    db.prepare(`INSERT INTO submit_queue (incident_id, args_json, context_json, attempts, created_at) VALUES (?,?,?,1,?)
                ON CONFLICT(incident_id) DO UPDATE SET attempts = attempts + 1`)
      .run(args[0], JSON.stringify(args), contextJson, new Date().toISOString());
    db.close();
}
function dequeue(incidentId) {
    const db = queueDb(); db.prepare('DELETE FROM submit_queue WHERE incident_id = ?').run(incidentId); db.close();
}

let retrying = false;
async function retryQueue() {
    if (retrying) return; retrying = true;
    try {
        const db = queueDb();
        const rows = db.prepare('SELECT * FROM submit_queue ORDER BY created_at LIMIT 20').all();
        db.close();
        for (const row of rows) {
            const fn = await submitIncident(JSON.parse(row.args_json), row.context_json);
            if (fn) console.log(`✅ Queued ${row.incident_id} committed via ${fn}`);
        }
    } catch (err) { console.error('❌ Queue retry error:', err.message); }
    finally { retrying = false; }
}

// Background: copy incident status/outcome from the ledger for the risk model's
// history factors and as training labels (every 5 min, off the SOS path)
async function syncOutcomes() {
    try {
        const { contract } = await getFabricConnection();
        const db = setupDatabase();
        const n = await risk.refreshOutcomes(db, contract);
        db.close();
        if (n) console.log(`🔄 Outcome sync: ${n} incidents refreshed from ledger`);
    } catch (err) { console.error('❌ Outcome sync error:', errText(err)); }
}
setInterval(retryQueue, 60 * 1000);
setInterval(syncOutcomes, 5 * 60 * 1000);
setTimeout(syncOutcomes, 20 * 1000);

// ─────────────────────────────────────────────────────────────
// MQTT connection — TTN or ChirpStack based on GATEWAY_MODE
// ─────────────────────────────────────────────────────────────
const isTTN = GATEWAY_MODE !== 'chirpstack';

const mqttUrl = isTTN
    ? `mqtts://${TTN_REGION}.cloud.thethings.network:8883`
    : `mqtt://${CHIRPSTACK_HOST}:${CHIRPSTACK_PORT}`;

const mqttOptions = isTTN
    ? { username: TTN_APP_ID, password: TTN_ACCESS_KEY, protocol: 'mqtts' }
    : {
        username:        CHIRPSTACK_USERNAME,
        password:        CHIRPSTACK_PASSWORD,
        clientId:        `trustguard-cs-${Date.now()}`,
        clean:           true,
        reconnectPeriod: 5000,
    };

const uplinkTopic = isTTN
    ? `v3/${TTN_APP_ID}@ttn/devices/+/up`
    : `application/${CHIRPSTACK_APP_ID}/device/+/event/up`;

if (!isTTN && !CHIRPSTACK_APP_ID) {
    console.error('❌ CHIRPSTACK_APP_ID is not set (ChirpStack → Applications → your application → ID). Set it in the gateway service environment.');
    process.exit(2);
}
console.log(`🚀 TrustGuard Gateway starting (mode: ${GATEWAY_MODE}, scenario: ${SCENARIO})...`);
if (isTTN) {
    console.log(`   TTN App     : ${TTN_APP_ID}`);
    console.log(`   TTN Region  : ${TTN_REGION}`);
} else {
    console.log(`   ChirpStack  : ${CHIRPSTACK_HOST}:${CHIRPSTACK_PORT}`);
    console.log(`   App ID      : ${CHIRPSTACK_APP_ID}`);
}
console.log(`   MQTT URL    : ${mqttUrl}`);
{
    const id = gatewayIdentity();
    console.log(`   Fabric peer : ${id.peerEndpoint} (${id.peerHostOverride})`);
    console.log(`   Channel     : ${id.channel} · chaincode ${id.chaincode} · as ${id.name} (${id.mspId})\n`);
}

const mqttClient = mqtt.connect(mqttUrl, mqttOptions);

mqttClient.on('connect', async () => {
    console.log(`✅ Connected to ${isTTN ? 'TTN' : 'ChirpStack'} MQTT broker`);

    // Pre-establish Fabric connection
    try {
        await getFabricConnection();
    } catch (err) {
        console.error('⚠️  Could not pre-connect to Fabric:', err.message);
        console.error('   Make sure the network is deployed and the gateway identity is enrolled (Admin → Enroll Identities).');
    }

    mqttClient.subscribe(uplinkTopic, (err) => {
        if (!err) {
            console.log(`📡 Subscribed to: ${uplinkTopic}`);
            console.log('   Waiting for SOS/FALL/INACTIVITY events...\n');
        } else {
            console.error('❌ Subscription error:', err);
        }
    });
});

mqttClient.on('message', async (topic, message) => {
    try {
        await processUplink(topic, message);
    } catch (err) {
        console.error('❌ Error processing uplink:', err.message);
        // Reset cached Fabric connection on error
        if (fabricConnection) {
            resetFabric();
            console.log('   Fabric connection reset — will reconnect on next uplink');
        }
    }
});

mqttClient.on('error',     (err) => console.error('❌ MQTT error:', err.message));
mqttClient.on('offline',   ()    => console.warn('⚠️  MQTT client offline — will auto-reconnect'));
mqttClient.on('reconnect', ()    => console.log(`🔄 Reconnecting to ${isTTN ? 'TTN' : 'ChirpStack'} MQTT...`));

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gateway...');
    mqttClient.end();
    if (fabricConnection) {
        fabricConnection.gateway.close();
        fabricConnection.grpcClient.close();
    }
    process.exit(0);
});

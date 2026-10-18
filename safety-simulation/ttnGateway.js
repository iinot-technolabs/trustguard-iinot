'use strict';

// ttnGateway.js — IINoT Live Gateway (TTN + ChirpStack dual mode)
//
// Subscribes to TTN or ChirpStack MQTT feed, decodes beacon uplinks,
// stores raw payloads off-chain in SQLite, computes SHA-256 hash, and
// submits LogIncident transactions to the IINoT Fabric network using
// the gateway1 identity (role=gateway:ecert).
//
// Usage:
//   TTN mode (default):
//     export TTN_APP_ID=iiot-india TTN_ACCESS_KEY=... TTN_REGION=au1
//     node ttnGateway.js
//
//   ChirpStack mode:
//     export GATEWAY_MODE=chirpstack CHIRPSTACK_HOST=localhost
//     export CHIRPSTACK_APP_ID=a3b1501e-b882-42a2-bed9-444296fb6555
//     node ttnGateway.js

const mqtt     = require('mqtt');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const grpc     = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');

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
const CHIRPSTACK_APP_ID   = process.env.CHIRPSTACK_APP_ID   || 'a3b1501e-b882-42a2-bed9-444296fb6555';

// Scenario tag for latency report
const SCENARIO = process.env.SCENARIO || (GATEWAY_MODE === 'chirpstack' ? 'vm-chirpstack' : 'vm-ttn');

// ─────────────────────────────────────────────────────────────
// IINOT NETWORK PATHS
// ─────────────────────────────────────────────────────────────
const IINOT_NETWORK_HOME = path.join(process.env.HOME, 'fabric', 'iinot-network');
const CHANNEL_NAME       = 'iinot-safety-channel';
const CHAINCODE_NAME     = 'safetycc';
const PEER_ENDPOINT      = 'localhost:7051';
const PEER_HOST_OVERRIDE = 'peer0.iinot-industry.com';
const TLS_CERT_PATH = path.join(
    IINOT_NETWORK_HOME,
    'organizations', 'peerOrganizations', 'iinot-industry.com',
    'peers', 'peer0.iinot-industry.com', 'tls', 'ca.crt'
);
const WALLET_DIR = path.join(__dirname, 'wallet');
const DB_PATH    = path.join(__dirname, 'offchain.db');

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

    const certPath = path.join(WALLET_DIR, 'gateway1', 'cert.pem');
    const keyPath  = path.join(WALLET_DIR, 'gateway1', 'key.pem');

    if (!fs.existsSync(certPath)) {
        throw new Error(
            'gateway1 identity not found in wallet. ' +
            'Run node enrollIdentities.js first.'
        );
    }

    const credentials = fs.readFileSync(certPath);
    const privateKey  = crypto.createPrivateKey(fs.readFileSync(keyPath));
    const tlsRootCert = fs.readFileSync(TLS_CERT_PATH);

    const grpcClient = new grpc.Client(
        PEER_ENDPOINT,
        grpc.credentials.createSsl(tlsRootCert),
        { 'grpc.ssl_target_name_override': PEER_HOST_OVERRIDE }
    );

    const gateway = connect({
        client:   grpcClient,
        identity: { mspId: 'IINoTIndustryMSP', credentials },
        signer:   signers.newPrivateKeySigner(privateKey)
    });

    const contract = gateway
        .getNetwork(CHANNEL_NAME)
        .getContract(CHAINCODE_NAME);

    fabricConnection = { gateway, grpcClient, contract };
    console.log('✅ Fabric connection established (gateway1 / IINoTIndustryMSP)');
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

    let wakeReason, gpsFix, deviceId, timestamp;

    if (GATEWAY_MODE === 'chirpstack') {
        // ── ChirpStack mode ──────────────────────────────────
        let parsed;
        try { parsed = parseChirpStackUplink(raw); }
        catch (err) { console.error('ChirpStack parse error:', err.message); return; }
        ({ deviceId, wakeReason, gpsFix, timestamp } = parsed);
    } else {
        // ── TTN mode (original) ──────────────────────────────
        const payload = JSON.parse(raw);
        if (!payload.uplink_message || !payload.uplink_message.decoded_payload) { return; }
        const decoded = payload.uplink_message.decoded_payload;
        wakeReason    = decoded.digital_in_3;
        gpsFix        = decoded.digital_in_5;
        deviceId      = payload.end_device_ids?.device_id || 'UNKNOWN';
        timestamp     = payload.received_at || new Date().toISOString();
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
    db.close();
    console.log(`📦 Stored off-chain in SQLite`);

    // L4 end
    const L4_hash_ms = Date.now() - t4_start;

    // L5 start: Fabric endorsement + ordering + commit
    const t5_start = Date.now();
    const { contract } = await getFabricConnection();
    await contract.submitTransaction(
        'LogIncident',
        incidentId,
        deviceId,
        eventType,
        payloadHash,
        receivedAt,
        riskScore
    );
    const L5_fabric_ms = Date.now() - t5_start;

    console.log(`✅ LogIncident committed to iinot-safety-channel`);
    console.log(`   Dashboard: http://103.35.165.84:5173\n`);

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

console.log(`🚀 IINoT Gateway starting (mode: ${GATEWAY_MODE}, scenario: ${SCENARIO})...`);
if (isTTN) {
    console.log(`   TTN App     : ${TTN_APP_ID}`);
    console.log(`   TTN Region  : ${TTN_REGION}`);
} else {
    console.log(`   ChirpStack  : ${CHIRPSTACK_HOST}:${CHIRPSTACK_PORT}`);
    console.log(`   App ID      : ${CHIRPSTACK_APP_ID}`);
}
console.log(`   MQTT URL    : ${mqttUrl}`);
console.log(`   Fabric peer : ${PEER_ENDPOINT} (${PEER_HOST_OVERRIDE})`);
console.log(`   Channel     : ${CHANNEL_NAME}\n`);

const mqttClient = mqtt.connect(mqttUrl, mqttOptions);

mqttClient.on('connect', async () => {
    console.log(`✅ Connected to ${isTTN ? 'TTN' : 'ChirpStack'} MQTT broker`);

    // Pre-establish Fabric connection
    try {
        await getFabricConnection();
    } catch (err) {
        console.error('⚠️  Could not pre-connect to Fabric:', err.message);
        console.error('   Make sure iinot-network is running and gateway1 is enrolled.');
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
            fabricConnection.gateway.close();
            fabricConnection.grpcClient.close();
            fabricConnection = null;
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

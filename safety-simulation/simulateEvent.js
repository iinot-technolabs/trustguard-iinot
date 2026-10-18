'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');

// Updated to point at iinot-network
const IINOT_NETWORK_HOME = path.join(
    process.env.HOME, 'fabric', 'iinot-network'
);

const CHANNEL_NAME   = 'iinot-safety-channel';
const CHAINCODE_NAME = 'safetycc';

const PEER_ENDPOINT      = 'localhost:7051';
const PEER_HOST_OVERRIDE = 'peer0.iinot-industry.com';

// TLS cert for peer0.iinot-industry.com
const TLS_CERT_PATH = path.join(
    IINOT_NETWORK_HOME,
    'organizations', 'peerOrganizations', 'iinot-industry.com',
    'peers', 'peer0.iinot-industry.com', 'tls', 'ca.crt'
);

const WALLET_DIR = path.join(__dirname, 'wallet');
const DB_PATH    = path.join(__dirname, 'offchain.db');

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
    return db;
}

async function connectAsIdentity(identityName, mspId) {
    const certPath = path.join(WALLET_DIR, identityName, 'cert.pem');
    const keyPath  = path.join(WALLET_DIR, identityName, 'key.pem');

    const credentials = fs.readFileSync(certPath);
    const privateKeyPem = fs.readFileSync(keyPath);
    const privateKey = crypto.createPrivateKey(privateKeyPem);

    const tlsRootCert = fs.readFileSync(TLS_CERT_PATH);
    const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);

    const grpcClient = new grpc.Client(PEER_ENDPOINT, tlsCredentials, {
        'grpc.ssl_target_name_override': PEER_HOST_OVERRIDE
    });

    const gateway = connect({
        client: grpcClient,
        identity: { mspId, credentials },
        signer: signers.newPrivateKeySigner(privateKey)
    });

    return { gateway, grpcClient };
}

async function main() {
    console.log('========================================');
    console.log(' STEP 1: Simulating beacon SOS event');
    console.log('========================================\n');

    const incidentId = 'INC-' + uuidv4().slice(0, 8).toUpperCase();
    const deviceId   = 'DEV-BEACON-001';
    const eventType  = 'SOS';
    const receivedAt = new Date().toISOString();

    const rawTtnPayload = {
        end_device_ids: { device_id: deviceId },
        received_at: receivedAt,
        uplink_message: {
            decoded_payload: {
                sos: 1,
                battery_pct: 87,
                lat: 17.3850,
                lng: 78.4867
            },
            rx_metadata: [{ gateway_id: 'gtw-iinot-01', rssi: -78 }]
        }
    };

    const rawPayloadStr = JSON.stringify(rawTtnPayload);
    console.log('Raw TTN payload received:');
    console.log(rawPayloadStr, '\n');

    console.log('========================================');
    console.log(' STEP 2: Storing raw payload off-chain (SQLite)');
    console.log('========================================\n');

    const db = setupDatabase();
    const payloadHash = crypto.createHash('sha256').update(rawPayloadStr).digest('hex');

    db.prepare(`
        INSERT INTO raw_events
            (incident_id, device_id, event_type, raw_payload, payload_hash, received_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(incidentId, deviceId, eventType, rawPayloadStr, payloadHash, receivedAt);

    console.log(`Stored in SQLite at: ${DB_PATH}`);
    console.log(`incident_id : ${incidentId}`);
    console.log(`payload_hash: ${payloadHash}\n`);

    console.log('========================================');
    console.log(' STEP 3: Gateway submits LogIncident to blockchain');
    console.log('========================================\n');

    // Connect as gateway1 — IINoTIndustryMSP
    const { gateway: gatewayConn, grpcClient: gwClient } =
        await connectAsIdentity('gateway1', 'IINoTIndustryMSP');

    try {
        const network  = gatewayConn.getNetwork(CHANNEL_NAME);
        const contract = network.getContract(CHAINCODE_NAME);

        await contract.submitTransaction(
            'LogIncident',
            incidentId,
            deviceId,
            eventType,
            payloadHash,
            receivedAt,
            '95'
        );
        console.log(`LogIncident committed to blockchain for ${incidentId}\n`);
    } finally {
        gatewayConn.close();
        gwClient.close();
    }

    console.log('========================================');
    console.log(' STEP 4: Supervisor acknowledges the incident');
    console.log('========================================\n');

    // Connect as supervisor1 — IINoTIndustryMSP
    const { gateway: supConn, grpcClient: supClient } =
        await connectAsIdentity('supervisor1', 'IINoTIndustryMSP');

    try {
        const network  = supConn.getNetwork(CHANNEL_NAME);
        const contract = network.getContract(CHAINCODE_NAME);

        await contract.submitTransaction(
            'UpdateIncidentStatus',
            incidentId,
            'ACKNOWLEDGED',
            new Date().toISOString()
        );
        console.log(`Status updated: TRIGGERED -> ACKNOWLEDGED\n`);

        console.log('========================================');
        console.log(' STEP 5: Supervisor resolves the incident');
        console.log('========================================\n');

        await contract.submitTransaction(
            'UpdateIncidentStatus',
            incidentId,
            'RESOLVED',
            new Date().toISOString()
        );
        console.log(`Status updated: ACKNOWLEDGED -> RESOLVED\n`);

        console.log('========================================');
        console.log(' STEP 6: Reading back final state from ledger');
        console.log('========================================\n');

        const resultBytes = await contract.evaluateTransaction(
            'GetIncident', incidentId
        );
        const ledgerRecord = JSON.parse(
            Buffer.from(resultBytes).toString('utf8')
        );

        console.log('--- ON-CHAIN record (from Fabric ledger) ---');
        console.log(JSON.stringify(ledgerRecord, null, 2));

    } finally {
        supConn.close();
        supClient.close();
    }

    console.log('\n--- OFF-CHAIN record (from local SQLite) ---');
    const offchainRow = db
        .prepare('SELECT * FROM raw_events WHERE incident_id = ?')
        .get(incidentId);
    console.log(JSON.stringify(offchainRow, null, 2));

    console.log('\n========================================');
    console.log(' Simulation complete.');
    console.log(' Verify integrity: SHA-256 of raw_payload should equal eventHash on-chain.');
    console.log('========================================');

    db.close();
}

main().catch(err => {
    console.error('\nSimulation failed:', err);
    process.exit(1);
});

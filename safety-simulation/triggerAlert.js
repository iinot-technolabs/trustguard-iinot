'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const tg = require('../common/tgnet');   // network, identities, paths from the deployed config

const DB_PATH    = tg.offchainDb();

// Accept event type as argument: node triggerAlert.js SOS
// Defaults to SOS if not specified
const eventType = process.argv[2] || 'SOS';
const validTypes = ['SOS', 'FALL', 'INACTIVITY'];
if (!validTypes.includes(eventType)) {
    console.error(`Invalid event type. Use: ${validTypes.join(', ')}`);
    process.exit(1);
}

async function main() {
    const incidentId = 'INC-' + uuidv4().slice(0, 8).toUpperCase();
    const deviceId   = 'DEV-BEACON-001';
    const receivedAt = new Date().toISOString();

    const rawTtnPayload = {
        end_device_ids: { device_id: deviceId },
        received_at: receivedAt,
        uplink_message: {
            decoded_payload: {
                [eventType.toLowerCase()]: 1,
                battery_pct: Math.floor(Math.random() * 40) + 60,
                lat: 17.3850, lng: 78.4867
            },
            rx_metadata: [{ gateway_id: 'gtw-iinot-01', rssi: -78 }]
        }
    };

    const rawPayloadStr = JSON.stringify(rawTtnPayload);
    const payloadHash   = crypto.createHash('sha256').update(rawPayloadStr).digest('hex');

    // Store off-chain
    const db = new Database(DB_PATH);
    db.exec(`CREATE TABLE IF NOT EXISTS raw_events (
        incident_id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
        event_type TEXT NOT NULL, raw_payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL, received_at TEXT NOT NULL
    )`);
    db.prepare(`INSERT INTO raw_events VALUES (?,?,?,?,?,?)`)
      .run(incidentId, deviceId, eventType, rawPayloadStr, payloadHash, receivedAt);
    db.close();

    // Submit to blockchain as gateway1
    const { gateway, client: grpcClient } = tg.connect(tg.identityForRole('gateway'), { grpc, connect, signers });

    try {
        const contract = gateway.getNetwork(tg.load().network.channel).getContract(tg.load().chaincode.name);
        await contract.submitTransaction(
            'LogIncident', incidentId, deviceId, eventType,
            payloadHash, receivedAt, '95'
        );
        console.log(`\n🚨 ${eventType} ALERT TRIGGERED`);
        console.log(`   Incident ID : ${incidentId}`);
        console.log(`   Device      : ${deviceId}`);
        console.log(`   Hash        : ${payloadHash.slice(0, 20)}...`);
        console.log(`   Status      : TRIGGERED`);
        console.log(`\n   ✅ Committed to blockchain — check the dashboard!\n`);
    } finally {
        gateway.close();
        grpcClient.close();
    }
}

main().catch(err => {
    console.error('Alert trigger failed:', err.message);
    process.exit(1);
});

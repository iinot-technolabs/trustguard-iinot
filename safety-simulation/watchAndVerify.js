'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');

const IINOT_NETWORK_HOME = path.join(
    process.env.HOME, 'fabric', 'iinot-network'
);
const WALLET_DIR = path.join(__dirname, 'wallet');
const DB_PATH    = path.join(__dirname, 'offchain.db');
const TLS_CERT_PATH = path.join(
    IINOT_NETWORK_HOME,
    'organizations', 'peerOrganizations', 'iinot-industry.com',
    'peers', 'peer0.iinot-industry.com', 'tls', 'ca.crt'
);

const POLL_INTERVAL_MS = 2000;

async function connectAsSupervisor() {
    const credentials = fs.readFileSync(
        path.join(WALLET_DIR, 'supervisor1', 'cert.pem')
    );
    const privateKey = crypto.createPrivateKey(
        fs.readFileSync(path.join(WALLET_DIR, 'supervisor1', 'key.pem'))
    );
    const tlsRootCert = fs.readFileSync(TLS_CERT_PATH);

    const grpcClient = new grpc.Client(
        'localhost:7051',
        grpc.credentials.createSsl(tlsRootCert),
        { 'grpc.ssl_target_name_override': 'peer0.iinot-industry.com' }
    );

    const gateway = connect({
        client: grpcClient,
        identity: { mspId: 'IINoTIndustryMSP', credentials },
        signer: signers.newPrivateKeySigner(privateKey)
    });

    return { gateway, grpcClient };
}

async function verifyIncident(contract, db, incidentId) {
    const row = db
        .prepare('SELECT raw_payload FROM raw_events WHERE incident_id = ?')
        .get(incidentId);

    if (!row) {
        return { verdict: 'ERROR', detail: `No row found for ${incidentId}` };
    }

    const currentHash = crypto
        .createHash('sha256')
        .update(row.raw_payload)
        .digest('hex');

    const resultBytes = await contract.evaluateTransaction(
        'GetIncident', incidentId
    );
    const ledgerRecord = JSON.parse(
        Buffer.from(resultBytes).toString('utf8')
    );
    const chainHash = ledgerRecord.eventHash;

    if (currentHash === chainHash) {
        return { verdict: 'PASS', detail: 'SQLite payload matches on-chain hash' };
    } else {
        return {
            verdict: 'TAMPER DETECTED',
            detail: `SQLite hash (${currentHash}) does NOT match ledger hash (${chainHash})`
        };
    }
}

async function pollLoop(contract, db) {
    const pending = db.prepare(`
        SELECT alert_id, incident_id, flagged_at
        FROM verification_alerts
        WHERE resolved = 0
        ORDER BY alert_id ASC
    `).all();

    for (const alert of pending) {
        console.log(`\n[${new Date().toISOString()}] New tamper flag detected`);
        console.log(`  incident_id: ${alert.incident_id}`);
        console.log(`  flagged_at : ${alert.flagged_at}`);

        let result;
        try {
            result = await verifyIncident(contract, db, alert.incident_id);
        } catch (err) {
            // Mark as resolved with ERROR verdict so it doesn't loop forever
            console.log(`  VERDICT    : ERROR — ${err.message}`);
            db.prepare(`
                UPDATE verification_alerts
                SET resolved = 1, resolved_at = ?, verdict = ?
                WHERE alert_id = ?
            `).run(new Date().toISOString(), 'ERROR: ' + err.message, alert.alert_id);
            continue;
        }

        console.log(`  VERDICT    : ${result.verdict}`);
        console.log(`  detail     : ${result.detail}`);

        if (result.verdict === 'TAMPER DETECTED') {
            console.log(`  >>> ALERT: raw_payload for ${alert.incident_id} ` +
                        `no longer matches the immutable ledger record <<<`);
        }

        db.prepare(`
            UPDATE verification_alerts
            SET resolved = 1, resolved_at = ?, verdict = ?
            WHERE alert_id = ?
        `).run(new Date().toISOString(), result.verdict, alert.alert_id);
    }
}

async function main() {
    const db = new Database(DB_PATH);
    db.exec(fs.readFileSync(
        path.join(__dirname, 'setupTriggers.sql'), 'utf8'
    ));

    const { gateway, grpcClient } = await connectAsSupervisor();
    const contract = gateway
        .getNetwork('iinot-safety-channel')
        .getContract('safetycc');

    console.log(`Watching ${DB_PATH} for raw_payload changes...`);
    console.log(`Polling every ${POLL_INTERVAL_MS / 1000}s. Press Ctrl+C to stop.\n`);

    process.on('SIGINT', () => {
        console.log('\nStopping watcher...');
        gateway.close();
        grpcClient.close();
        db.close();
        process.exit(0);
    });

    let pollInProgress = false;

    setInterval(() => {
        if (pollInProgress) return;
        pollInProgress = true;
        pollLoop(contract, db)
            .catch(err => console.error('Poll error:', err))
            .finally(() => { pollInProgress = false; });
    }, POLL_INTERVAL_MS);
}

main().catch(err => {
    console.error('Watcher failed to start:', err);
    process.exit(1);
});

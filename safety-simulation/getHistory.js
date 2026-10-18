'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');

const IINOT_NETWORK_HOME = path.join(
    process.env.HOME, 'fabric', 'iinot-network'
);
const WALLET_DIR = path.join(__dirname, 'wallet');
const TLS_CERT_PATH = path.join(
    IINOT_NETWORK_HOME,
    'organizations', 'peerOrganizations', 'iinot-industry.com',
    'peers', 'peer0.iinot-industry.com', 'tls', 'ca.crt'
);

async function main() {
    const incidentId = process.argv[2];

    if (!incidentId) {
        console.error('Usage: node getHistory.js <incidentId>');
        process.exit(1);
    }

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

    try {
        const contract = gateway
            .getNetwork('iinot-safety-channel')
            .getContract('safetycc');

        const result = await contract.evaluateTransaction(
            'GetIncidentHistory', incidentId
        );
        const history = JSON.parse(Buffer.from(result).toString('utf8'));

        console.log(`\nFull immutable history for ${incidentId}:\n`);
        console.log(JSON.stringify(history, null, 2));
        console.log(`\nTotal ledger entries found: ${history.length}`);
    } finally {
        gateway.close();
        grpcClient.close();
    }
}

main().catch(err => {
    console.error('Failed to fetch history:', err);
    process.exit(1);
});

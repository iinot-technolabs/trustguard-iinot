'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const tg = require('../common/tgnet');   // network, identities, paths from the deployed config


async function main() {
    const incidentId = process.argv[2];

    if (!incidentId) {
        console.error('Usage: node getHistory.js <incidentId>');
        process.exit(1);
    }

    const { gateway, client: grpcClient } = tg.connect(tg.identityForRole('supervisor'), { grpc, connect, signers });

    try {
        const contract = gateway
            .getNetwork(tg.load().network.channel)
            .getContract(tg.load().chaincode.name);

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

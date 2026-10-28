'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
require('dotenv').config();

const {
    IINOT_NETWORK_HOME, WALLET_DIR,
    CHANNEL_NAME, CHAINCODE_NAME,
    PEER_ENDPOINT, PEER_HOST_OVERRIDE
} = process.env;

// Written by generateConfigs.js into iinot-network/config/app.env (employer org peer).
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || path.join(
    IINOT_NETWORK_HOME,
    'organizations', 'peerOrganizations', 'iinot-industry.com',
    'peers', 'peer0.iinot-industry.com', 'tls', 'ca.crt'
);

const connectionCache = new Map();

async function getConnection(identityName, mspId) {
    if (connectionCache.has(identityName)) {
        return connectionCache.get(identityName);
    }

    const certPath = path.join(WALLET_DIR, identityName, 'cert.pem');
    const keyPath  = path.join(WALLET_DIR, identityName, 'key.pem');

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        throw new Error(
            `Identity '${identityName}' not found in wallet. ` +
            `Run enrollIdentities.js first.`
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
        client: grpcClient,
        identity: { mspId, credentials },
        signer: signers.newPrivateKeySigner(privateKey)
    });

    const contract = gateway
        .getNetwork(CHANNEL_NAME)
        .getContract(CHAINCODE_NAME);

    const conn = { gateway, grpcClient, contract };
    connectionCache.set(identityName, conn);
    return conn;
}

function closeAll() {
    for (const [, conn] of connectionCache) {
        conn.gateway.close();
        conn.grpcClient.close();
    }
    connectionCache.clear();
}

module.exports = { getConnection, closeAll };
















'use strict';

const FabricCAServices = require('fabric-ca-client');
const fs = require('fs');
const path = require('path');

// Points to our new IINoT network instead of test-network
const IINOT_NETWORK_HOME = path.join(
    process.env.HOME, 'fabric', 'iinot-network'
);

const WALLET_DIR = path.join(__dirname, 'wallet');

async function enroll(orgName, caName, caUrl, tlsCertPath, identityName, secret) {
    const tlsCACert = fs.readFileSync(tlsCertPath, 'utf8');

    const ca = new FabricCAServices(
        caUrl,
        { trustedRoots: tlsCACert, verify: false },
        caName
    );

    const enrollment = await ca.enroll({
        enrollmentID: identityName,
        enrollmentSecret: secret
    });

    const identityDir = path.join(WALLET_DIR, identityName);
    fs.mkdirSync(identityDir, { recursive: true });

    fs.writeFileSync(path.join(identityDir, 'cert.pem'), enrollment.certificate);
    fs.writeFileSync(path.join(identityDir, 'key.pem'), enrollment.key.toBytes());

    console.log(`Enrolled '${identityName}' (${orgName}) -> ${identityDir}`);
}

async function main() {
    // IINoT Industry CA TLS cert (ca-iinot-industry, port 7054)
    const industryTlsCert = path.join(
        IINOT_NETWORK_HOME,
        'organizations', 'fabric-ca', 'iinot-industry', 'ca-cert.pem'
    );

    await enroll(
        'IINoTIndustry',
        'ca-iinot-industry',
        'https://localhost:7054',
        industryTlsCert,
        'gateway1',
        'gatewaypw'
    );

    await enroll(
        'IINoTIndustry',
        'ca-iinot-industry',
        'https://localhost:7054',
        industryTlsCert,
        'supervisor1',
        'supervisorpw'
    );

    console.log('\nAll identities enrolled successfully.');
}

main().catch(err => {
    console.error('Enrollment failed:', err);
    process.exit(1);
});

// Enroll auditor1 from IINoT Regulator CA (port 8054)
async function enrollAuditor() {
    const regulatorTlsCert = path.join(
        IINOT_NETWORK_HOME,
        'organizations', 'fabric-ca', 'iinot-regulator', 'ca-cert.pem'
    );
    await enroll(
        'IINoTRegulator',
        'ca-iinot-regulator',
        'https://localhost:8054',
        regulatorTlsCert,
        'auditor1',
        'auditorpw'
    );
}

enrollAuditor().catch(console.error);

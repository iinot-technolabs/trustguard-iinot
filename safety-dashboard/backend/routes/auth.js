'use strict';

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
require('dotenv').config();

const WALLET_DIR = process.env.WALLET_DIR;

const IDENTITY_ROLES = {
    'gateway1':    { role: 'gateway',    mspId: 'IINoTIndustryMSP' },
    'supervisor1': { role: 'supervisor', mspId: 'IINoTIndustryMSP' },
    'auditor1':    { role: 'auditor',    mspId: 'IINoTRegulatorMSP' }
};

router.post('/login', async (req, res) => {
    try {
        const { identity } = req.body;

        if (!identity || !IDENTITY_ROLES[identity]) {
            return res.status(400).json({
                success: false,
                error: 'Unknown identity. Use: gateway1, supervisor1, or auditor1'
            });
        }

        const certPath = path.join(WALLET_DIR, identity, 'cert.pem');
        if (!fs.existsSync(certPath)) {
            return res.status(401).json({
                success: false,
                error: `Identity '${identity}' not enrolled. Run enrollIdentities.js first.`
            });
        }

        const { role, mspId } = IDENTITY_ROLES[identity];
        res.json({
            success: true, identity, role, mspId,
            enrolledAt: fs.statSync(certPath).mtime
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

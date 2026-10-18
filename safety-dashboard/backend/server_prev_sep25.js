'use strict';

const express = require('express');
const cors    = require('cors');
const { closeAll } = require('./fabricClient');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: ['http://localhost:5173', 'http://103.35.165.84:5173'] }));
app.use(express.json());

const IDENTITY_ROLES = {
    'gateway1':    { role: 'gateway',    mspId: 'IINoTIndustryMSP' },
    'supervisor1': { role: 'supervisor', mspId: 'IINoTIndustryMSP' },
    'auditor1':    { role: 'auditor',    mspId: 'IINoTRegulatorMSP' }
};

app.use('/api/incidents', (req, res, next) => {
    const identity = req.headers['x-identity'];
    if (!identity || !IDENTITY_ROLES[identity]) {
        return res.status(401).json({
            success: false,
            error: 'Missing or invalid x-identity header'
        });
    }
    req.identity = { identity, ...IDENTITY_ROLES[identity] };
    next();
});

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/incidents', require('./routes/incidents'));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const server = app.listen(PORT, () => {
    console.log(`IINoT Safety Dashboard API running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});

process.on('SIGINT', () => {
    console.log('\nShutting down...');
    closeAll();
    server.close(() => process.exit(0));
});

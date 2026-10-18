'use strict';
const express = require('express');
const cors    = require('cors');
const { closeAll } = require('./fabricClient');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS: allow both local dev and the server's own IP ───────────────────────
const allowedOrigins = ['http://localhost:5173'];
if (process.env.SERVER_HOST) {
  allowedOrigins.push(`http://${process.env.SERVER_HOST}`);
  allowedOrigins.push(`http://${process.env.SERVER_HOST}:5173`);
}
app.use(cors({ origin: allowedOrigins }));

app.use(express.json());

// ── Identity → role mapping ──────────────────────────────────────────────────
const IDENTITY_ROLES = {
  'gateway1':    { role: 'gateway',    mspId: 'IINoTIndustryMSP' },
  'supervisor1': { role: 'supervisor', mspId: 'IINoTIndustryMSP' },
  'auditor1':    { role: 'auditor',    mspId: 'IINoTRegulatorMSP' },
};

// ── Auth middleware (incidents only) ─────────────────────────────────────────
app.use('/api/incidents', (req, res, next) => {
  const identity = req.headers['x-identity'];
  if (!identity || !IDENTITY_ROLES[identity]) {
    return res.status(401).json({ success: false, error: 'Missing or invalid x-identity header' });
  }
  req.identity = { identity, ...IDENTITY_ROLES[identity] };
  next();
});

// ── Routes ───────────────────────────────────────────────────────────────────
// Network config generator (no auth — used by Network Designer UI)
const generateConfigsRoute = require('./routes/generateConfigsRoute');
app.use('/api', generateConfigsRoute);
app.use('/api/network-config', require('./routes/networkConfigRoute'));

// Fabric-identity auth (supervisor1, auditor1, gateway1)
app.use('/api/auth',      require('./routes/auth'));

// Admin auth — local password only, no Fabric dependency
const { router: adminAuthRouter } = require('./routes/adminAuth');
app.use('/api/admin', adminAuthRouter);

// Other routes
app.use('/api/incidents', require('./routes/incidents'));
const deployRoute = require('./routes/deploy');
app.use('/api/deploy', deployRoute);

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// ── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`IINoT Safety Dashboard API running on http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  closeAll();
  server.close(() => process.exit(0));
});

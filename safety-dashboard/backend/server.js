'use strict';
const express = require('express');
const cors    = require('cors');
const { closeAll } = require('./fabricClient');
require('dotenv').config();
const { requireAuth, secret } = require('./lib/auth');

// Fail fast if the signing secret is missing (TG-010)
secret();

const app  = express();
const PORT = process.env.PORT || 3001;

// Requests arrive through nginx (or the Vite dev proxy) on the same host; trust it for req.ip.
app.set('trust proxy', 'loopback');

// ── CORS: the dashboard is served from the same origin as /api (nginx), so CORS only
// matters for the Vite dev server. Extra origins: CORS_ORIGINS="http://a,http://b".
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173',
           ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)],
}));

app.use(express.json({ limit: '1mb' }));

// ── Public routes ────────────────────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);
app.use('/api/auth', require('./routes/auth'));   // /login is public, /me needs a token

// ── What network is deployed (names shown on screens and printed records) ────
app.get('/api/network-info', requireAuth(), (req, res) => {
  try { res.json({ success: true, ...require('../../common/tgnet').summary() }); }
  catch (e) { res.status(503).json({ success: false, error: e.message }); }
});

// ── Incidents: supervisor, auditor, claims-reviewer (chaincode re-checks role) ─
app.use('/api/incidents',
  requireAuth('supervisor', 'auditor', 'claims-reviewer'),
  require('./routes/incidents'));

// ── Oracle readings (weather / heat stress), verified on the ledger (TG-014) ─
app.use('/api/oracle',
  requireAuth('supervisor', 'auditor', 'claims-reviewer'),
  require('./routes/oracle'));

// ── Worker assignments + insurer queries (chaincode 1.2, TG-018) ─────────────
app.use('/api/workers',
  requireAuth('supervisor', 'auditor', 'claims-reviewer'),
  require('./routes/workers'));

// ── Compliance score + statutory reports (chaincode 1.3, TG-021) ────────────
app.use('/api/compliance', requireAuth('supervisor', 'auditor'), require('./routes/compliance'));
app.use('/api/reports',    requireAuth('supervisor', 'auditor'), require('./routes/reports'));

// ── Network Designer / Rules Designer / Deploy: admin only ───────────────────
// These write network config and run network.sh as root on this server.
app.use('/api/network-config', requireAuth('admin'), require('./routes/networkConfigRoute'));
app.use('/api/generate-configs', requireAuth('admin'));
app.use('/api', require('./routes/generateConfigsRoute'));   // defines POST /generate-configs
app.use('/api/deploy', requireAuth('admin'), require('./routes/deploy'));

// ── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, process.env.BIND_HOST || '127.0.0.1', () => {
  console.log(`TrustGuard dashboard API on http://127.0.0.1:${PORT} (auth enabled)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { closeAll(); server.close(() => process.exit(0)); });
}

'use strict';
// POST /api/auth/login   { username, password }  → { success, token, username, role, identity, mspId, expiresAt }
// GET  /api/auth/me      (Bearer token)          → current session info
const express = require('express');
const router  = express.Router();
const auth    = require('../lib/auth');
const tg      = require('../../../common/tgnet');

router.post('/login', (req, res) => {
  const ip = req.ip;
  const { username, password } = req.body || {};
  const key = `${ip}|${String(username || '').toLowerCase()}`;

  if (auth.tooManyAttempts(key)) {
    console.warn(`[auth] LOCKED login attempts from ${ip}`);
    return res.status(429).json({ success: false, error: 'Too many failed attempts. Try again in 15 minutes.' });
  }
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password are required' });
  }

  const user = auth.verifyUser(String(username), String(password));
  if (!user) {
    auth.recordFailure(key);
    console.warn(`[auth] FAIL login '${username}' from ${ip}`);
    return res.status(401).json({ success: false, error: 'Invalid username or password' });
  }

  // Fabric-backed roles need an identity in the deployed network and in the wallet.
  const map = auth.ROLE_IDENTITIES[user.role];
  if (user.role !== 'admin') {
    if (!map.identity) {
      return res.status(503).json({ success: false,
        error: `The deployed network has no identity with role '${user.role}'. Ask the administrator to add one in the Network Designer.` });
    }
    const w = tg.walletStatus(tg.identity(map.identity));
    if (!w.ok) {
      return res.status(503).json({ success: false,
        error: `Fabric identity '${map.identity}' is not enrolled on this server yet. Ask the administrator to run Enroll Identities.` });
    }
  }

  auth.clearFailures(key);
  const { token, payload } = auth.signToken(user);
  console.log(`[auth] OK login '${user.username}' role=${user.role} identity=${map.identity || '-'} from ${ip}`);
  res.json({
    success: true, token,
    username: user.username, role: user.role,
    identity: payload.identity, mspId: payload.mspId,
    expiresAt: new Date(payload.exp).toISOString(),
  });
});

router.get('/me', auth.requireAuth(), (req, res) => {
  res.json({ success: true, ...req.identity });
});

module.exports = router;

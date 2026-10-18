'use strict';
// ── Admin authentication — local password only, no Fabric dependency ──────────
// The admin password is read from ADMIN_PASSWORD in .env.
// No wallet, no X.509, no Fabric CA required.
// A simple signed token (HMAC-SHA256) is returned so the frontend can prove
// admin status on subsequent requests without re-sending the password.

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();

// ── Token helpers ─────────────────────────────────────────────────────────────
// We don't pull in jsonwebtoken to avoid an extra dependency.
// Format: base64(payload).base64(hmac)  — good enough for a local admin tool.

function makeToken(identity, secret) {
  const payload = Buffer.from(JSON.stringify({
    identity, role: 'admin', iat: Date.now()
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token, secret) {
  try {
    const [payload, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
}

// ── POST /api/admin/login ─────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return res.status(503).json({
      success: false,
      error: 'ADMIN_PASSWORD not set in server .env. Set it and restart the backend.'
    });
  }

  if (!password || password !== adminPassword) {
    return res.status(401).json({ success: false, error: 'Invalid admin password.' });
  }

  const secret = process.env.ADMIN_TOKEN_SECRET || adminPassword;
  const token  = makeToken('admin', secret);

  res.json({ success: true, identity: 'admin', role: 'admin', token });
});

// ── Middleware: require admin token ───────────────────────────────────────────
// Used by admin-only routes (e.g. future enroll endpoint).
function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Admin token required.' });

  const secret = process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD || '';
  const payload = verifyToken(token, secret);
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({ success: false, error: 'Invalid or expired admin token.' });
  }
  req.admin = payload;
  next();
}

module.exports = { router, requireAdmin };

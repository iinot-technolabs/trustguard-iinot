'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// TrustGuard IIoT — dashboard authentication (TG-010)
//
// • Users live in backend/users.json (never committed). Passwords are stored as
//   scrypt hashes with a per-user salt — Node built-in crypto, no new packages.
// • Each user maps to ONE Fabric wallet identity (supervisor1, auditor1, …) or to
//   none (admin). The Fabric identity, not the user, signs chaincode calls, so
//   the username is written to the backend log on every state-changing action.
// • Login returns an HMAC-SHA256 signed token with an expiry. The frontend sends
//   it as "Authorization: Bearer <token>". EventSource (deploy log stream)
//   cannot send headers, so that one route also accepts ?token=.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const USERS_FILE   = process.env.USERS_FILE || path.join(__dirname, '..', 'users.json');
const TOKEN_TTL_MS = (parseInt(process.env.AUTH_TOKEN_TTL_HOURS || '8', 10)) * 3600 * 1000;
const ROLES        = ['admin', 'supervisor', 'auditor', 'claims-reviewer'];

// Role → Fabric identity + MSP used for chaincode calls on the user's behalf.
// Looked up in the deployed network model (common/tgnet.js): the first app identity
// holding that role. Admin has no Fabric identity. Unknown or not-yet-deployed → nulls.
const tg = require('../../../common/tgnet');
const NO_IDENTITY = Object.freeze({ identity: null, mspId: null });
const ROLE_IDENTITIES = new Proxy({}, {
  get(_, role) {
    if (typeof role !== 'string' || role === 'admin' || !ROLES.includes(role)) return NO_IDENTITY;
    try {
      const id = tg.identityForRole(role);
      return id ? { identity: id.name, mspId: id.mspId } : NO_IDENTITY;
    } catch { return NO_IDENTITY; }
  },
});

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    throw new Error('AUTH_SECRET missing or shorter than 32 chars in backend/.env');
  }
  return s;
}

// ── User store ───────────────────────────────────────────────────────────────
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users || []; }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), { mode: 0o600 });
  fs.chmodSync(USERS_FILE, 0o600);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyUser(username, password) {
  const user = loadUsers().find(u => u.username === username && !u.disabled);
  // Always run scrypt so response time doesn't reveal whether the user exists.
  const { hash } = hashPassword(password || '', user ? user.salt : 'no-such-user-salt');
  if (!user) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
  return ok ? user : null;
}

// ── Tokens ───────────────────────────────────────────────────────────────────
function signToken(user) {
  const map = ROLE_IDENTITIES[user.role];
  const payload = {
    sub: user.username, role: user.role,
    identity: map.identity, mspId: map.mspId,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return { token: `${body}.${sig}`, payload };
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig || ''), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    // Re-check the user still exists and is enabled (lets an admin revoke access).
    const user = loadUsers().find(u => u.username === payload.sub && !u.disabled);
    if (!user || user.role !== payload.role) return null;
    return payload;
  } catch { return null; }
}

// ── Middleware ───────────────────────────────────────────────────────────────
// requireAuth()                 → any logged-in user
// requireAuth('admin')          → admin only
// requireAuth('supervisor', …)  → any of the listed roles
function requireAuth(...roles) {
  return (req, res, next) => {
    const header = req.headers['authorization'] || '';
    let token = header.startsWith('Bearer ') ? header.slice(7) : null;
    // EventSource can't set headers: allow ?token= on GET .../stream only.
    if (!token && req.method === 'GET' && req.path.endsWith('/stream')) token = req.query.token;

    const payload = verifyToken(token);
    if (!payload) {
      return res.status(401).json({ success: false, error: 'Not logged in or session expired' });
    }
    if (roles.length && !roles.includes(payload.role)) {
      console.warn(`[auth] DENY ${payload.sub} (${payload.role}) ${req.method} ${req.baseUrl}${req.path}`);
      return res.status(403).json({ success: false, error: `Role '${payload.role}' is not allowed here` });
    }
    // Same shape the existing routes already read: { identity, mspId, role }
    req.identity = { identity: payload.identity, mspId: payload.mspId, role: payload.role, username: payload.sub };
    next();
  };
}

// ── Login rate limit: 10 failed attempts per (client IP + username) per 15 min ─
// Keyed on both so one attacker cannot lock every user out at once.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000, MAX_FAILS = 10;
function tooManyAttempts(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { failures.delete(key); return false; }
  return f.count >= MAX_FAILS;
}
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}
function clearFailures(key) { failures.delete(key); }

module.exports = {
  ROLES, ROLE_IDENTITIES, USERS_FILE,
  loadUsers, saveUsers, hashPassword, verifyUser,
  signToken, verifyToken, requireAuth,
  tooManyAttempts, recordFailure, clearFailures, secret,
};

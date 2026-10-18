/**
 * /api/network-config — GET + POST
 *
 * GET  → serves the canonical network-config.json from the VM
 *         so App.jsx can seed its state on page load / refresh
 *
 * POST → saves a new config (same path as generateConfigsRoute persists to)
 *         Used when App.jsx wants to persist state without triggering a download
 *
 * Wire up in server.js:
 *   const networkConfigRoute = require('./routes/networkConfigRoute');
 *   app.use('/api/network-config', networkConfigRoute);
 */

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');

const CANONICAL_CONFIG = '/root/fabric/iinot-network/config/network-config.json';

// GET /api/network-config
router.get('/', (req, res) => {
  try {
    if (!fs.existsSync(CANONICAL_CONFIG)) {
      // No config saved yet — return empty so frontend uses its own defaults
      return res.json(null);
    }
    const cfg = JSON.parse(fs.readFileSync(CANONICAL_CONFIG, 'utf8'));
    res.json(cfg);
  } catch (err) {
    console.error('[network-config] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/network-config  (body = full config object)
router.post('/', (req, res) => {
  const cfg = req.body;
  if (!cfg || typeof cfg !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }
  try {
    fs.mkdirSync(path.dirname(CANONICAL_CONFIG), { recursive: true });
    fs.writeFileSync(CANONICAL_CONFIG, JSON.stringify(cfg, null, 2));
    console.log('[network-config] Config saved to canonical path');
    res.json({ ok: true });
  } catch (err) {
    console.error('[network-config] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

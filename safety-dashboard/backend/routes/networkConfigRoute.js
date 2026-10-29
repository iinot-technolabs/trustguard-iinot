'use strict';
/**
 * /api/network-config
 *   GET            the saved Network Designer config (null if none yet)
 *   POST           validate and save a config (400 with the list of problems if invalid)
 *   POST /validate validate only; returns the derived summary the Deploy page shows
 *                  (orgs, endorsement policy, chaincode label, warnings)
 * Admin-only: mounted behind requireRole('admin') in server.js.
 */
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { buildModel, ConfigError } = require('../lib/networkModel');
const { CONFIG_FILE, TG_HOME } = require('../lib/paths');

const router = express.Router();

function summarize(m) {
  return {
    network: m.network.name,
    channel: m.network.channel,
    chaincode: m.chaincode.label,
    sequence: m.chaincode.sequence,
    endorsementPolicy: m.chaincode.policy,
    batchTimeout: m.orderer.batchTimeout,
    bindAddress: m.network.bindAddress,
    orgs: m.orgs.map(o => ({ mspId: o.mspId, label: o.label, type: o.type, endorses: o.endorses,
                             domain: o.domain, users: o.users })),
    warnings: m.warnings,
  };
}

function check(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ConfigError(['request body must be the network config object']);
  }
  return buildModel(cfg, { tgHome: TG_HOME });
}

router.get('/', (req, res) => {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return res.json(null);
    res.json(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/validate', (req, res) => {
  try {
    res.json({ ok: true, summary: summarize(check(req.body)) });
  } catch (err) {
    if (err instanceof ConfigError) return res.status(400).json({ ok: false, problems: err.problems });
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const model = check(req.body);
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(req.body, null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
    res.json({ ok: true, summary: summarize(model) });
  } catch (err) {
    if (err instanceof ConfigError) return res.status(400).json({ ok: false, problems: err.problems });
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
module.exports.summarize = summarize;

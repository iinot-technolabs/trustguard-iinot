'use strict';
/**
 * POST /api/generate-configs — download the generated Fabric files for a config as a zip.
 *
 * Generates into a temporary folder, never into the live network folder, so a download
 * cannot change the files of a running network. The zip holds configtx.yaml,
 * docker/docker-compose.yaml and network-config.json; secrets and app.env are not included.
 * Admin-only: mounted behind requireRole('admin') in server.js.
 */
const express  = require('express');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const archiver = require('archiver');
const { generate } = require('../lib/generateConfigs');
const { ConfigError } = require('../lib/networkModel');

const router = express.Router();

router.post('/generate-configs', async (req, res) => {
  const cfg = req.body;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gen-'));
  const netRoot = path.join(tmpHome, 'iinot-network');
  try {
    if (!cfg || typeof cfg !== 'object') throw new ConfigError(['request body must be the network config object']);
    fs.mkdirSync(netRoot, { recursive: true });
    const cfgPath = path.join(tmpHome, 'network-config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const model = generate(cfgPath, netRoot, () => {});

    const safeName = model.network.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'network';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-configs.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
    archive.pipe(res);
    archive.file(path.join(netRoot, 'configtx.yaml'), { name: 'configtx.yaml' });
    archive.file(path.join(netRoot, 'docker', 'docker-compose.yaml'), { name: 'docker/docker-compose.yaml' });
    archive.file(cfgPath, { name: 'network-config.json' });
    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) {
      if (err instanceof ConfigError) res.status(400).json({ ok: false, problems: err.problems });
      else res.status(500).json({ ok: false, error: err.message });
    }
  } finally {
    setTimeout(() => fs.rm(tmpHome, { recursive: true, force: true }, () => {}), 5000);
  }
});

module.exports = router;

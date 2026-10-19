'use strict';

const express      = require('express');
const router       = express.Router();
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const { execFile } = require('child_process');
const archiver     = require('archiver');

const GENERATOR_SCRIPT = path.resolve('/root/trustguard-iinot/safety-dashboard/backend/lib/generateConfigs.js');
const NETWORK_ROOT     = '/root/trustguard-iinot/iinot-network';
const CANONICAL_CONFIG = '/root/trustguard-iinot/iinot-network/config/network-config.json';

const OUTPUT_FILES = [
  'configtx.yaml',
  'docker/docker-compose.yaml',
];

router.post('/generate-configs', async (req, res) => {
  const cfg = req.body;

  if (!cfg || !cfg.network || !cfg.network.name) {
    return res.status(400).json({ error: 'Invalid network config: network.name is required' });
  }

  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gen-'));
  const configPath = path.join(tmpDir, 'network-config.json');

  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    console.log('[generate-configs] Config received:', JSON.stringify(cfg.network));

    try {
      fs.mkdirSync(path.dirname(CANONICAL_CONFIG), { recursive: true });
      fs.writeFileSync(CANONICAL_CONFIG, JSON.stringify(cfg, null, 2));
      console.log('[generate-configs] Saved canonical config to:', CANONICAL_CONFIG);
    } catch (persistErr) {
      console.warn('[generate-configs] Could not persist canonical config:', persistErr.message);
    }

    await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [GENERATOR_SCRIPT, configPath, NETWORK_ROOT],
        { cwd: path.dirname(GENERATOR_SCRIPT), timeout: 30000 },
        (err, stdout, stderr) => {
          if (stdout) console.log('[generate-configs] stdout:', stdout);
          if (stderr) console.warn('[generate-configs] stderr:', stderr);
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout);
        }
      );
    });

    const safeNetName = cfg.network.name.replace(/\s+/g, '-').toLowerCase();
    const zipName     = `${safeNetName}-configs.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => {
      console.error('[generate-configs] archiver error:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    archive.pipe(res);

    for (const relPath of OUTPUT_FILES) {
      const fullPath = path.join(NETWORK_ROOT, relPath);
      if (fs.existsSync(fullPath)) {
        archive.file(fullPath, { name: relPath });
      } else {
        console.warn(`[generate-configs] Missing output file: ${fullPath}`);
      }
    }

    archive.file(configPath, { name: 'network-config.json' });
    await archive.finalize();

  } catch (err) {
    console.error('[generate-configs] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    setTimeout(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }, 5000);
  }
});

module.exports = router;

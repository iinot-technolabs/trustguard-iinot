/**
 * /api/generate-configs  — POST
 *
 * Accepts a network-config JSON body (nested schema), writes it to a temp file,
 * runs generateConfigs.js against it, then zips the 7 output files
 * and streams the zip back for download.
 *
 * Also persists the config to the canonical VM path so that:
 *   - Rules Designer reads the current config on next load
 *   - deploy.js (Phase 4) picks it up for network.sh
 *
 * Dependencies:
 *   express  — already used
 *   archiver — npm install archiver
 */

const express    = require('express');
const router     = express.Router();
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { execFile } = require('child_process');
const archiver   = require('archiver');

// Path to generateConfigs.js in trustguard-platform repo
const GENERATOR_SCRIPT = path.resolve('/root/fabric/trustguard-platform/generateConfigs.js');

// Canonical persistent path — Rules Designer and deploy.js both read from here
const CANONICAL_CONFIG = '/root/fabric/iinot-network/config/network-config.json';

// The 7 files generateConfigs.js outputs (relative to --out dir)
const OUTPUT_FILES = [
  'configtx.yaml',
  'docker/docker-compose.yaml',
  'scripts/registerEnroll.sh',
  'safety-chaincode/lib/safetyContract.js',
  'backend.env',
  'gateway.env',
  'README.md',
];

router.post('/generate-configs', async (req, res) => {
  const cfg = req.body;

  // Validate: require the nested network.name field
  if (!cfg || !cfg.network || !cfg.network.name) {
    return res.status(400).json({ error: 'Invalid network config: network.name is required' });
  }

  // Write config to a temp file
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gen-'));
  const configPath = path.join(tmpDir, 'network-config.json');

  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    console.log('[generate-configs] Config received:', JSON.stringify(cfg.network));

    // ── Persist to canonical path so Rules Designer + deploy.js stay in sync ──
    try {
      fs.mkdirSync(path.dirname(CANONICAL_CONFIG), { recursive: true });
      fs.writeFileSync(CANONICAL_CONFIG, JSON.stringify(cfg, null, 2));
      console.log('[generate-configs] Saved canonical config to:', CANONICAL_CONFIG);
    } catch (persistErr) {
      // Non-fatal: log but continue — the download can still proceed
      console.warn('[generate-configs] Could not persist canonical config:', persistErr.message);
    }

    // Run generateConfigs.js with --config and --out flags
    await new Promise((resolve, reject) => {
      execFile(
        'node',
        [GENERATOR_SCRIPT, '--config', configPath, '--out', tmpDir],
        { cwd: path.dirname(GENERATOR_SCRIPT), timeout: 30000 },
        (err, stdout, stderr) => {
          if (err) {
            console.error('[generate-configs] stderr:', stderr);
            reject(new Error(stderr || err.message));
          } else {
            resolve(stdout);
          }
        }
      );
    });

    // Create zip archive named after the network
    const safeNetName = cfg.network.name.replace(/\s+/g, '-').toLowerCase();
    const zipName     = `${safeNetName}-configs.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = new archiver.ZipArchive({ zlib: { level: 9 } });
    archive.on('error', err => {
      console.error('[generate-configs] archiver error:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    archive.pipe(res);

    // Add each output file to the zip
    for (const relPath of OUTPUT_FILES) {
      const fullPath = path.join(tmpDir, relPath);
      if (fs.existsSync(fullPath)) {
        archive.file(fullPath, { name: relPath });
      } else {
        console.warn(`[generate-configs] Missing output file: ${relPath}`);
      }
    }

    // Also include the config JSON itself for reference
    archive.file(configPath, { name: 'network-config.json' });

    await archive.finalize();

  } catch (err) {
    console.error('[generate-configs] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  } finally {
    // Clean up temp dir after a short delay (give stream time to flush)
    setTimeout(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }, 5000);
  }
});

module.exports = router;

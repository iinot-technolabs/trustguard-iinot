// backend/routes/deploy.js — Phase 4 update
// Adds: generateConfigs step before network.sh all
// so docker-compose.yaml and configtx.yaml are regenerated from current JSON.

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { spawn } = require('child_process');

// ── Paths ─────────────────────────────────────────────────────
const NETWORK_ROOT   = '/root/trustguard-iinot/iinot-network';
const CONFIG_FILE    = path.join(NETWORK_ROOT, 'config/network-config.json');
const NETWORK_SCRIPT = path.join(NETWORK_ROOT, 'scripts/network.sh');
// generateConfigs.js lives in the dashboard backend's lib/ folder
// and writes docker-compose.yaml + configtx.yaml into NETWORK_ROOT
const GEN_CONFIGS_SCRIPT = path.join(__dirname, '../lib/generateConfigs.js');

// ── In-memory deploy state ────────────────────────────────────
let deployState = {
  running:   false,
  pid:       null,
  startedAt: null,
  exitCode:  null,
  logLines:  [],
};
let activeClients = [];

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  activeClients.forEach(res => {
    try { res.write(payload); } catch (_) {}
  });
}

function addLog(line) {
  deployState.logLines.push(line);
  // Cap buffer at 2000 lines
  if (deployState.logLines.length > 2000) {
    deployState.logLines = deployState.logLines.slice(-1500);
  }
  broadcast('log', { line });
}

// ── POST /api/deploy ──────────────────────────────────────────
// Body: { networkConfig: <object>, mode: 'all' | 'channel' | 'deploy' }
router.post('/', async (req, res) => {
  if (deployState.running) {
    return res.status(409).json({ error: 'Deployment already in progress' });
  }

  const { networkConfig, mode = 'all' } = req.body;
  if (!networkConfig) {
    return res.status(400).json({ error: 'networkConfig is required' });
  }

  // Write config file
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(networkConfig, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `Failed to write config: ${err.message}` });
  }

  // Reset state
  deployState = { running: true, pid: null, startedAt: new Date().toISOString(), exitCode: null, logLines: [] };
  broadcast('status', { running: true, startedAt: deployState.startedAt });

  res.json({ ok: true, startedAt: deployState.startedAt });

  // ── Step 1: regenerate docker-compose.yaml + configtx.yaml ──
  addLog('[INFO] Generating docker-compose.yaml and configtx.yaml from network config...');

  let genError = null;
  try {
    await new Promise((resolve, reject) => {
      const gen = spawn('node', [GEN_CONFIGS_SCRIPT, CONFIG_FILE, NETWORK_ROOT], {
        cwd: NETWORK_ROOT,
        env: { ...process.env },
      });
      gen.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(addLog));
      gen.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => addLog(`[WARN] ${l}`)));
      gen.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`generateConfigs exited ${code}`));
      });
    });
    addLog('[INFO] Config files generated successfully.');
  } catch (err) {
    genError = err.message;
    addLog(`[ERROR] generateConfigs failed: ${err.message}`);
    addLog('[ERROR] Aborting deployment.');
    deployState.running  = false;
    deployState.exitCode = 1;
    broadcast('status', { running: false, exitCode: 1 });
    broadcast('done', { exitCode: 1 });
    return;
  }

  // ── Step 2: run network.sh ───────────────────────────────────
  addLog(`[INFO] Starting network.sh ${mode}...`);

  const proc = spawn('bash', [NETWORK_SCRIPT, mode], {
    cwd: NETWORK_ROOT,
    env: { ...process.env, HOME: '/root', PATH: `/root/trustguard-iinot/iinot-network/bin:${process.env.PATH}` },
  });

  deployState.pid = proc.pid;

  proc.stdout.on('data', data => {
    data.toString().split('\n').filter(Boolean).forEach(addLog);
  });
  proc.stderr.on('data', data => {
    data.toString().split('\n').filter(Boolean).forEach(l => addLog(`[stderr] ${l}`));
  });
  proc.on('close', code => {
    deployState.running  = false;
    deployState.exitCode = code;
    deployState.pid      = null;
    const msg = code === 0
      ? `[SUCCESS] Deployment complete. Network is ready.`
      : `[ERROR] network.sh exited with code ${code}`;
    addLog(msg);
    broadcast('status', { running: false, exitCode: code });
    broadcast('done', { exitCode: code });
  });
});

// ── GET /api/deploy/stream (SSE) ──────────────────────────────
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay buffered log to reconnecting client
  deployState.logLines.forEach(line => {
    res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);
  });
  if (!deployState.running) {
    res.write(`event: status\ndata: ${JSON.stringify({ running: false, exitCode: deployState.exitCode })}\n\n`);
  }

  activeClients.push(res);

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    activeClients = activeClients.filter(c => c !== res);
  });
});

// ── GET /api/deploy/status ────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    running:   deployState.running,
    pid:       deployState.pid,
    startedAt: deployState.startedAt,
    exitCode:  deployState.exitCode,
    logLines:  deployState.logLines.slice(-100),
  });
});

// ── DELETE /api/deploy (abort) ────────────────────────────────
router.delete('/', (req, res) => {
  if (!deployState.running || !deployState.pid) {
    return res.status(400).json({ error: 'No deployment running' });
  }
  try {
    process.kill(deployState.pid, 'SIGTERM');
    res.json({ ok: true, message: 'SIGTERM sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

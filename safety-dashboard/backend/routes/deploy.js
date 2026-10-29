'use strict';
/**
 * /api/deploy — run network.sh from the dashboard and stream its log (SSE).
 *
 *   POST   /api/deploy          { networkConfig?, mode? }  mode: all | channel | deploy | identities | status
 *                                networkConfig (optional) is validated and saved first; "all" regenerates
 *                                compose, configtx, app.env and secrets from it.
 *   POST   /api/deploy/enroll   enrol the app users into the wallet (= mode "identities")
 *   GET    /api/deploy/stream   SSE: event "log" {line}, "status" {running, exitCode}, "done" {exitCode}
 *   GET    /api/deploy/status   last 100 log lines and state
 *   DELETE /api/deploy          abort the running job
 *
 * "down" is deliberately not exposed: deleting a network is a shell-only action.
 * Admin-only: mounted behind requireRole('admin') in server.js.
 */
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { spawn } = require('child_process');
const { buildModel, ConfigError } = require('../lib/networkModel');
const { TG_HOME, NETWORK_ROOT, FABRIC_BIN, CONFIG_FILE, NETWORK_SCRIPT } = require('../lib/paths');

const router = express.Router();
const MODES = ['all', 'channel', 'deploy', 'identities', 'status'];

let state = { running: false, pid: null, mode: null, startedAt: null, exitCode: null, logLines: [] };
let clients = [];

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(payload); } catch (_) { /* client gone */ } });
}

// Strip ANSI colour codes and anything that looks like a credential in a URL.
function clean(line) {
  return line.replace(/\x1b\[[0-9;]*m/g, '').replace(/(https?:\/\/)[^:@\/\s]+:[^@\s]+@/g, '$1***:***@');
}

function addLog(line) {
  const l = clean(line);
  state.logLines.push(l);
  if (state.logLines.length > 2000) state.logLines = state.logLines.slice(-1500);
  broadcast('log', { line: l });
}

function start(mode, res) {
  state = { running: true, pid: null, mode, startedAt: new Date().toISOString(), exitCode: null, logLines: [] };
  broadcast('status', { running: true, mode, startedAt: state.startedAt });
  res.json({ ok: true, mode, startedAt: state.startedAt });

  addLog(`[INFO] network.sh ${mode} (${NETWORK_ROOT})`);
  const proc = spawn('bash', [NETWORK_SCRIPT, mode], {
    cwd: NETWORK_ROOT,
    env: { ...process.env, TG_HOME, FABRIC_BIN, NODE_BIN: process.execPath,
           PATH: `${FABRIC_BIN}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.pid = proc.pid;
  const pipe = prefix => data => data.toString().split('\n').filter(Boolean).forEach(l => addLog(prefix + l));
  proc.stdout.on('data', pipe(''));
  proc.stderr.on('data', pipe('[stderr] '));
  proc.on('close', code => {
    state.running = false; state.exitCode = code; state.pid = null;
    addLog(code === 0 ? `[SUCCESS] network.sh ${mode} finished.` : `[ERROR] network.sh ${mode} exited with code ${code}`);
    broadcast('status', { running: false, exitCode: code });
    broadcast('done', { exitCode: code });
  });
}

router.post('/', (req, res) => {
  if (state.running) return res.status(409).json({ error: `network.sh ${state.mode} is already running` });
  const { networkConfig, mode = 'all' } = req.body || {};
  if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });

  if (networkConfig) {
    try {
      buildModel(networkConfig, { tgHome: TG_HOME });           // validate before touching anything
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(networkConfig, null, 2));
    } catch (err) {
      if (err instanceof ConfigError) return res.status(400).json({ ok: false, problems: err.problems });
      return res.status(500).json({ ok: false, error: `Failed to save config: ${err.message}` });
    }
  } else if (!fs.existsSync(CONFIG_FILE)) {
    return res.status(400).json({ ok: false, problems: ['no network config saved yet: design the network first'] });
  }
  start(mode, res);
});

router.post('/enroll', (req, res) => {
  if (state.running) return res.status(409).json({ error: `network.sh ${state.mode} is already running` });
  start('identities', res);
});

router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  state.logLines.forEach(line => res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`));
  if (!state.running) res.write(`event: status\ndata: ${JSON.stringify({ running: false, exitCode: state.exitCode })}\n\n`);
  clients.push(res);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { /* gone */ } }, 20000);
  req.on('close', () => { clearInterval(keepAlive); clients = clients.filter(c => c !== res); });
});

router.get('/status', (req, res) => {
  res.json({ running: state.running, mode: state.mode, pid: state.pid, startedAt: state.startedAt,
             exitCode: state.exitCode, logLines: state.logLines.slice(-100) });
});

router.delete('/', (req, res) => {
  if (!state.running || !state.pid) return res.status(400).json({ error: 'Nothing is running' });
  try { process.kill(state.pid, 'SIGTERM'); res.json({ ok: true, message: 'SIGTERM sent' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

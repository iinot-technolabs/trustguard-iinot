'use strict';
// Read/write network-config.json atomically. The Network Designer and Deploy save the whole file;
// the Rules Designer's "rules" block is kept unless the new body carries its own (TG-028).
const fs   = require('fs');
const path = require('path');
const { CONFIG_FILE } = require('./paths');

function readConfig() {
  return fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : null;
}

function writeConfig(cfg) {
  let out = cfg;
  if (cfg && cfg.rules === undefined) {
    try { const old = readConfig(); if (old && old.rules) out = { ...cfg, rules: old.rules }; } catch { /* unreadable: overwrite */ }
  }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
  return out;
}

module.exports = { readConfig, writeConfig };

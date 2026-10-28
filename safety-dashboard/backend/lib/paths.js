'use strict';
/**
 * paths.js — install locations, resolved once.
 * TG_HOME (repo root) comes from the environment (install.sh writes it to .env);
 * otherwise it is derived from this file's location: <TG_HOME>/safety-dashboard/backend/lib.
 */
const path = require('path');

const TG_HOME       = path.resolve(process.env.TG_HOME || process.env.TRUSTGUARD_ROOT || path.join(__dirname, '..', '..', '..'));
const NETWORK_ROOT  = path.resolve(process.env.NETWORK_ROOT || path.join(TG_HOME, 'iinot-network'));
const FABRIC_BIN    = path.resolve(process.env.FABRIC_BIN || path.join(TG_HOME, 'bin'));
const CONFIG_FILE   = path.join(NETWORK_ROOT, 'config', 'network-config.json');
const DERIVED_FILE  = path.join(NETWORK_ROOT, 'config', 'network.derived.json');
const NETWORK_SCRIPT= path.join(NETWORK_ROOT, 'scripts', 'network.sh');
const GENERATOR     = path.join(__dirname, 'generateConfigs.js');

module.exports = { TG_HOME, NETWORK_ROOT, FABRIC_BIN, CONFIG_FILE, DERIVED_FILE, NETWORK_SCRIPT, GENERATOR };

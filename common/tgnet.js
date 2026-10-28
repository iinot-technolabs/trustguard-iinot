'use strict';
/**
 * common/tgnet.js — how any TrustGuard component connects to the deployed network.
 *
 * Reads iinot-network/config/network.derived.json (written by generateConfigs.js from the
 * Network Designer config) and the shared wallet (<TG_HOME>/wallet/<identity>/). Nothing
 * here names an organisation, channel, chaincode, port or path: the backend, the gateway,
 * the oracle, the escalation service and the test scripts all ask this module instead.
 *
 * No npm dependencies (callers pass in their own grpc / fabric-gateway), so it can be
 * required from safety-dashboard/backend and safety-simulation alike.
 *
 *   const tg = require('../common/tgnet');
 *   const id = tg.identityForRole('gateway');        // or tg.identity('gateway1')
 *   const { contract } = tg.connect(id, { grpc, connect, signers });
 *
 * Environment overrides: TG_HOME, NETWORK_CONFIG (path to network.derived.json),
 * WALLET_DIR, OFFCHAIN_DB, TG_CLIENT_CONFIG.
 */
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const TG_HOME = path.resolve(process.env.TG_HOME || process.env.TRUSTGUARD_ROOT || path.join(__dirname, '..'));

function derivedFile() {
  return path.resolve(process.env.NETWORK_CONFIG || path.join(TG_HOME, 'iinot-network', 'config', 'network.derived.json'));
}

let cache = null;
/** The deployed network model. Re-read when the file changes (after a redeploy). */
function load() {
  const file = derivedFile();
  let st;
  try { st = fs.statSync(file); }
  catch {
    throw new Error(`No deployed network found (${file} is missing). Design and deploy the network from the dashboard first.`);
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.model;
  const model = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache = { file, mtimeMs: st.mtimeMs, model };
  return model;
}

function walletDir() {
  if (process.env.WALLET_DIR) return path.resolve(process.env.WALLET_DIR);
  try { return load().paths.wallet; } catch { return path.join(TG_HOME, 'wallet'); }
}

function orgOf(model, mspId) {
  return model.orgs.find(o => o.mspId === mspId) || null;
}

function describe(model, org, user) {
  const w = path.join(walletDir(), user.name);
  return {
    name: user.name,
    role: user.role,
    mspId: org.mspId,
    orgType: org.type,
    orgLabel: org.label,
    certPath: path.join(w, 'cert.pem'),
    keyPath: path.join(w, 'key.pem'),
    peerEndpoint: `localhost:${org.peerPort}`,
    peerHostOverride: org.peerHost,
    tlsCertPath: path.join(model.paths.networkRoot, 'organizations', 'peerOrganizations',
                           org.domain, 'peers', org.peerHost, 'tls', 'ca.crt'),
    channel: model.network.channel,
    chaincode: model.chaincode.name,
  };
}

/** Connection details for a named app identity, e.g. "gateway1". */
function identity(name) {
  const model = load();
  for (const org of model.orgs) {
    const user = org.users.find(u => u.name === name);
    if (user) return describe(model, org, user);
  }
  throw new Error(`Identity '${name}' is not defined in the network config (${model.orgs.flatMap(o => o.users.map(u => u.name)).join(', ') || 'no users'}).`);
}

/**
 * First identity holding <role> (gateway, supervisor, auditor, claims-reviewer, oracle),
 * optionally restricted to an org type. Returns null if the network has none (e.g. no insurer).
 */
function identityForRole(role, orgType) {
  const model = load();
  for (const org of model.orgs) {
    if (orgType && org.type !== orgType) continue;
    const user = org.users.find(u => u.role === role);
    if (user) return describe(model, org, user);
  }
  return null;
}

/** Check that an identity's wallet entry exists; returns { ok, problem }. */
function walletStatus(id) {
  if (!fs.existsSync(id.certPath) || !fs.existsSync(id.keyPath)) {
    return { ok: false, problem: `Identity '${id.name}' is not in the wallet (${path.dirname(id.certPath)}). Run Enroll Identities on the Admin page, or: iinot-network/scripts/network.sh identities` };
  }
  return { ok: true };
}

/**
 * Open a Fabric Gateway connection as <id>, on that identity's own organisation peer.
 * deps = { grpc, connect, signers } from the caller's node_modules;
 * options = extra fabric-gateway connect options (e.g. endorseOptions deadlines).
 */
function connect(id, deps, options = {}) {
  const { grpc, connect: gwConnect, signers } = deps;
  const w = walletStatus(id);
  if (!w.ok) throw new Error(w.problem);
  const client = new grpc.Client(id.peerEndpoint, grpc.credentials.createSsl(fs.readFileSync(id.tlsCertPath)),
                                 { 'grpc.ssl_target_name_override': id.peerHostOverride });
  const gateway = gwConnect({
    client,
    identity: { mspId: id.mspId, credentials: fs.readFileSync(id.certPath) },
    signer: signers.newPrivateKeySigner(crypto.createPrivateKey(fs.readFileSync(id.keyPath))),
    ...options,
  });
  const network = gateway.getNetwork(id.channel);
  return { client, grpcClient: client, gateway, network, contract: network.getContract(id.chaincode) };
}

/** Public summary for the dashboard (no paths, no secrets). */
function summary() {
  const m = load();
  return {
    network: m.network.name,
    channel: m.network.channel,
    chaincode: m.chaincode.name,
    chaincodeVersion: m.chaincode.version,
    endorsementPolicy: m.chaincode.policy,
    orgs: m.orgs.map(o => ({ mspId: o.mspId, label: o.label, type: o.type, endorses: o.endorses })),
  };
}

/** Off-chain SQLite database shared by the gateway, oracle, escalation and the backend. */
function offchainDb() {
  return path.resolve(process.env.OFFCHAIN_DB || process.env.DB_PATH || path.join(TG_HOME, 'safety-simulation', 'offchain.db'));
}

/**
 * Per-client settings (sites.json, policy.json, model-v1.json, factory.json):
 * <TG_HOME>/config/client/<name> if present (installed per client, not in git),
 * otherwise the example shipped in the package (fallbackPath).
 */
function clientFile(name, fallbackPath) {
  const dir = path.resolve(process.env.TG_CLIENT_CONFIG || path.join(TG_HOME, 'config', 'client'));
  const p = path.join(dir, name);
  return fs.existsSync(p) ? p : fallbackPath;
}

module.exports = { TG_HOME, load, identity, identityForRole, walletStatus, connect, summary,
                   walletDir, offchainDb, clientFile, derivedFile };

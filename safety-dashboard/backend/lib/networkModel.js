'use strict';
/**
 * networkModel.js — TrustGuard IIoT
 *
 * Single place where a Network Designer config (network-config.json) is
 * validated and turned into the fully-derived model that every other step uses:
 *   - generateConfigs.js  (docker-compose.yaml, configtx.yaml, app.env)
 *   - scripts/config-reader.sh (reads config/network.derived.json)
 *
 * Nothing in here knows any particular network's names. Kishore's live network
 * is just examples/iinot-demo.network-config.json.
 *
 * Accepted input: the Network Designer shape
 *   { network:{name, channel, ...}, orderer:{...}, organizations:[...], chaincode:{...} }
 * and the older Phase-4 shape ({ networkName, channel:{name}, orgs:[...], ordererOrg:{...} }).
 */

const path = require('path');

const ORG_TYPES = ['employer', 'regulator', 'insurer'];
const KNOWN_ROLES = ['gateway', 'supervisor', 'auditor', 'claims-reviewer', 'oracle'];

const RE = {
  domain:   /^(?=.{3,120}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
  mspId:    /^[A-Za-z][A-Za-z0-9]{1,62}$/,
  channel:  /^[a-z][a-z0-9.-]{0,48}$/,          // Fabric channel name rules
  ccName:   /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/,
  version:  /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/,
  caName:   /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/,
  slug:     /^[a-z0-9][a-z0-9_-]{0,62}$/,
  user:     /^[a-z][a-z0-9_-]{1,40}$/,
  role:     /^[a-z][a-z-]{1,30}$/,
  profile:  /^[A-Za-z][A-Za-z0-9]{0,62}$/,
  dockerNet:/^[a-z0-9][a-z0-9_-]{0,62}$/,
  duration: /^[0-9]{1,5}(ms|s)$/,
  bytes:    /^[0-9]{1,4} ?(KB|MB)$/,
  semver:   /^[0-9]+\.[0-9]+\.[0-9]+$/,
  ipv4:     /^(127\.0\.0\.1|0\.0\.0\.0|([0-9]{1,3}\.){3}[0-9]{1,3})$/,
};

class ConfigError extends Error {
  constructor(problems) {
    super('Invalid network config:\n  - ' + problems.join('\n  - '));
    this.problems = problems;
  }
}

/** "role.gateway:ecert" | "role=gateway:ecert" | "role=gateway" | "gateway" → "gateway" */
function parseRole(r) {
  const raw = String((r && (r.role || r.attrs)) || '').trim();
  let m = raw.match(/^role[.=]([a-z-]+)(:ecert)?$/);
  if (m) return m[1];
  m = raw.match(/^([a-z-]+)$/);
  return m ? m[1] : raw;
}

function inferType(o) {
  const s = `${o.type || ''} ${o.id || o.mspId || ''} ${o.name || ''}`.toLowerCase();
  if (o.type && ORG_TYPES.includes(String(o.type).toLowerCase())) return String(o.type).toLowerCase();
  if (/insur/.test(s)) return 'insurer';
  if (/regulat|inspector|dgms|labour|labor|government/.test(s)) return 'regulator';
  return 'employer';
}

function slugOfDomain(d) { return String(d).split('.')[0].replace(/[^a-z0-9_-]/g, ''); }

/** Turn "500ms"/"2s" into a number of ms (for range checks). */
function durationMs(s) { const m = String(s).match(/^([0-9]+)(ms|s)$/); return m ? (+m[1]) * (m[2] === 's' ? 1000 : 1) : NaN; }

/**
 * @param {object} raw     parsed network-config.json
 * @param {object} opts    { tgHome } install root (repo root)
 * @returns derived model; throws ConfigError listing every problem found
 */
function buildModel(raw, opts = {}) {
  const problems = [];
  const warnings = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };

  const tgHome = path.resolve(opts.tgHome || path.join(__dirname, '..', '..', '..'));
  const networkRoot = path.join(tgHome, 'iinot-network');

  const net = raw.network || {};
  const ordSrc = raw.orderer || raw.ordererOrg || {};
  const ccSrc = raw.chaincode || {};
  const orgSrc = Array.isArray(raw.organizations) && raw.organizations.length ? raw.organizations
               : Array.isArray(raw.orgs) ? raw.orgs : [];

  // ── network ────────────────────────────────────────────────
  const network = {
    name:          String(net.name || raw.networkName || 'TrustGuard Network'),
    channel:       String(net.channel || (raw.channel && raw.channel.name) || ''),
    genesisProfile:String(net.genesisProfile || 'TrustGuardGenesis'),
    dockerNetwork: String(net.dockerNetworkName || 'trustguard_net').toLowerCase().replace(/[^a-z0-9_-]/g, '_'),
    bindAddress:   String(net.bindAddress || '127.0.0.1'),
    fabricVersion: String(net.fabricVersion || '2.5.15'),
    caVersion:     String(net.fabricCAVersion || '1.5.17'),
  };
  need(RE.channel.test(network.channel), `network.channel "${network.channel}" must be lowercase letters, digits, '.' or '-', starting with a letter`);
  need(RE.profile.test(network.genesisProfile), `network.genesisProfile "${network.genesisProfile}" must be letters and digits`);
  need(RE.dockerNet.test(network.dockerNetwork), `network.dockerNetworkName "${network.dockerNetwork}" is not a valid Docker network name`);
  need(RE.ipv4.test(network.bindAddress), `network.bindAddress "${network.bindAddress}" must be an IPv4 address (127.0.0.1 for a single host)`);
  need(RE.semver.test(network.fabricVersion), `network.fabricVersion "${network.fabricVersion}" must look like 2.5.15`);
  need(RE.semver.test(network.caVersion), `network.fabricCAVersion "${network.caVersion}" must look like 1.5.17`);
  if (network.bindAddress === '0.0.0.0') warnings.push('network.bindAddress is 0.0.0.0: CA, peer and orderer ports will be reachable from outside unless the firewall closes them');

  // ── orderer ────────────────────────────────────────────────
  const oDomain = String(ordSrc.domain || '');
  const orderer = {
    mspId:      String(ordSrc.mspId || 'OrdererMSP'),
    domain:     oDomain,
    // Designer often puts "orderer.<base>" in the domain; avoid "orderer.orderer.<base>".
    host:       oDomain.startsWith('orderer.') ? oDomain : `orderer.${oDomain}`,
    port:       +(ordSrc.port || 7050),
    adminPort:  +(ordSrc.adminPort || 7053),
    opsPort:    +(ordSrc.operationsPort || 9443),
    caPort:     +(ordSrc.caPort || 9054),
    caName:     String(ordSrc.caName || `ca-${slugOfDomain(oDomain) || 'orderer'}`),
    caSlug:     String(ordSrc.caFolderName || ordSrc.caSlug || `${slugOfDomain(oDomain) || 'orderer'}-orderer`).toLowerCase(),
    batchTimeout:     String(ordSrc.batchTimeout || '500ms'),
    maxMessageCount:  +(ordSrc.maxMessageCount || 10),
    absoluteMaxBytes: String(ordSrc.absoluteMaxBytes || '99 MB'),
    preferredMaxBytes:String(ordSrc.preferredMaxBytes || '512 KB'),
  };
  need(RE.domain.test(orderer.domain), `orderer.domain "${orderer.domain}" is not a valid lowercase domain`);
  need(RE.mspId.test(orderer.mspId), `orderer.mspId "${orderer.mspId}" must be letters and digits`);
  need(RE.caName.test(orderer.caName), `orderer.caName "${orderer.caName}" has invalid characters`);
  need(RE.slug.test(orderer.caSlug), `orderer.caFolderName "${orderer.caSlug}" must be lowercase letters, digits, '-' or '_'`);
  need(RE.duration.test(orderer.batchTimeout) && durationMs(orderer.batchTimeout) >= 50 && durationMs(orderer.batchTimeout) <= 10000,
       `orderer.batchTimeout "${orderer.batchTimeout}" must be between 50ms and 10s, e.g. "500ms"`);
  need(Number.isInteger(orderer.maxMessageCount) && orderer.maxMessageCount >= 1 && orderer.maxMessageCount <= 1000, 'orderer.maxMessageCount must be 1-1000');
  need(RE.bytes.test(orderer.absoluteMaxBytes), `orderer.absoluteMaxBytes "${orderer.absoluteMaxBytes}" must look like "99 MB"`);
  need(RE.bytes.test(orderer.preferredMaxBytes), `orderer.preferredMaxBytes "${orderer.preferredMaxBytes}" must look like "512 KB"`);

  // ── peer organisations ─────────────────────────────────────
  const orgs = [];
  orgSrc.forEach((o, i) => {
    const enabled = o.enabled !== false;
    const type = inferType(o);
    const domain = String(o.domain || '');
    const peerPort = +(o.peerPort || 7051 + i * 2000);
    const org = {
      index:         i,
      label:         String(o.name || o.label || `Org ${i + 1}`),
      type,
      enabled,
      mspId:         String(o.id || o.mspId || ''),
      domain,
      peerHost:      `peer0.${domain}`,
      peerPort,
      chaincodePort: +(o.chaincodePort || peerPort + 1),
      opsPort:       +(o.operationsPort || o.opsPort || peerPort + 10000),
      caPort:        +(o.caPort || 7054 + i * 1000),
      caName:        String(o.caName || `ca-${slugOfDomain(domain)}`),
      caSlug:        String(o.caFolderName || o.caSlug || slugOfDomain(domain)).toLowerCase(),
      endorses:      typeof o.endorses === 'boolean' ? o.endorses : type !== 'insurer',
      users:         (o.roles || o.users || []).map(r => ({ name: String(r.name || ''), role: parseRole(r) })),
    };
    const where = `organizations[${i}] (${org.label})`;
    need(RE.mspId.test(org.mspId), `${where}: MSP ID "${org.mspId}" must be letters and digits`);
    need(RE.domain.test(org.domain), `${where}: domain "${org.domain}" is not a valid lowercase domain`);
    need(RE.caName.test(org.caName), `${where}: CA name "${org.caName}" has invalid characters`);
    need(RE.slug.test(org.caSlug), `${where}: CA folder "${org.caSlug}" must be lowercase letters, digits, '-' or '_'`);
    org.users.forEach(u => {
      need(RE.user.test(u.name), `${where}: user name "${u.name}" must be lowercase letters/digits, starting with a letter`);
      need(RE.role.test(u.role), `${where}: user "${u.name}" has role "${u.role}"; expected e.g. role.gateway:ecert`);
      if (RE.role.test(u.role) && !KNOWN_ROLES.includes(u.role)) warnings.push(`${where}: role "${u.role}" is not one the chaincode checks (${KNOWN_ROLES.join(', ')})`);
    });
    if (enabled) orgs.push(org);
  });

  need(orgs.length >= 1, 'at least one enabled organisation is required');
  need(orgs.filter(o => o.type === 'employer').length >= 1, 'one organisation must be of type "employer" (it hosts the gateway)');
  need(orgs.filter(o => o.type === 'insurer').length <= 1, 'at most one insurer organisation');
  const endorsers = orgs.filter(o => o.endorses);
  need(endorsers.length >= 1, 'at least one organisation must endorse transactions');
  if (orgs.some(o => o.type === 'insurer' && o.endorses)) warnings.push('the insurer endorses transactions; the usual setup is employer + regulator only');

  // Uniqueness checks
  const dup = (list, what) => {
    const seen = new Map();
    list.forEach(([k, who]) => { if (seen.has(k)) problems.push(`${what} "${k}" is used by both ${seen.get(k)} and ${who}`); else seen.set(k, who); });
  };
  dup([[orderer.mspId, 'orderer'], ...orgs.map(o => [o.mspId, o.label])], 'MSP ID');
  dup([[orderer.domain, 'orderer'], ...orgs.map(o => [o.domain, o.label])], 'domain');
  dup([[orderer.caSlug, 'orderer CA'], ...orgs.map(o => [o.caSlug, o.label])], 'CA folder');
  dup(orgs.flatMap(o => o.users.map(u => [u.name, o.label])), 'user name');
  const ports = [
    [orderer.port, 'orderer'], [orderer.adminPort, 'orderer admin'], [orderer.opsPort, 'orderer operations'], [orderer.caPort, 'orderer CA'],
    ...orgs.flatMap(o => [[o.peerPort, `${o.label} peer`], [o.chaincodePort, `${o.label} chaincode`], [o.opsPort, `${o.label} operations`], [o.caPort, `${o.label} CA`]]),
  ];
  ports.forEach(([p, who]) => need(Number.isInteger(p) && p >= 1024 && p <= 65535, `${who} port "${p}" must be 1024-65535`));
  dup(ports.map(([p, who]) => [String(p), who]), 'port');

  // ── chaincode ──────────────────────────────────────────────
  const ccPathRaw = String(ccSrc.path || 'safety-chaincode');
  const chaincode = {
    name:     String(ccSrc.name || 'safetycc'),
    version:  String(ccSrc.version || '1.0'),
    sequence: +(ccSrc.sequence || 1),
    lang:     String(ccSrc.lang || 'node'),
    path:     path.isAbsolute(ccPathRaw) ? ccPathRaw : path.join(tgHome, ccPathRaw),
  };
  chaincode.label = `${chaincode.name}_${chaincode.version}`;
  need(RE.ccName.test(chaincode.name), `chaincode.name "${chaincode.name}" must be letters, digits, '-' or '_'`);
  need(RE.version.test(chaincode.version), `chaincode.version "${chaincode.version}" has invalid characters`);
  need(Number.isInteger(chaincode.sequence) && chaincode.sequence >= 1, 'chaincode.sequence must be a whole number ≥ 1');
  need(['node', 'golang', 'java'].includes(chaincode.lang), `chaincode.lang "${chaincode.lang}" must be node, golang or java`);
  need(!ccPathRaw.split(/[\\/]/).includes('..'), 'chaincode.path must not contain ".."');

  // Endorsement policy is always derived from the per-org "endorses" flags.
  // (A free-text policy is ignored: "MAJORITY(...)" is not valid --signature-policy
  //  syntax, and with 3 orgs a majority lets employer + insurer write without the regulator.)
  const peerTerms = endorsers.map(o => `'${o.mspId}.peer'`);
  chaincode.policy = peerTerms.length === 1 ? `OR(${peerTerms[0]})` : `AND(${peerTerms.join(',')})`;
  if (ccSrc.endorsementPolicy && ccSrc.endorsementPolicy !== chaincode.policy) {
    warnings.push(`chaincode.endorsementPolicy "${ccSrc.endorsementPolicy}" is ignored; using ${chaincode.policy} from the organisations marked as endorsers`);
  }

  if (problems.length) throw new ConfigError(problems);

  const byType = t => orgs.find(o => o.type === t) || null;
  return {
    schema: 'trustguard.network/1',
    network, orderer, orgs, chaincode,
    gatewayOrg: byType('employer'),
    regulatorOrg: byType('regulator'),
    insurerOrg: byType('insurer'),
    paths: {
      tgHome,
      networkRoot,
      configDir:  path.join(networkRoot, 'config'),
      secretsDir: path.join(networkRoot, 'config', 'secrets'),
      wallet:     path.join(tgHome, 'wallet'),
    },
    warnings,
  };
}

module.exports = { buildModel, parseRole, ConfigError, KNOWN_ROLES, ORG_TYPES };

/**
 * normalizeConfig.js
 * Fills in all fields that config-reader.sh expects, using
 * reasonable defaults derived from the existing fields.
 *
 * Called by generateConfigs.js and deploy.js to ensure backwards
 * compatibility with older network-config.json shapes.
 *
 * Input shape (current Network Designer output):
 * {
 *   networkName: "AP Factory Safety Network",
 *   channel: { name: "iinot-safety-channel" },
 *   chaincode: { name: "safetycc", path: "safety-chaincode", lang: "node" },
 *   orgs: [
 *     { name: "industry", mspId: "IINoTIndustryMSP", domain: "iinot-industry.com",
 *       peerPort: 7051, caPort: 7054 },
 *     ...
 *   ],
 *   orderer: { domain: "iinot-safety.com", mspId: "IINoTOrdererMSP", port: 7050 }
 * }
 *
 * Output: same shape with all optional fields filled in.
 */

function normalizeConfig(cfg) {
  // Deep clone to avoid mutating the original
  const c = JSON.parse(JSON.stringify(cfg));

  // ── Top-level defaults ────────────────────────────────────
  c.networkName  = c.networkName  || (c.network && c.network.name)  || 'IINoT Network';
  c.channel      = c.channel      || {};
  c.channel.name = c.channel.name || (c.network && c.network.channel) || 'iinot-safety-channel';
  c.chaincode    = c.chaincode    || {};
  c.chaincode.name = c.chaincode.name || 'safetycc';
  c.chaincode.path = c.chaincode.path || 'safety-chaincode';
  c.chaincode.lang = c.chaincode.lang || 'node';
  // Support new schema (.organizations[]) alongside old schema (.orgs[])
  // If .orgs is missing or empty but .organizations has entries, map across.
  if ((!c.orgs || c.orgs.length === 0) && Array.isArray(c.organizations) && c.organizations.length > 0) {
    c.orgs = c.organizations.map(o => ({
      name:          o.name,
      mspId:         o.id          || o.mspId,
      domain:        o.domain,
      peerPort:      o.peerPort,
      chaincodePort: o.chaincodePort,
      opsPort:       o.operationsPort || o.opsPort,
      caPort:        o.caPort,
      caName:        o.caName,
      caSlug:        o.caFolderName  || o.caSlug,
      // Map roles[] → users[] with attrs→role for generateConfigs.js
      users: (o.roles || o.users || []).map(r => ({
        name: r.name,
        role: r.attrs || r.role || '',
      })),
    }));
  } else {
    c.orgs = c.orgs || [];
  }

  // ── Orderer org ───────────────────────────────────────────
  // Support both c.orderer and c.ordererOrg shapes
  const ordSrc = c.ordererOrg || c.orderer || {};
  c.ordererOrg = {
    domain:    ordSrc.domain    || 'iinot-safety.com',
    mspId:     ordSrc.mspId     || 'IINoTOrdererMSP',
    port:      ordSrc.port      || 7050,
    adminPort: ordSrc.adminPort || 7053,
    caPort:    ordSrc.caPort    || 9054,
    // caName: "ca-iinot-orderer" derived from domain slug if not set
    caName:    ordSrc.caName    || `ca-${domainToSlug(ordSrc.domain || 'iinot-safety.com')}`,
    caSlug:    ordSrc.caSlug    || domainToSlug(ordSrc.domain || 'iinot-safety.com'),
  };
  // Remove old key if present
  delete c.orderer;

  // ── Peer orgs ─────────────────────────────────────────────
  c.orgs = c.orgs.map((org, i) => {
    const peerPort = org.peerPort || (7051 + i * 2000);
    const caPort   = org.caPort   || (7054 + i * 1000);
    const domain   = org.domain   || `${org.name}.com`;
    const slug     = org.caSlug   || domainToSlug(domain);

    return {
      name:          org.name,
      mspId:         org.mspId    || `${capitalize(org.name)}MSP`,
      domain:        domain,
      peerPort:      peerPort,
      chaincodePort: org.chaincodePort || (peerPort + 1),
      opsPort:       org.opsPort       || (peerPort + 10000),
      caPort:        caPort,
      caName:        org.caName        || `ca-${slug}`,
      caSlug:        slug,
      // users: array of { name, role } — default empty; Network Designer populates this
      users:         org.users         || [],
    };
  });

  return c;
}

/** "iinot-industry.com" → "iinot-industry" */
function domainToSlug(domain) {
  return domain.split('.')[0];
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { normalizeConfig };

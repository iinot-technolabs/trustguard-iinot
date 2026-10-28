import { useState, useCallback } from 'react';
import './ConfigureNetworkPage.css';

// ─── Constants ─────────────────────────────────────────────────────────────

// Organisation types the platform understands (docs/NETWORK_CONFIG.md).
const ORG_TYPES = [
  { value: 'employer',  label: 'Employer / Industry', color: '#3b82f6' },
  { value: 'regulator', label: 'Regulator',           color: '#8b5cf6' },
  { value: 'insurer',   label: 'Insurer',             color: '#10b981' },
];

// Roles the safety chaincode checks (CA attribute "role").
const APP_ROLES = [
  { value: 'gateway',         label: 'gateway — IoT gateway, logs incidents' },
  { value: 'supervisor',      label: 'supervisor — acknowledges, resolves, files Form 18' },
  { value: 'auditor',         label: 'auditor — regulator, read-only' },
  { value: 'oracle',          label: 'oracle — anchors weather readings' },
  { value: 'claims-reviewer', label: 'claims-reviewer — insurer, claim evidence' },
];

const roleOf = attrs => {
  const m = String(attrs || '').match(/^role[.=]([a-z-]+)/) || String(attrs || '').match(/^([a-z-]+)$/);
  return m ? m[1] : '';
};
const legacyType = t => (t === 'industry' || t === 'custom' || !t) ? 'employer' : t;

// Endorsement policy as the deploy builds it: every enabled org marked "endorses" must sign.
function derivedPolicy(orgs) {
  const e = orgs.filter(o => o.enabled !== false && o.endorses).map(o => `'${o.mspId || '?'}.peer'`);
  if (!e.length) return '— (no endorsing organisation)';
  return e.length === 1 ? `OR(${e[0]})` : `AND(${e.join(',')})`;
}

const DEFAULT_CONFIG = {
  networkName:      'AP Factory Safety Network',
  channelName:      'apfactory-safety-channel',
  domain:           'apfactory.com',
  fabricVersion:    '2.5.15',
  fabricCAVersion:  '1.5.17',
  dockerNetworkName: '',
  genesisProfile:   '',
  bindAddress:      '127.0.0.1',
  orderer: {
    orgName:           'OrdererOrg',
    mspId:             'OrdererMSP',
    hostname:          'orderer',
    port:              7050,
    adminPort:         7053,
    caPort:            9054,
    caName:            'ca-orderer',
    caFolderName:      'ordererorg',
    anchorName:        '&OrdererOrg',
    nodeCount:         1,
    batchTimeout:      '500ms',
    maxMessageCount:   10,
    absoluteMaxBytes:  '98 MB',
    preferredMaxBytes: '512 KB',
  },
  organizations: [
    {
      id: genId(), mspId: 'IINoTIndustryMSP', displayName: 'Employer / Factory Owner',
      type: 'employer', enabled: true, endorses: true, domain: '',
      caPort: 7054, peerPort: 7051, chaincodePort: 7052, operationsPort: 17051,
      caName: '', caFolderName: '',
      roles: [
        { id: genId(), name: 'gateway1',    attrs: 'role.gateway:ecert' },
        { id: genId(), name: 'supervisor1', attrs: 'role.supervisor:ecert' },
      ],
    },
    {
      id: genId(), mspId: 'IINoTRegulatorMSP', displayName: 'Inspector of Factories',
      type: 'regulator', enabled: true, endorses: true, domain: '',
      caPort: 8054, peerPort: 9051, chaincodePort: 9052, operationsPort: 19051,
      caName: '', caFolderName: '',
      roles: [
        { id: genId(), name: 'auditor1', attrs: 'role.auditor:ecert' },
        { id: genId(), name: 'oracle1',  attrs: 'role.oracle:ecert' },
      ],
    },
    {
      id: genId(), mspId: 'IINoTInsurerMSP', displayName: 'Insurer',
      type: 'insurer', enabled: false, endorses: false, domain: '',
      caPort: 10054, peerPort: 11051, chaincodePort: 11052, operationsPort: 21051,
      caName: '', caFolderName: '',
      roles: [
        { id: genId(), name: 'claims1', attrs: 'role.claims-reviewer:ecert' },
      ],
    },
  ],
  chaincode: {
    name:              'safetycc',
    version:           '1.3',
    eventTypes:        ['SOS', 'ManDown', 'GasAlert', 'OverTemp', 'Geofence'],
  },
  dashboard: {
    backendPort: 3001,
    frontendUrl: '',
  },
};

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
/**
 * Convert the saved network-config.json (nested API shape) back into the
 * flat internal shape used by this form.
 *
 * Saved shape:  { network:{name,channel,...}, orderer:{...}, organizations:[{id,name,...}] }
 * Form shape:   { networkName, channelName, domain, orderer:{...}, organizations:[{mspId,displayName,...}] }
 */
function denormalizeConfig(saved) {
  if (!saved || !saved.network) return null;
  const net = saved.network;
  const ord = saved.orderer || {};

  // Derive shared domain from first org domain, e.g. "industry1.apfactory.com" -> "apfactory.com"
  const firstOrgDomain = (saved.organizations || [])[0]?.domain || '';
  const parts  = firstOrgDomain.split('.');
  const domain = parts.length >= 3 ? parts.slice(-2).join('.') : firstOrgDomain;

  return {
    networkName:       net.name              || '',
    channelName:       net.channel           || '',
    domain:            domain,
    fabricVersion:     net.fabricVersion     || '2.5.15',
    fabricCAVersion:   net.fabricCAVersion   || '1.5.17',
    dockerNetworkName: net.dockerNetworkName || '',
    genesisProfile:    net.genesisProfile    || '',
    bindAddress:       net.bindAddress       || '127.0.0.1',
    orderer: {
      orgName:           ord.orgName           || 'OrdererOrg',
      mspId:             ord.mspId             || 'OrdererMSP',
      hostname:          ord.hostname          || 'orderer',
      port:              ord.port              || 7050,
      adminPort:         ord.adminPort         || 7053,
      caPort:            ord.caPort            || 9054,
      caName:            ord.caName            || 'ca-orderer',
      caFolderName:      ord.caFolderName      || 'ordererorg',
      anchorName:        ord.anchorName        || '&OrdererOrg',
      nodeCount:         ord.nodeCount         || 1,
      batchTimeout:      ord.batchTimeout      || '500ms',
      maxMessageCount:   ord.maxMessageCount   || 10,
      absoluteMaxBytes:  ord.absoluteMaxBytes  || '98 MB',
      preferredMaxBytes: ord.preferredMaxBytes || '512 KB',
    },
    organizations: (saved.organizations || []).map(org => ({
      id:              genId(),
      mspId:           org.id   || '',
      displayName:     org.name || '',
      type:            legacyType(org.type),
      enabled:         org.enabled !== false,
      endorses:        typeof org.endorses === 'boolean' ? org.endorses : legacyType(org.type) !== 'insurer',
      domain:          org.domain || '',
      caPort:          org.caPort          || 7054,
      peerPort:        org.peerPort        || 7051,
      chaincodePort:   org.chaincodePort   || 7052,
      operationsPort:  org.operationsPort  || 17051,
      caName:          org.caName          || '',
      caFolderName:    org.caFolderName    || '',
      roles: (org.roles || []).map(r => ({
        id:     genId(),
        name:   r.name   || '',
        attrs:  r.attrs  || '',
      })),
    })),
    chaincode: {
      name:              (saved.chaincode || {}).name              || 'safetycc',
      version:           (saved.chaincode || {}).version           || '1.3',
      eventTypes:        (saved.chaincode || {}).eventTypes        || ['SOS','ManDown','GasAlert','OverTemp','Geofence'],
    },
    dashboard: {
      backendPort: (saved.dashboard || {}).backendPort || 3001,
      frontendUrl: (saved.dashboard || {}).frontendUrl || '',
    },
  };
}



// ─── Primitive UI components ────────────────────────────────────────────────

function Field({ label, hint, required, children, className }) {
  return (
    <div className={`cn-field ${className || ''}`}>
      <label className="cn-label">
        {label}
        {required && <span className="cn-required">*</span>}
        {hint && <span className="cn-hint">— {hint}</span>}
      </label>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder, type = 'text', min, max }) {
  return (
    <input
      className="cn-input"
      type={type}
      value={value}
      placeholder={placeholder}
      min={min}
      max={max}
      onChange={e => {
        const v = type === 'number' ? Number(e.target.value) : e.target.value;
        onChange(v);
      }}
    />
  );
}

// ─── Tag Input (event types) ────────────────────────────────────────────────

function TagInput({ tags, onChange, placeholder }) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const val = draft.trim();
    if (val && !tags.includes(val)) onChange([...tags, val]);
    setDraft('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    if (e.key === 'Backspace' && !draft && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="cn-tag-input-wrapper" onClick={() => document.getElementById('cn-tag-inner')?.focus()}>
      {tags.map(t => (
        <span key={t} className="cn-tag">
          {t}
          <button className="cn-tag-remove" onClick={() => onChange(tags.filter(x => x !== t))}>×</button>
        </span>
      ))}
      <input
        id="cn-tag-inner"
        className="cn-tag-inner-input"
        value={draft}
        placeholder={tags.length === 0 ? placeholder : ''}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
    </div>
  );
}

// ─── Accordion section wrapper ──────────────────────────────────────────────

function Section({ id, icon, title, summary, badge, open, onToggle, children }) {
  return (
    <div className={`cn-section ${open ? 'cn-section--open' : ''}`}>
      <button className="cn-section-trigger" onClick={onToggle} aria-expanded={open}>
        <div className="cn-section-bar" />
        <div className="cn-section-head">
          <div className="cn-section-left">
            <span className="cn-section-icon">{icon}</span>
            <div className="cn-section-meta">
              <div className="cn-section-title">{title}</div>
              {!open && summary && (
                <div className="cn-section-summary">{summary}</div>
              )}
            </div>
          </div>
          <div className="cn-section-right">
            {badge && <span className="cn-section-badge">{badge}</span>}
            <span className="cn-section-chevron">▼</span>
          </div>
        </div>
      </button>
      {open && <div className="cn-section-body">{children}</div>}
    </div>
  );
}

// ─── Org Card ───────────────────────────────────────────────────────────────

function OrgCard({ org, index, total, onChange, onRemove, onMove }) {
  const [expanded, setExpanded] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const upd = (key, val) => onChange({ ...org, [key]: val });

  const orgType = ORG_TYPES.find(t => t.value === org.type) || ORG_TYPES[0];

  const addRole = () => {
    onChange({
      ...org,
      roles: [
        ...org.roles,
        { id: genId(), name: '', attrs: '' },
      ],
    });
  };

  const updateRole = (rid, field, val) => {
    onChange({
      ...org,
      roles: org.roles.map(r => r.id === rid ? { ...r, [field]: val } : r),
    });
  };

  const removeRole = (rid) => {
    onChange({ ...org, roles: org.roles.filter(r => r.id !== rid) });
  };

  return (
    <div className={`cn-org-card ${expanded ? 'cn-org-card--expanded' : ''}`}>
      <div className="cn-org-header" onClick={() => setExpanded(e => !e)}>
        <div className="cn-org-header-left">
          <span className="cn-org-type-dot" style={{ background: orgType.color }} />
          <span className="cn-org-name">{org.displayName || `Org ${index + 1}`}</span>
          <span className="cn-org-msp">{org.mspId || '—'}</span>
          {org.enabled === false && <span className="cn-org-msp" style={{ background: '#FEE2E2', color: '#991B1B' }}>not in network</span>}
          {org.enabled !== false && org.endorses && <span className="cn-org-msp" style={{ background: '#DCFCE7', color: '#166534' }}>endorses</span>}
        </div>
        <div className="cn-org-header-right">
          <button
            className="cn-org-move-btn"
            disabled={index === 0}
            onClick={e => { e.stopPropagation(); onMove(index, -1); }}
            title="Move up"
          >↑</button>
          <button
            className="cn-org-move-btn"
            disabled={index === total - 1}
            onClick={e => { e.stopPropagation(); onMove(index, 1); }}
            title="Move down"
          >↓</button>
          <button
            className="cn-org-remove-btn"
            disabled={total <= 1}
            onClick={e => { e.stopPropagation(); onRemove(); }}
            title="Remove org"
          >×</button>
          <button className="cn-org-expand-btn" aria-label={expanded ? 'Collapse' : 'Expand'}>▼</button>
        </div>
      </div>

      {expanded && (
        <div className="cn-org-body">
          {/* Type chips */}
          <div className="cn-org-type-row">
            {ORG_TYPES.map(t => (
              <button
                key={t.value}
                className={`cn-type-chip ${org.type === t.value ? 'cn-type-chip--selected' : ''}`}
                style={org.type === t.value ? { background: t.color, borderColor: t.color } : {}}
                onClick={() => onChange({ ...org, type: t.value, endorses: t.value !== 'insurer' })}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Membership and endorsement */}
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', margin: '6px 0 12px', fontSize: '13px' }}>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={org.enabled !== false} onChange={e => upd('enabled', e.target.checked)} />
              Include in the network{org.type === 'insurer' ? ' (insurer toggle)' : ''}
            </label>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' }}
                   title="Every transaction must be signed by this organisation's peer">
              <input type="checkbox" checked={!!org.endorses} disabled={org.enabled === false}
                     onChange={e => upd('endorses', e.target.checked)} />
              Must endorse every write
            </label>
          </div>

          {/* Primary fields */}
          <div className="cn-field-grid">
            <Field label="MSP ID" required>
              <Input value={org.mspId} onChange={v => upd('mspId', v)} placeholder="IINoTIndustryMSP" />
            </Field>
            <Field label="Display Name" required hint="shown in UI">
              <Input value={org.displayName} onChange={v => upd('displayName', v)} placeholder="Employer / Factory Owner" />
            </Field>
            <Field label="Domain" hint="leave blank to auto-derive">
              <Input value={org.domain} onChange={v => upd('domain', v)} placeholder="industry1.apfactory.com" />
            </Field>
            <Field label="Peer Port">
              <Input type="number" value={org.peerPort} onChange={v => upd('peerPort', v)} min={1024} max={65535} />
            </Field>
            <Field label="CA Port">
              <Input type="number" value={org.caPort} onChange={v => upd('caPort', v)} min={1024} max={65535} />
            </Field>
          </div>

          {/* Advanced fields */}
          <button
            className={`cn-advanced-toggle ${showAdvanced ? 'cn-advanced-toggle--open' : ''}`}
            onClick={() => setShowAdvanced(s => !s)}
          >
            <span className="cn-advanced-toggle-arrow">▶</span>
            Advanced (chaincode port, operations port, CA name)
          </button>

          {showAdvanced && (
            <div className="cn-field-grid" style={{ marginTop: '10px' }}>
              <Field label="Chaincode Port">
                <Input type="number" value={org.chaincodePort} onChange={v => upd('chaincodePort', v)} min={1024} max={65535} />
              </Field>
              <Field label="Operations Port">
                <Input type="number" value={org.operationsPort} onChange={v => upd('operationsPort', v)} min={1024} max={65535} />
              </Field>
              <Field label="CA Name" hint="e.g. ca.industry.apfactory.com">
                <Input value={org.caName} onChange={v => upd('caName', v)} placeholder="auto-derived" />
              </Field>
              <Field label="CA Folder">
                <Input value={org.caFolderName} onChange={v => upd('caFolderName', v)} placeholder="auto-derived" />
              </Field>
            </div>
          )}

          {/* Roles */}
          <div className="cn-roles-section">
            <div className="cn-roles-label">
              Identities &amp; Roles
              <span className="cn-hint" style={{ marginLeft: '6px' }}>— registered on this org's CA with a random secret at deploy</span>
            </div>
            {org.roles.length > 0 && (
              <div className="cn-role-list">
                {org.roles.map(role => (
                  <div key={role.id} className="cn-role-row">
                    <input
                      className="cn-input"
                      value={role.name}
                      placeholder="identity name, e.g. gateway1"
                      onChange={e => updateRole(role.id, 'name', e.target.value.toLowerCase())}
                    />
                    <select
                      className="cn-input cn-select"
                      value={roleOf(role.attrs)}
                      onChange={e => updateRole(role.id, 'attrs', `role.${e.target.value}:ecert`)}
                    >
                      <option value="" disabled>choose a role…</option>
                      {APP_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    <button className="cn-role-remove" onClick={() => removeRole(role.id)}>×</button>
                  </div>
                ))}
              </div>
            )}
            <button className="cn-add-role-btn" onClick={addRole}>+ Add Identity</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── JSON Modal ─────────────────────────────────────────────────────────────

function JsonModal({ json, onClose }) {
  return (
    <div className="cn-modal-overlay" onClick={onClose}>
      <div className="cn-modal" onClick={e => e.stopPropagation()}>
        <div className="cn-modal-header">
          <h3>Network Config JSON</h3>
          <button className="cn-modal-close" onClick={onClose}>×</button>
        </div>
        <pre className="cn-json-preview">{JSON.stringify(json, null, 2)}</pre>
        <div className="cn-modal-footer">
          <button
            className="cn-btn cn-btn-secondary"
            onClick={() => navigator.clipboard?.writeText(JSON.stringify(json, null, 2))}
          >Copy JSON</button>
          <button className="cn-btn cn-btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── Banner ──────────────────────────────────────────────────────────────────

function Banner({ status, onDismiss }) {
  if (!status) return null;
  return (
    <div className={`cn-banner cn-banner--${status.type}`}>
      <span>{status.message}</span>
      <button className="cn-banner-close" onClick={onDismiss}>×</button>
    </div>
  );
}

// ─── Step progress strip ────────────────────────────────────────────────────

const STEPS = [
  { label: '🌐 Network' },
  { label: '⚙️ Orderer' },
  { label: '🏢 Orgs' },
  { label: '⛓ Chaincode' },
  { label: '📊 Dashboard' },
];

// ─── Main component ──────────────────────────────────────────────────────────

export default function ConfigureNetworkPage({ onBack, onConfigChange, initialConfig }) {
  const [config, setConfig] = useState(() => {
    const restored = initialConfig ? denormalizeConfig(initialConfig) : null;
    return (restored && restored.networkName) ? restored : DEFAULT_CONFIG;
  });
  const [showJson, setShowJson] = useState(false);
  const [status, setStatus] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState(null);   // server validation: { ok, summary } | { ok:false, problems }

  // Which section is open: 0=Network, 1=Orderer, 2=Orgs, 3=Chaincode, 4=Dashboard
  const [openSection, setOpenSection] = useState(0);

  const toggleSection = (idx) => setOpenSection(o => o === idx ? -1 : idx);

  const updateOrderer   = (key, val) => setConfig(c => ({ ...c, orderer:    { ...c.orderer,    [key]: val } }));
  const updateChaincode = (key, val) => setConfig(c => ({ ...c, chaincode:  { ...c.chaincode,  [key]: val } }));
  const updateDashboard = (key, val) => setConfig(c => ({ ...c, dashboard:  { ...c.dashboard,  [key]: val } }));

  const updateOrg = useCallback((index, updated) => {
    setConfig(c => {
      const orgs = [...c.organizations];
      orgs[index] = updated;
      return { ...c, organizations: orgs };
    });
  }, []);

  const addOrg = () => {
    setConfig(c => ({
      ...c,
      organizations: [
        ...c.organizations,
        {
          id: genId(),
          mspId: '', displayName: '', type: 'regulator', enabled: true, endorses: false, domain: '',
          caPort:         8054 + c.organizations.length * 1000,
          peerPort:       9051 + c.organizations.length * 2000,
          chaincodePort:  9052 + c.organizations.length * 2000,
          operationsPort: 19051 + c.organizations.length * 2000,
          caName: '', caFolderName: '',
          roles: [],
        },
      ],
    }));
  };

  const removeOrg = (index) => {
    setConfig(c => ({ ...c, organizations: c.organizations.filter((_, i) => i !== index) }));
  };

  const moveOrg = (index, dir) => {
    setConfig(c => {
      const orgs = [...c.organizations];
      const target = index + dir;
      if (target < 0 || target >= orgs.length) return c;
      [orgs[index], orgs[target]] = [orgs[target], orgs[index]];
      return { ...c, organizations: orgs };
    });
  };

  // ── Build JSON ──────────────────────────────────────────────────────────
  const buildNetworkConfigJson = () => {
    const net = config;
    const ord = config.orderer;
    const ordererDomain = `${ord.hostname}.${net.domain}`;
    return {
      network: {
        name:              net.networkName,
        channel:           net.channelName,
        fabricVersion:     net.fabricVersion,
        fabricCAVersion:   net.fabricCAVersion,
        genesisProfile:    net.genesisProfile     || `${net.networkName.replace(/[^A-Za-z0-9]/g, '')}Genesis`,
        dockerNetworkName: net.dockerNetworkName  || net.channelName.replace(/[^a-z0-9]/g, '_'),
        bindAddress:       net.bindAddress        || '127.0.0.1',
      },
      orderer: {
        orgName:           ord.orgName,
        mspId:             ord.mspId || 'OrdererMSP',
        domain:            ordererDomain,
        port:              ord.port,
        adminPort:         ord.adminPort,
        caPort:            ord.caPort,
        caName:            ord.caName,
        caFolderName:      ord.caFolderName,
        batchTimeout:      ord.batchTimeout,
        maxMessageCount:   ord.maxMessageCount,
        absoluteMaxBytes:  ord.absoluteMaxBytes,
        preferredMaxBytes: ord.preferredMaxBytes,
        nodeCount:         ord.nodeCount,
        anchorName:        ord.anchorName,
      },
      organizations: config.organizations.map((org, i) => {
        const derivedDomain   = org.domain      || `${org.type}${i + 1}.${net.domain}`;
        const derivedCaName   = org.caName      || `ca.${derivedDomain}`;
        const derivedCaFolder = org.caFolderName || org.mspId.toLowerCase().replace('msp', '');
        return {
          id:              org.mspId,
          name:            org.displayName,
          type:            org.type,
          enabled:         org.enabled !== false,
          endorses:        !!org.endorses,
          domain:          derivedDomain,
          peerPort:        org.peerPort,
          chaincodePort:   org.chaincodePort,
          operationsPort:  org.operationsPort,
          caPort:          org.caPort,
          caName:          derivedCaName,
          caFolderName:    derivedCaFolder,
          roles:           org.roles.map(r => ({ name: r.name, attrs: r.attrs })),
        };
      }),
      chaincode: {
        name:              config.chaincode.name,
        version:           config.chaincode.version,
        sequence:          1,
        path:              'safety-chaincode',
        lang:              'node',
        accessRules:       {},
        eventTypes:        config.chaincode.eventTypes,
      },
      dashboard: {
        backendPort: config.dashboard.backendPort,
        frontendUrl: config.dashboard.frontendUrl || `http://${net.domain}:5173`,
      },
    };
  };

  // ── Validate ────────────────────────────────────────────────────────────
  const validate = () => {
    const errors = [];
    if (!config.networkName) errors.push('Network name is required');
    if (!config.channelName) errors.push('Channel name is required');
    if (!config.domain)      errors.push('Domain is required');
    config.organizations.forEach((org, i) => {
      if (!org.mspId)       errors.push(`Org ${i + 1}: MSP ID required`);
      if (!org.displayName) errors.push(`Org ${i + 1}: Display name required`);
      org.roles.forEach(r => { if (!r.name || !roleOf(r.attrs)) errors.push(`Org ${i + 1}: every identity needs a name and a role`); });
    });
    const active = config.organizations.filter(o => o.enabled !== false);
    if (!active.some(o => o.endorses)) errors.push('At least one organisation must endorse every write');
    const ports = active.flatMap(o => [o.caPort, o.peerPort, o.chaincodePort, o.operationsPort]);
    ports.push(config.orderer.port, config.orderer.caPort, config.orderer.adminPort);
    const dups = ports.filter((p, i) => ports.indexOf(p) !== i);
    if (dups.length) errors.push(`Port conflict: ${[...new Set(dups)].join(', ')}`);
    return errors;
  };

  // ── Validate & Save (server checks every rule the deploy will apply) ────
  const handleSave = async () => {
    const errors = validate();
    if (errors.length) { setStatus({ type: 'error', message: errors.join(' · ') }); return; }
    setSaving(true);
    setStatus({ type: 'loading', message: 'Validating on the server…' });
    try {
      const payload = buildNetworkConfigJson();
      const res = await fetch('/api/network-config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setCheck({ ok: false, problems: body.problems || [body.error || res.statusText] });
        setStatus({ type: 'error', message: 'The network config has problems — see the list below.' });
        return;
      }
      setCheck(body);
      if (onConfigChange) onConfigChange(payload);
      setStatus({ type: 'success', message: `Saved. Policy ${body.summary.endorsementPolicy}. Go to Deploy to build this network.` });
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setSaving(false);
    }
  };

  // ── Generate & Download ─────────────────────────────────────────────────
  const handleGenerate = async () => {
    const errors = validate();
    if (errors.length) { setStatus({ type: 'error', message: errors.join(' · ') }); return; }

    setGenerating(true);
    setStatus({ type: 'loading', message: 'Generating config files…' });
    try {
      const payload = buildNetworkConfigJson();
      if (onConfigChange) onConfigChange(payload);

      const res = await fetch('/api/generate-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.problems ? err.problems.join(' · ') : (err.error || 'Server error'));
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `${config.networkName.replace(/\s+/g, '-').toLowerCase()}-configs.zip`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
      setStatus({ type: 'success', message: 'configtx.yaml, docker-compose.yaml and network-config.json downloaded as a ZIP (no secrets included).' });
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setGenerating(false);
    }
  };

  // ── Section summaries (collapsed view) ─────────────────────────────────
  const netSummary  = [config.networkName, config.channelName, config.domain].filter(Boolean).join(' · ') || 'Not configured';
  const ordSummary  = `${config.orderer.hostname}.${config.domain || '…'} · port ${config.orderer.port} · ${config.orderer.batchTimeout}`;
  const orgSummary  = config.organizations.map(o => `${o.displayName || o.mspId || '—'}${o.enabled === false ? ' (off)' : ''}`).join(', ');
  const policy      = derivedPolicy(config.organizations);
  const insurer     = config.organizations.find(o => o.type === 'insurer');
  const ccSummary   = `${config.chaincode.name} v${config.chaincode.version} · ${config.chaincode.eventTypes.length} event types`;
  const dashSummary = `Backend :${config.dashboard.backendPort}`;

  return (
    <div className="cn-page">
      {onBack && (
        <button className="cn-back-btn" onClick={onBack}>← Back to Dashboard</button>
      )}

      <div className="cn-hero">
        <h1 className="cn-hero-title">Network Designer</h1>
        <p className="cn-hero-subtitle">
          Configure a Hyperledger Fabric network and generate deployment files without writing YAML.
        </p>
      </div>

      {/* Step strip — click to jump to section */}
      <div className="cn-steps">
        {STEPS.map((s, i) => (
          <button
            key={i}
            className={`cn-step ${openSection === i ? 'cn-step--active' : ''}`}
            onClick={() => toggleSection(i)}
          >
            <span className="cn-step-num">{i + 1}</span>
            <span className="cn-step-label">{s.label}</span>
          </button>
        ))}
      </div>

      <Banner status={status} onDismiss={() => setStatus(null)} />

      {/* ── Section 1: Network Identity ─────────────────────────────────── */}
      <Section
        id={0}
        icon="🌐"
        title="Network Identity"
        summary={netSummary}
        open={openSection === 0}
        onToggle={() => toggleSection(0)}
      >
        <div className="cn-field-grid">
          <Field label="Network Name" required hint="human-readable">
            <Input value={config.networkName} onChange={v => setConfig(c => ({ ...c, networkName: v }))} placeholder="AP Factory Safety Network" />
          </Field>
          <Field label="Channel Name" required hint="lowercase with hyphens">
            <Input value={config.channelName} onChange={v => setConfig(c => ({ ...c, channelName: v }))} placeholder="apfactory-safety-channel" />
          </Field>
          <Field label="Domain" required>
            <Input value={config.domain} onChange={v => setConfig(c => ({ ...c, domain: v }))} placeholder="apfactory.com" />
          </Field>
          <Field label="Fabric Version">
            <Input value={config.fabricVersion} onChange={v => setConfig(c => ({ ...c, fabricVersion: v }))} placeholder="2.5.15" />
          </Field>
          <Field label="Fabric CA Version">
            <Input value={config.fabricCAVersion} onChange={v => setConfig(c => ({ ...c, fabricCAVersion: v }))} placeholder="1.5.17" />
          </Field>
          <Field label="Docker Network" hint="auto-derived from channel name if blank">
            <Input value={config.dockerNetworkName} onChange={v => setConfig(c => ({ ...c, dockerNetworkName: v }))} placeholder="apfactory_network" />
          </Field>
          <Field label="Genesis Profile" hint="auto-derived if blank">
            <Input value={config.genesisProfile} onChange={v => setConfig(c => ({ ...c, genesisProfile: v }))} placeholder="APFactorySafetyGenesis" />
          </Field>
          <Field label="Bind Address" hint="127.0.0.1 = Fabric ports reachable only on this server">
            <Input value={config.bindAddress} onChange={v => setConfig(c => ({ ...c, bindAddress: v }))} placeholder="127.0.0.1" />
          </Field>
        </div>
      </Section>

      {/* ── Section 2: Orderer ──────────────────────────────────────────── */}
      <Section
        id={1}
        icon="⚙️"
        title="Orderer Configuration"
        summary={ordSummary}
        open={openSection === 1}
        onToggle={() => toggleSection(1)}
      >
        <div className="cn-field-grid">
          <Field label="Orderer Org Name">
            <Input value={config.orderer.orgName} onChange={v => updateOrderer('orgName', v)} placeholder="OrdererOrg" />
          </Field>
          <Field label="Orderer MSP ID">
            <Input value={config.orderer.mspId} onChange={v => updateOrderer('mspId', v)} placeholder="OrdererMSP" />
          </Field>
          <Field label="Hostname" hint="hostname.domain = orderer address">
            <Input value={config.orderer.hostname} onChange={v => updateOrderer('hostname', v)} placeholder="orderer" />
          </Field>
          <Field label="Orderer Port">
            <Input type="number" value={config.orderer.port} onChange={v => updateOrderer('port', v)} min={1024} max={65535} />
          </Field>
          <Field label="Admin Port">
            <Input type="number" value={config.orderer.adminPort} onChange={v => updateOrderer('adminPort', v)} min={1024} max={65535} />
          </Field>
          <Field label="CA Port">
            <Input type="number" value={config.orderer.caPort} onChange={v => updateOrderer('caPort', v)} min={1024} max={65535} />
          </Field>

        </div>

        <div className="cn-field-grid" style={{ marginTop: '12px' }}>
          <Field label="BatchTimeout" hint="500ms = low latency · 2s = high throughput">
            <Input value={config.orderer.batchTimeout} onChange={v => updateOrderer('batchTimeout', v)} placeholder="500ms" />
          </Field>
          <Field label="MaxMessageCount" hint="early block cut at this many txns">
            <Input type="number" value={config.orderer.maxMessageCount} onChange={v => updateOrderer('maxMessageCount', v)} min={1} max={500} />
          </Field>
          <Field label="AbsoluteMaxBytes">
            <Input value={config.orderer.absoluteMaxBytes} onChange={v => updateOrderer('absoluteMaxBytes', v)} placeholder="98 MB" />
          </Field>
          <Field label="PreferredMaxBytes">
            <Input value={config.orderer.preferredMaxBytes} onChange={v => updateOrderer('preferredMaxBytes', v)} placeholder="512 KB" />
          </Field>
        </div>

        <div className="cn-info" style={{ marginTop: '14px' }}>
          <strong>BatchTimeout guidance:</strong> At 500ms, commit latency averages ~560ms — 73% lower than the 2s default.
          MaxMessageCount only triggers early cuts at &gt;10 concurrent transactions; for lone worker deployments
          with 1–5 beacons, BatchTimeout is the only lever that matters.
        </div>
      </Section>

      {/* ── Section 3: Organizations ─────────────────────────────────────── */}
      <Section
        id={2}
        icon="🏢"
        title="Organisations"
        summary={orgSummary}
        badge={`${config.organizations.length} org${config.organizations.length !== 1 ? 's' : ''}`}
        open={openSection === 2}
        onToggle={() => toggleSection(2)}
      >
        <div className="cn-org-list">
          {config.organizations.map((org, i) => (
            <OrgCard
              key={org.id}
              org={org}
              index={i}
              total={config.organizations.length}
              onChange={updated => updateOrg(i, updated)}
              onRemove={() => removeOrg(i)}
              onMove={moveOrg}
            />
          ))}
        </div>
        <button className="cn-add-org-btn" onClick={addOrg}>+ Add Organisation</button>
        <div className="cn-info" style={{ marginTop: '12px' }}>
          <strong>Endorsement policy:</strong> <code>{policy}</code> — every organisation ticked
          “Must endorse every write” signs each transaction. Keep the regulator endorsing: with three
          organisations, a majority rule would let employer + insurer write without the regulator.
        </div>
      </Section>

      {/* ── Section 4: Chaincode ─────────────────────────────────────────── */}
      <Section
        id={3}
        icon="⛓"
        title="Safety Chaincode"
        summary={ccSummary}
        open={openSection === 3}
        onToggle={() => toggleSection(3)}
      >
        <div className="cn-field-grid">
          <Field label="Chaincode Name" hint="used in peer lifecycle commands">
            <Input value={config.chaincode.name} onChange={v => updateChaincode('name', v)} placeholder="safetyContract" />
          </Field>
          <Field label="Version">
            <Input value={config.chaincode.version} onChange={v => updateChaincode('version', v)} placeholder="1.0" />
          </Field>
          <Field label="Endorsement Policy" hint="derived from the organisations">
            <Input value={policy} onChange={() => {}} />
          </Field>
        </div>
        <div className="cn-field" style={{ marginTop: '14px' }}>
          <label className="cn-label">
            Event Types
            <span className="cn-hint">— press Enter to add; each becomes a Fabric event constant in safetyContract.js</span>
          </label>
          <TagInput
            tags={config.chaincode.eventTypes}
            onChange={v => updateChaincode('eventTypes', v)}
            placeholder="Add event type e.g. SOS…"
          />
        </div>
      </Section>

      {/* ── Section 5: Dashboard ─────────────────────────────────────────── */}
      <Section
        id={4}
        icon="📊"
        title="Dashboard"
        summary={dashSummary}
        open={openSection === 4}
        onToggle={() => toggleSection(4)}
      >
        <div className="cn-field-grid">
          <Field label="Backend Port" hint="Express.js API port (default 3001)">
            <Input type="number" value={config.dashboard.backendPort} onChange={v => updateDashboard('backendPort', v)} min={1024} max={65535} />
          </Field>
          <Field label="Frontend URL" hint="auto-derived from domain if blank">
            <Input value={config.dashboard.frontendUrl} onChange={v => updateDashboard('frontendUrl', v)} placeholder={`http://${config.domain || 'your.domain'}:5173`} />
          </Field>
        </div>
      </Section>

      {/* ── Sticky action bar ────────────────────────────────────────────── */}
      <div className="cn-action-bar">
        <div className="cn-action-stats">
          <div className="cn-stat">
            <span className="cn-stat-label">Orgs</span>
            <span className="cn-stat-value">{config.organizations.length}</span>
          </div>
          <div className="cn-stat">
            <span className="cn-stat-label">Channel</span>
            <span className="cn-stat-value">{config.channelName || '—'}</span>
          </div>
          <div className="cn-stat">
            <span className="cn-stat-label">Timeout</span>
            <span className="cn-stat-value">{config.orderer.batchTimeout}</span>
          </div>
          <div className="cn-stat">
            <span className="cn-stat-label">Policy</span>
            <span className="cn-stat-value" title={policy}>{config.organizations.filter(o => o.enabled !== false && o.endorses).length} must sign</span>
          </div>
          <div className="cn-stat">
            <span className="cn-stat-label">Insurer</span>
            <span className="cn-stat-value">{insurer ? (insurer.enabled === false ? 'off' : 'on') : '—'}</span>
          </div>
        </div>
        <div className="cn-action-btns">
          <button
            className="cn-btn cn-btn-secondary"
            onClick={() => {
              const errors = validate();
              if (errors.length) { setStatus({ type: 'error', message: errors.join(' · ') }); return; }
              setShowJson(true);
            }}
          >
            Preview JSON
          </button>
          <button
            className="cn-btn cn-btn-secondary"
            onClick={handleGenerate}
            disabled={generating}
          >
            {generating ? 'Generating…' : '⬇ Download files'}
          </button>
          <button
            className={`cn-btn cn-btn-accent ${saving ? 'disabled' : ''}`}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Validating…' : '✓ Validate & Save'}
          </button>
        </div>
      </div>

      {check && (
        <div className={`cn-info`} style={{ margin: '16px 0', borderLeft: `4px solid ${check.ok ? '#16a34a' : '#dc2626'}` }}>
          {check.ok ? (
            <>
              <strong>Saved and valid.</strong> {check.summary.network} · channel <code>{check.summary.channel}</code> ·
              {' '}{check.summary.chaincode} · BatchTimeout {check.summary.batchTimeout} · ports on {check.summary.bindAddress}
              <br />Endorsement policy <code>{check.summary.endorsementPolicy}</code>
              <ul style={{ margin: '6px 0 0 18px' }}>
                {check.summary.orgs.map(o => (
                  <li key={o.mspId}>{o.label} — {o.mspId} ({o.type}{o.endorses ? ', endorses' : ''}): {o.users.map(u => `${u.name} [${u.role}]`).join(', ') || 'no identities'}</li>
                ))}
              </ul>
              {check.summary.warnings.length > 0 && (
                <ul style={{ margin: '6px 0 0 18px', color: '#92400e' }}>{check.summary.warnings.map(w => <li key={w}>{w}</li>)}</ul>
              )}
            </>
          ) : (
            <>
              <strong>Fix these before deploying:</strong>
              <ul style={{ margin: '6px 0 0 18px', color: '#991b1b' }}>{check.problems.map(p => <li key={p}>{p}</li>)}</ul>
            </>
          )}
        </div>
      )}

      {showJson && (
        <JsonModal json={buildNetworkConfigJson()} onClose={() => setShowJson(false)} />
      )}
    </div>
  );
}

import { useState, useCallback } from 'react';
import './RulesDesignerPage.css';

// ─── Chaincode functions that have access rules ────────────────────────────
const CHAINCODE_FUNCTIONS = [
  {
    name: 'LogIncident',
    label: 'Log Incident',
    description: 'Record a new safety event from a device or gateway',
    icon: '📡',
  },
  {
    name: 'UpdateIncidentStatus',
    label: 'Update Incident Status',
    description: 'Acknowledge or resolve an existing incident',
    icon: '✅',
  },
  {
    name: 'GetIncident',
    label: 'Get Incident',
    description: 'Read details of a single incident record',
    icon: '🔍',
  },
  {
    name: 'GetAllIncidents',
    label: 'Get All Incidents',
    description: 'Query the full incident ledger',
    icon: '📋',
  },
  {
    name: 'GetIncidentHistory',
    label: 'Get Incident History',
    description: 'View the full audit trail for an incident',
    icon: '🕐',
  },
];

// Default event types with riskScore
const DEFAULT_EVENT_TYPES = [
  { id: genId(), name: 'SOS',      riskScore: 10, statutory: 'Factories Act §89' },
  { id: genId(), name: 'ManDown',  riskScore: 9,  statutory: 'Factories Act §89' },
  { id: genId(), name: 'GasAlert', riskScore: 8,  statutory: 'Factories Act §41B' },
  { id: genId(), name: 'OverTemp', riskScore: 6,  statutory: 'Factories Act §41B' },
  { id: genId(), name: 'Geofence', riskScore: 4,  statutory: '' },
];

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── Sub-components ────────────────────────────────────────────────────────

function SectionHeader({ icon, title, subtitle }) {
  return (
    <div className="rd-section-header">
      <div className="rd-section-icon">{icon}</div>
      <div>
        <h2 className="rd-section-title">{title}</h2>
        {subtitle && <p className="rd-section-subtitle">{subtitle}</p>}
      </div>
    </div>
  );
}

function StatusBanner({ status, onDismiss }) {
  if (!status) return null;
  const isError = status.type === 'error';
  return (
    <div className={`rd-banner rd-banner--${status.type}`}>
      <span>{isError ? '✗' : '✓'} {status.message}</span>
      <button className="rd-banner-close" onClick={onDismiss}>×</button>
    </div>
  );
}

// ─── Event Types Table ─────────────────────────────────────────────────────

function EventTypesTable({ eventTypes, onChange }) {
  const addRow = () => {
    onChange([...eventTypes, { id: genId(), name: '', riskScore: 5, statutory: '' }]);
  };

  const removeRow = (id) => {
    onChange(eventTypes.filter(e => e.id !== id));
  };

  const updateField = (id, field, value) => {
    onChange(eventTypes.map(e => e.id === id ? { ...e, [field]: value } : e));
  };

  const getRiskLabel = (score) => {
    if (score >= 9) return { label: 'Critical', cls: 'risk-critical' };
    if (score >= 7) return { label: 'High',     cls: 'risk-high' };
    if (score >= 4) return { label: 'Medium',   cls: 'risk-medium' };
    return              { label: 'Low',      cls: 'risk-low' };
  };

  return (
    <div className="rd-card">
      <SectionHeader
        icon="⚡"
        title="Event Types"
        subtitle="Define safety event categories, their risk scores, and applicable statutory references"
      />
      <table className="rd-table">
        <thead>
          <tr>
            <th>Event Name</th>
            <th>Risk Score <span className="rd-hint">(1–10)</span></th>
            <th>Severity</th>
            <th>Statutory Reference <span className="rd-hint">(optional)</span></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {eventTypes.map((evt) => {
            const risk = getRiskLabel(Number(evt.riskScore));
            return (
              <tr key={evt.id}>
                <td>
                  <input
                    className="rd-input"
                    value={evt.name}
                    placeholder="e.g. GasAlert"
                    onChange={e => updateField(evt.id, 'name', e.target.value)}
                  />
                </td>
                <td>
                  <div className="rd-risk-cell">
                    <input
                      className="rd-input rd-input--score"
                      type="number"
                      min="1"
                      max="10"
                      value={evt.riskScore}
                      onChange={e => updateField(evt.id, 'riskScore', Math.min(10, Math.max(1, Number(e.target.value))))}
                    />
                    <input
                      className="rd-slider"
                      type="range"
                      min="1"
                      max="10"
                      value={evt.riskScore}
                      onChange={e => updateField(evt.id, 'riskScore', Number(e.target.value))}
                    />
                  </div>
                </td>
                <td>
                  <span className={`rd-risk-badge ${risk.cls}`}>{risk.label}</span>
                </td>
                <td>
                  <input
                    className="rd-input"
                    value={evt.statutory}
                    placeholder="e.g. Factories Act §89"
                    onChange={e => updateField(evt.id, 'statutory', e.target.value)}
                  />
                </td>
                <td>
                  <button
                    className="rd-btn-remove"
                    onClick={() => removeRow(evt.id)}
                    title="Remove event type"
                    disabled={eventTypes.length <= 1}
                  >×</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="rd-btn-add" onClick={addRow}>+ Add Event Type</button>
    </div>
  );
}

// ─── Access Rules Matrix ───────────────────────────────────────────────────

function AccessRulesMatrix({ accessRules, organizations, onChange }) {
  // Build flat list of all roles across all orgs
  const allRoles = [];
  organizations.forEach(org => {
    (org.roles || []).forEach(role => {
      const attrValue = role.attrs ? role.attrs.split(':')[0] : `role.${role.name.toLowerCase().replace(/\s+/g, '')}`;
      allRoles.push({
        key: attrValue,
        label: role.name,
        orgName: org.displayName || org.mspId,
        orgType: org.type,
      });
    });
  });

  // Also add 'any' as a special option (MSP-level, any org member)
  const specialRoles = [
    { key: 'any', label: 'Any org member', orgName: 'All orgs', orgType: 'special' },
  ];
  const roleColumns = [...specialRoles, ...allRoles];

  const isChecked = (fnName, roleKey) => {
    return (accessRules[fnName] || []).includes(roleKey);
  };

  const toggleRole = (fnName, roleKey) => {
    const current = accessRules[fnName] || [];
    let updated;
    if (roleKey === 'any') {
      // Toggle 'any' clears all specific roles and vice versa
      updated = current.includes('any') ? [] : ['any'];
    } else {
      if (current.includes('any')) {
        // Switching from 'any' to specific roles
        updated = [roleKey];
      } else {
        updated = current.includes(roleKey)
          ? current.filter(r => r !== roleKey)
          : [...current, roleKey];
      }
    }
    onChange({ ...accessRules, [fnName]: updated });
  };

  const getOrgColor = (orgType) => {
    const colors = {
      industry:  '#3b82f6',
      regulator: '#8b5cf6',
      insurer:   '#10b981',
      custom:    '#f59e0b',
      special:   '#6b7280',
    };
    return colors[orgType] || '#6b7280';
  };

  if (allRoles.length === 0) {
    return (
      <div className="rd-card">
        <SectionHeader
          icon="🔐"
          title="Access Rules"
          subtitle="Define which roles can call each chaincode function"
        />
        <div className="rd-empty">
          No roles defined yet. Add organizations and roles in the Network Designer first.
        </div>
      </div>
    );
  }

  return (
    <div className="rd-card">
      <SectionHeader
        icon="🔐"
        title="Access Rules"
        subtitle="Check which roles are permitted to call each chaincode function. 'Any org member' grants MSP-level access without role attribute checks."
      />
      <div className="rd-matrix-wrapper">
        <table className="rd-matrix">
          <thead>
            <tr>
              <th className="rd-matrix-fn-header">Function</th>
              {roleColumns.map(role => (
                <th key={role.key} className="rd-matrix-role-header">
                  <div className="rd-role-header-inner">
                    <span
                      className="rd-role-org-dot"
                      style={{ background: getOrgColor(role.orgType) }}
                    />
                    <span className="rd-role-label">{role.label}</span>
                    <span className="rd-role-org">{role.orgName}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CHAINCODE_FUNCTIONS.map(fn => {
              const selected = accessRules[fn.name] || [];
              const hasAny = selected.includes('any');
              return (
                <tr key={fn.name} className={selected.length === 0 ? 'rd-row-unset' : ''}>
                  <td className="rd-matrix-fn-cell">
                    <div className="rd-fn-name">
                      <span className="rd-fn-icon">{fn.icon}</span>
                      <div>
                        <div className="rd-fn-label">{fn.label}</div>
                        <div className="rd-fn-desc">{fn.description}</div>
                      </div>
                    </div>
                    {selected.length === 0 && (
                      <span className="rd-warn-badge">⚠ No access set</span>
                    )}
                  </td>
                  {roleColumns.map(role => {
                    const checked = isChecked(fn.name, role.key);
                    const disabled = role.key !== 'any' && hasAny;
                    return (
                      <td
                        key={role.key}
                        className={`rd-matrix-cell ${checked ? 'rd-cell-checked' : ''} ${disabled ? 'rd-cell-disabled' : ''}`}
                      >
                        <input
                          type="checkbox"
                          className="rd-checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleRole(fn.name, role.key)}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="rd-matrix-legend">
        {['industry', 'regulator', 'insurer', 'custom', 'special'].map(type => {
          const hasOrg = type === 'special' || organizations.some(o => o.type === type);
          if (!hasOrg) return null;
          const labels = { industry: 'Industry', regulator: 'Regulator', insurer: 'Insurer', custom: 'Custom', special: 'Special' };
          return (
            <span key={type} className="rd-legend-item">
              <span className="rd-legend-dot" style={{ background: getOrgColor(type) }} />
              {labels[type]}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ─── JSON Preview Modal ────────────────────────────────────────────────────

function JsonModal({ json, onClose }) {
  return (
    <div className="rd-modal-overlay" onClick={onClose}>
      <div className="rd-modal" onClick={e => e.stopPropagation()}>
        <div className="rd-modal-header">
          <h3>Rules JSON Preview</h3>
          <button className="rd-modal-close" onClick={onClose}>×</button>
        </div>
        <pre className="rd-json-preview">{JSON.stringify(json, null, 2)}</pre>
        <div className="rd-modal-footer">
          <button
            className="rd-btn rd-btn-secondary"
            onClick={() => { navigator.clipboard?.writeText(JSON.stringify(json, null, 2)); }}
          >Copy JSON</button>
          <button className="rd-btn rd-btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── Default access rules ──────────────────────────────────────────────────
// Sensible defaults — user can override in the matrix
function buildDefaultAccessRules(organizations) {
  const allRoleAttrs = [];
  organizations.forEach(org => {
    (org.roles || []).forEach(role => {
      const attrValue = role.attrs ? role.attrs.split(':')[0] : `role.${role.name.toLowerCase().replace(/\s+/g, '')}`;
      allRoleAttrs.push(attrValue);
    });
  });

  // Gateway/IoT roles log; supervisors update; everyone reads
  return {
    LogIncident:          allRoleAttrs.filter(r => r.includes('employer') || r.includes('gateway') || r.includes('worker')).length > 0
                            ? allRoleAttrs.filter(r => r.includes('employer') || r.includes('gateway') || r.includes('worker'))
                            : ['any'],
    UpdateIncidentStatus: allRoleAttrs.filter(r => r.includes('supervisor') || r.includes('safetyofficer') || r.includes('inspector') || r.includes('hsemanager')).length > 0
                            ? allRoleAttrs.filter(r => r.includes('supervisor') || r.includes('safetyofficer') || r.includes('inspector') || r.includes('hsemanager'))
                            : ['any'],
    GetIncident:          ['any'],
    GetAllIncidents:      ['any'],
    GetIncidentHistory:   ['any'],
  };
}

// ─── Main component ────────────────────────────────────────────────────────

export default function RulesDesignerPage({ networkConfig, onBack, onSave }) {
  const [eventTypes, setEventTypes] = useState(
    (networkConfig?.chaincode?.eventTypes || []).length > 0 &&
    typeof networkConfig.chaincode.eventTypes[0] === 'object'
      ? networkConfig.chaincode.eventTypes.map(e => ({ ...e, id: genId() }))
      : DEFAULT_EVENT_TYPES
  );

  const [accessRules, setAccessRules] = useState(
    networkConfig?.chaincode?.accessRules && Object.keys(networkConfig.chaincode.accessRules).length > 0
      ? networkConfig.chaincode.accessRules
      : buildDefaultAccessRules(networkConfig?.organizations || [])
  );

  const [showJson, setShowJson] = useState(false);
  const [status, setStatus]     = useState(null);

  const organizations = networkConfig?.organizations || [];

  // Build the rules JSON to merge back into networkConfig
  const buildRulesJson = useCallback(() => ({
    eventTypes: eventTypes
      .filter(e => e.name.trim())
      .map(e => ({ name: e.name.trim(), riskScore: Number(e.riskScore), statutory: e.statutory || '' })),
    accessRules,
  }), [eventTypes, accessRules]);

  const handleSave = () => {
    const rules = buildRulesJson();

    // Validate: every event type must have a name
    const unnamed = rules.eventTypes.filter(e => !e.name);
    if (unnamed.length > 0) {
      setStatus({ type: 'error', message: 'All event types must have a name.' });
      return;
    }

    // Validate: every chaincode function should have at least one role
    const unset = CHAINCODE_FUNCTIONS.filter(fn => (accessRules[fn.name] || []).length === 0);
    if (unset.length > 0) {
      setStatus({ type: 'error', message: `No access rules set for: ${unset.map(f => f.label).join(', ')}` });
      return;
    }

    if (onSave) onSave(rules);
    setStatus({ type: 'success', message: 'Rules saved — ready to generate configs.' });
  };

  return (
    <div className="rd-page">
      {onBack && (
        <button className="rd-back-btn" onClick={onBack}>← Back to Dashboard</button>
      )}

      <div className="rd-hero">
        <h1 className="rd-hero-title">Rules Designer</h1>
        <p className="rd-hero-subtitle">
          Define safety event types and chaincode access control rules for your Fabric network.
        </p>
        <div className="rd-hero-actions">
          <button className="rd-btn rd-btn-secondary" onClick={() => setShowJson(true)}>
            Preview JSON
          </button>
          <button className="rd-btn rd-btn-primary" onClick={handleSave}>
            💾 Save Rules
          </button>
        </div>
      </div>

      <StatusBanner status={status} onDismiss={() => setStatus(null)} />

      {organizations.length === 0 && (
        <div className="rd-notice">
          ℹ No organizations found from Network Designer. Open Network Designer first, define your organizations and roles, then return here to set access rules.
        </div>
      )}

      <EventTypesTable eventTypes={eventTypes} onChange={setEventTypes} />

      <AccessRulesMatrix
        accessRules={accessRules}
        organizations={organizations}
        onChange={setAccessRules}
      />

      <div className="rd-bottom-actions">
        <button className="rd-btn rd-btn-secondary" onClick={() => setShowJson(true)}>
          Preview JSON
        </button>
        <button className="rd-btn rd-btn-primary" onClick={handleSave}>
          💾 Save Rules
        </button>
      </div>

      {showJson && (
        <JsonModal json={buildRulesJson()} onClose={() => setShowJson(false)} />
      )}
    </div>
  );
}

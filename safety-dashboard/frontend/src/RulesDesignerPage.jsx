import { useState, useEffect, useCallback } from 'react';
import './RulesDesignerPage.css';

// Rules Designer (TG-028). The rules are saved on the server (network-config.json "rules"), then
// "Apply to network" stores them on the channel with chaincode 1.4 SetRules (network.sh rules).
// The chaincode enforces them: access rules narrow the built-in roles of each function group,
// event types classify every new incident (severity, statutory reference, risk floor = score × 10),
// escalation levels time automatic escalation, targets and report types drive the compliance score
// and statutory filing.

const ROLE_LABEL = { gateway: 'Gateway', supervisor: 'Supervisor', auditor: 'Auditor', oracle: 'Oracle', 'claims-reviewer': 'Claims reviewer' };
const severity = s => (s >= 9 ? ['Critical', 'risk-critical'] : s >= 7 ? ['High', 'risk-high'] : s >= 4 ? ['Medium', 'risk-medium'] : ['Low', 'risk-low']);
const rowId = () => Math.random().toString(36).slice(2);
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const canon = r => JSON.stringify({ eventTypes: r.eventTypes,
  access: Object.fromEntries(Object.keys(r.access || {}).sort().map(k => [k, [...r.access[k]].sort()])),
  escalation: r.escalation || null, targets: r.targets || null, reportTypes: r.reportTypes || null });

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

function Banner({ status, onDismiss }) {
  if (!status) return null;
  return (
    <div className={`rd-banner rd-banner--${status.type}`}>
      <span style={{ whiteSpace: 'pre-line' }}>{status.type === 'error' ? '✗' : '✓'} {status.message}</span>
      <button className="rd-banner-close" onClick={onDismiss}>×</button>
    </div>
  );
}

// ─── Event types ───────────────────────────────────────────────────────────
function EventTypesTable({ rows, onChange }) {
  const update = (id, field, value) => onChange(rows.map(r => (r.id === id ? { ...r, [field]: value } : r)));
  return (
    <div className="rd-card">
      <SectionHeader icon="⚡" title="Event types"
        subtitle="The chaincode classifies every new incident by its event type: severity, statutory reference, and a risk floor of score × 10 (a lower score from the gateway is raised to it). An event type not listed here is still recorded, marked UNCLASSIFIED — a rule never drops a safety alarm." />
      <table className="rd-table">
        <thead>
          <tr><th>Event type <span className="rd-hint">(as the gateway sends it)</span></th><th>Risk score <span className="rd-hint">(1–10)</span></th>
              <th>Severity</th><th>Risk floor</th><th>Statutory reference <span className="rd-hint">(optional)</span></th><th></th></tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const [label, cls] = severity(Number(r.riskScore));
            return (
              <tr key={r.id}>
                <td><input className="rd-input" value={r.name} placeholder="e.g. GasAlert" onChange={e => update(r.id, 'name', e.target.value)} /></td>
                <td>
                  <div className="rd-risk-cell">
                    <input className="rd-input rd-input--score" type="number" min="1" max="10" value={r.riskScore}
                      onChange={e => update(r.id, 'riskScore', Math.min(10, Math.max(1, Math.round(Number(e.target.value) || 1))))} />
                    <input className="rd-slider" type="range" min="1" max="10" value={r.riskScore} onChange={e => update(r.id, 'riskScore', Number(e.target.value))} />
                  </div>
                </td>
                <td><span className={`rd-risk-badge ${cls}`}>{label}</span></td>
                <td>{Number(r.riskScore) * 10}</td>
                <td><input className="rd-input" value={r.statutory} placeholder="e.g. Factories Act 1948 s.88" onChange={e => update(r.id, 'statutory', e.target.value)} /></td>
                <td><button className="rd-btn-remove" title="Remove event type" onClick={() => onChange(rows.filter(x => x.id !== r.id))}>×</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="rd-btn-add" onClick={() => onChange([...rows, { id: rowId(), name: '', riskScore: 5, statutory: '' }])}>+ Add event type</button>
    </div>
  );
}

// ─── Escalation levels and response targets ───────────────────────────────
function EscalationCard({ levels, onLevels, targets, onTargets }) {
  const upd = (i, f, v) => onLevels(levels.map((l, j) => (j === i ? { ...l, [f]: v } : l)));
  const num = v => (v === '' ? '' : Math.max(0, Math.round(Number(v) || 0)));
  return (
    <div className="rd-card">
      <SectionHeader icon="⏱" title="Escalation and response targets"
        subtitle="Automatic escalation climbs one level at a time while an alert stays unacknowledged. The chaincode refuses an automatic escalation before its level's time, so the times on the ledger are provable; a supervisor can still escalate by hand. Who is notified at each level stays in the escalation service's settings (personal phone numbers are kept off the ledger). The compliance score is measured against the targets." />
      <table className="rd-table">
        <thead><tr><th>Level</th><th>After <span className="rd-hint">(minutes from the alert)</span></th><th>Only if risk ≥ <span className="rd-hint">(optional)</span></th><th></th></tr></thead>
        <tbody>
          {levels.map((l, i) => (
            <tr key={l.id}>
              <td>L{i + 1}</td>
              <td><input className="rd-input rd-input--score" style={{ width: 90 }} type="number" min="1" max="10080" value={l.afterMinutes} onChange={e => upd(i, 'afterMinutes', num(e.target.value))} />
                <span className="rd-hint"> {l.afterMinutes >= 60 ? `= ${Math.round(l.afterMinutes / 6) / 10} h` : ''}</span></td>
              <td><input className="rd-input rd-input--score" type="number" min="0" max="100" value={l.minRisk ?? ''} placeholder="any" onChange={e => upd(i, 'minRisk', num(e.target.value))} /></td>
              <td><button className="rd-btn-remove" title="Remove level" disabled={levels.length <= 1} onClick={() => onLevels(levels.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {levels.length < 5 && <button className="rd-btn-add" onClick={() => onLevels([...levels, { id: rowId(), afterMinutes: (Number(levels[levels.length - 1]?.afterMinutes) || 0) * 2 || 5, minRisk: '' }])}>+ Add level</button>}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 16 }}>
        <label>Acknowledge within <input className="rd-input rd-input--score" type="number" min="1" max="1440" value={targets.ackMinutes} onChange={e => onTargets({ ...targets, ackMinutes: num(e.target.value) })} /> min</label>
        <label>Resolve with outcome within <input className="rd-input rd-input--score" type="number" min="1" max="720" value={targets.resolveHours} onChange={e => onTargets({ ...targets, resolveHours: num(e.target.value) })} /> h</label>
      </div>
    </div>
  );
}

// ─── Statutory report types ────────────────────────────────────────────────
function ReportTypesCard({ rows, onChange }) {
  const upd = (id, f, v) => onChange(rows.map(r => (r.id === id ? { ...r, [f]: v } : r)));
  return (
    <div className="rd-card">
      <SectionHeader icon="📄" title="Statutory report types"
        subtitle="The reports a supervisor can file for an incident, with their deadlines. FORM18 is filled in the dashboard; any other type (for example another state's accident form) is filed by attaching the completed form as a PDF or photo. The ledger records its SHA-256 and filing time, and the compliance score checks each report against its own deadline." />
      <table className="rd-table">
        <thead><tr><th>Code</th><th>Name</th><th>Deadline <span className="rd-hint">(hours after the incident)</span></th><th></th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td><input className="rd-input" value={r.code} placeholder="e.g. ANNEX-1" onChange={e => upd(r.id, 'code', e.target.value.toUpperCase())} /></td>
              <td><input className="rd-input" value={r.name} placeholder="e.g. Annexure I (state accident report)" onChange={e => upd(r.id, 'name', e.target.value)} /></td>
              <td><input className="rd-input rd-input--score" type="number" min="1" max="720" value={r.deadlineHours} onChange={e => upd(r.id, 'deadlineHours', Math.max(1, Math.round(Number(e.target.value) || 1)))} /></td>
              <td><button className="rd-btn-remove" title="Remove report type" disabled={rows.length <= 1} onClick={() => onChange(rows.filter(x => x.id !== r.id))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length < 10 && <button className="rd-btn-add" onClick={() => onChange([...rows, { id: rowId(), code: '', name: '', deadlineHours: 24 }])}>+ Add report type</button>}
    </div>
  );
}

// ─── Access rules ──────────────────────────────────────────────────────────
// access[group] = list of allowed roles; a group left out keeps its built-in roles.
function AccessMatrix({ groups, roles, access, onChange }) {
  const allowed = g => access[g.id] || g.available;
  const toggle = (g, role) => {
    const cur = allowed(g);
    const next = cur.includes(role) ? cur.filter(r => r !== role) : [...cur, role];
    const copy = { ...access };
    if (sameSet(next, g.available)) delete copy[g.id]; else copy[g.id] = next;
    onChange(copy);
  };
  return (
    <div className="rd-card">
      <SectionHeader icon="🔐" title="Access rules"
        subtitle="Who may call each group of chaincode functions. A rule can only narrow the built-in permissions: greyed-out cells can never be allowed (for example, the insurer can never resolve an incident)." />
      <div className="rd-matrix-wrapper">
        <table className="rd-matrix">
          <thead>
            <tr>
              <th className="rd-matrix-fn-header">Function group</th>
              {roles.map(r => <th key={r} className="rd-matrix-role-header"><div className="rd-role-header-inner"><span className="rd-role-label">{ROLE_LABEL[r] || r}</span></div></th>)}
              <th className="rd-matrix-role-header"><div className="rd-role-header-inner"><span className="rd-role-label">Status</span></div></th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => {
              const a = allowed(g);
              const restricted = !!access[g.id];
              const empty = g.available.length > 0 && a.length === 0;
              return (
                <tr key={g.id} className={empty ? 'rd-row-unset' : ''}>
                  <td className="rd-matrix-fn-cell"><div className="rd-fn-label">{g.label}</div>
                    <div className="rd-fn-desc">at most: {g.builtin.map(r => ROLE_LABEL[r] || r).join(', ')}</div></td>
                  {roles.map(r => {
                    const possible = g.builtin.includes(r);
                    const checked = possible && a.includes(r);
                    return (
                      <td key={r} className={`rd-matrix-cell ${checked ? 'rd-cell-checked' : ''} ${possible ? '' : 'rd-cell-disabled'}`}>
                        <input type="checkbox" className="rd-checkbox" checked={checked} disabled={!possible} onChange={() => toggle(g, r)} />
                      </td>
                    );
                  })}
                  <td className="rd-matrix-cell">
                    {empty ? <span className="rd-warn-badge">⚠ nobody</span> : restricted ? <span className="rd-warn-badge">restricted</span> : <span className="rd-hint">built-in</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── On the ledger ─────────────────────────────────────────────────────────
function LedgerCard({ ledger, ledgerError, dirty, applying, onApply, log }) {
  const r = ledger?.rules;
  return (
    <div className="rd-card">
      <SectionHeader icon="⛓" title="On the ledger"
        subtitle="Apply stores the saved rules on the channel. It is signed by an endorsing organisation's admin and needs the same endorsements as any write; every version stays in the ledger history." />
      {ledgerError && <div className="rd-notice">{ledgerError}</div>}
      {!ledgerError && !r && <div className="rd-notice">No rules on the channel yet: the chaincode uses its built-in roles and does not classify incidents.</div>}
      {r && (
        <p style={{ margin: '0 0 12px' }}>
          <b>Version {r.version}</b> in force since {new Date(r.setAt).toLocaleString()} · set by {r.setByMsp} admin ·
          {' '}{r.eventTypes.length} event types · {Object.keys(r.access).length ? `restricted: ${Object.keys(r.access).join(', ')}` : 'no restrictions'} ·
          {' '}escalation {r.escalation ? r.escalation.levels.map(l => `${l.afterMinutes} min`).join(' / ') : 'built-in'} ·
          {' '}reports {r.reportTypes ? r.reportTypes.map(x => `${x.code} ${x.deadlineHours} h`).join(', ') : 'Form 18 12 h (built-in)'}
        </p>
      )}
      {dirty && <div className="rd-notice">The rules on this page differ from the rules in force. Save, then apply them.</div>}
      <button className="rd-btn rd-btn-primary" disabled={applying} onClick={onApply}>{applying ? 'Applying…' : '⛓ Apply saved rules to the network'}</button>
      {log.length > 0 && <pre className="rd-json-preview" style={{ marginTop: 12, maxHeight: 220, overflow: 'auto', textAlign: 'left' }}>{log.join('\n')}</pre>}
      {ledger?.history?.length > 0 && (
        <table className="rd-table" style={{ marginTop: 14 }}>
          <thead><tr><th>Version</th><th>Set at</th><th>By</th><th>Event types</th><th>Escalation (min)</th><th>Reports</th><th>Restricted groups</th><th>Transaction</th></tr></thead>
          <tbody>
            {ledger.history.map(h => (
              <tr key={h.txId}><td>v{h.version}</td><td>{new Date(h.setAt).toLocaleString()}</td><td>{h.setByMsp}</td><td>{h.eventTypes}</td><td>{h.escalation ? h.escalation.join(' / ') : '—'}</td><td>{h.reportTypes ? h.reportTypes.join(', ') : '—'}</td>
                <td>{h.restricted.join(', ') || '—'}</td><td style={{ fontFamily: 'monospace', fontSize: '0.8em' }}>{h.txId.slice(0, 16)}…</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function RulesDesignerPage({ onBack }) {
  const [meta, setMeta] = useState(null);            // groups, roles, network names
  const [rows, setRows] = useState([]);
  const [access, setAccess] = useState({});
  const [levels, setLevels] = useState([]);
  const [targets, setTargets] = useState({ ackMinutes: 5, resolveHours: 24 });
  const [reportRows, setReportRows] = useState([]);
  const [ledger, setLedger] = useState(null);
  const [ledgerError, setLedgerError] = useState('');
  const [status, setStatus] = useState(null);
  const [applying, setApplying] = useState(false);
  const [log, setLog] = useState([]);

  const loadLedger = useCallback(async () => {
    try {
      const j = await (await fetch('/api/rules/ledger')).json();
      if (j.ok) { setLedger(j); setLedgerError(''); } else { setLedger(null); setLedgerError(j.error); }
    } catch (e) { setLedgerError(e.message); }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const j = await (await fetch('/api/rules')).json();
        if (!j.ok) { setStatus({ type: 'error', message: (j.problems || [j.error]).join('\n') }); return; }
        setMeta(j);
        setRows(j.rules.eventTypes.map(e => ({ ...e, id: rowId() })));
        setAccess(j.rules.access || {});
        setLevels(j.rules.escalation.levels.map(l => ({ ...l, minRisk: l.minRisk ?? '', id: rowId() })));
        setTargets(j.rules.targets);
        setReportRows(j.rules.reportTypes.map(r => ({ ...r, id: rowId() })));
        if (j.migrated) setStatus({ type: 'success', message: 'Loaded the rules from the older Rules Designer format. Review and save them.' });
      } catch (e) { setStatus({ type: 'error', message: e.message }); }
    })();
    loadLedger();
  }, [loadLedger]);

  const body = () => ({
    eventTypes: rows.filter(r => r.name.trim()).map(r => ({ name: r.name.trim(), riskScore: Number(r.riskScore), statutory: r.statutory || '' })),
    access,
    escalation: { levels: levels.map((l, i) => ({ level: i + 1, afterMinutes: Number(l.afterMinutes), ...(l.minRisk === '' || l.minRisk === null || l.minRisk === undefined ? {} : { minRisk: Number(l.minRisk) }) })) },
    targets: { ackMinutes: Number(targets.ackMinutes), resolveHours: Number(targets.resolveHours) },
    reportTypes: reportRows.filter(r => r.code.trim() || r.name.trim()).map(r => ({ code: r.code.trim(), name: r.name.trim(), deadlineHours: Number(r.deadlineHours) })),
  });

  const save = async () => {
    const res = await fetch('/api/rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
    const j = await res.json();
    if (!j.ok) { setStatus({ type: 'error', message: (j.problems || [j.error]).join('\n') }); return false; }
    setStatus({ type: 'success', message: `Rules saved on the server${j.warnings.length ? `.\nWarnings:\n• ${j.warnings.join('\n• ')}` : '. Apply them to put them in force.'}` });
    return true;
  };

  const apply = async () => {
    if (!(await save())) return;
    setApplying(true); setLog([]);
    const res = await fetch('/api/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'rules' }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setApplying(false); setStatus({ type: 'error', message: j.error || (j.problems || []).join('\n') || 'Could not start' }); return; }
    const poll = setInterval(async () => {
      const s = await (await fetch('/api/deploy/status')).json().catch(() => null);
      if (!s) return;
      setLog(s.logLines.filter(l => !/^\[INFO\] Config loaded/.test(l)).slice(-14));
      if (!s.running) {
        clearInterval(poll); setApplying(false);
        setStatus(s.exitCode === 0 ? { type: 'success', message: 'Rules applied: the chaincode enforces them from the next transaction.' }
                                   : { type: 'error', message: 'Applying the rules failed — see the log below. The rules in force are unchanged.' });
        loadLedger();
      }
    }, 1500);
  };

  const inForce = ledger?.rules;
  const dirty = !!meta && (!inForce || canon(body()) !== canon(inForce));

  return (
    <div className="rd-page">
      {onBack && <button className="rd-back-btn" onClick={onBack}>← Back to Admin</button>}
      <div className="rd-hero">
        <h1 className="rd-hero-title">Rules Designer</h1>
        <p className="rd-hero-subtitle">
          {meta ? `${meta.network} · channel ${meta.channel} · ${meta.chaincode}` : 'Event types and access rules, enforced by the chaincode'}
        </p>
        <div className="rd-hero-actions">
          <button className="rd-btn rd-btn-secondary" disabled={!meta} onClick={() => {
            const d = meta.defaults;
            setRows(d.eventTypes.map(e => ({ ...e, id: rowId() }))); setAccess({});
            setLevels(d.escalation.levels.map(l => ({ ...l, minRisk: l.minRisk ?? '', id: rowId() }))); setTargets(d.targets);
            setReportRows(d.reportTypes.map(r => ({ ...r, id: rowId() })));
          }}>Reset to defaults</button>
          <button className="rd-btn rd-btn-primary" onClick={save} disabled={!meta}>💾 Save rules</button>
        </div>
      </div>
      <Banner status={status} onDismiss={() => setStatus(null)} />
      {meta && (
        <>
          <EventTypesTable rows={rows} onChange={setRows} />
          <EscalationCard levels={levels} onLevels={setLevels} targets={targets} onTargets={setTargets} />
          <ReportTypesCard rows={reportRows} onChange={setReportRows} />
          <AccessMatrix groups={meta.groups} roles={meta.roles} access={access} onChange={setAccess} />
          <LedgerCard ledger={ledger} ledgerError={ledgerError} dirty={dirty} applying={applying} onApply={apply} log={log} />
        </>
      )}
    </div>
  );
}

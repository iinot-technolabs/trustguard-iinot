import { useState, useEffect } from 'react'
import axios from 'axios'
import { useNetworkInfo } from './networkInfo'

// Form 18 — notice of accident or dangerous occurrence (Factories Act s.88, Rule 96) — TG-021
// Supervisor completes and records it; the auditor (regulator) opens filed versions read-only and
// sees whether each matches the SHA-256 recorded on the ledger.
const DEADLINE_H = 12
const fmt = ts => ts ? new Date(ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
const cn = id => (String(id || '').match(/CN=([^/:]+)/) || [])[1] || ''

// Reporting status of an incident, from its ledger record
export function reportStatus(inc, now = Date.now()) {
  const filed = (inc.statutoryReports || []).filter(r => r.reportType === 'FORM18')
  if (filed.length) {
    const first = filed[0]
    return { key: 'filed', tone: first.withinDeadline ? 'ok' : 'late',
             label: `Filed${filed.length > 1 ? ` v${filed.length}` : ''} · ${first.withinDeadline ? 'on time' : 'late'}` }
  }
  if (inc.reportability?.decision === 'NOT_REPORTABLE') return { key: 'nr', tone: 'muted', label: 'Not reportable', detail: inc.reportability.reason }
  const reportable = inc.reportability ? inc.reportability.decision === 'REPORTABLE' : inc.outcome === 'GENUINE'
  if (!reportable) return { key: 'none', tone: 'muted', label: '—' }
  const left = Date.parse(inc.timestamp) + DEADLINE_H * 3600000 - now
  if (left <= 0) return { key: 'overdue', tone: 'bad', label: 'Form 18 overdue' }
  const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000)
  return { key: 'due', tone: 'warn', label: `Form 18 due in ${h} h ${m} min` }
}
export const TONE = {
  ok:    { bg: '#EAF6F4', text: '#028090' },
  late:  { bg: '#FDEBD3', text: '#C05621' },
  warn:  { bg: '#FFF8E6', text: '#B7791F' },
  bad:   { bg: '#FBEAE8', text: '#C0392B' },
  muted: { bg: '#F1F5F9', text: '#64748B' },
}
export function StatusBadge({ inc, onClick }) {
  const s = reportStatus(inc), t = TONE[s.tone]
  if (s.key === 'none') return <span style={{ color: '#94A3B8' }}>—</span>
  return (
    <span onClick={onClick} title={s.detail || ''} style={{
      background: t.bg, color: t.text, borderRadius: '10px', padding: '2px 8px', fontSize: '11px', fontWeight: 600,
      cursor: onClick ? 'pointer' : 'default', whiteSpace: 'nowrap',
    }}>{s.label}</span>
  )
}

const input = { width: '100%', boxSizing: 'border-box', padding: '7px 9px', border: '1px solid #CBD5E1', borderRadius: '6px', fontSize: '13px', fontFamily: 'inherit' }
const LONG = new Set(['factoryAddress', 'department', 'injuredAddress', 'cause', 'activity', 'injuries', 'machine'])
const CHOICES = { sex: ['', 'Male', 'Female', 'Other'], fatal: ['No', 'Yes'], disabled48h: ['', 'Yes', 'No', 'Not yet known'], mechanicalPower: ['', 'Yes', 'No', 'Not applicable'] }

export default function Form18Modal({ incidentId, readOnly = false, onClose, onFiled }) {
  const [data, setData]       = useState(null)
  const [fields, setFields]   = useState({})
  const [saveDefaults, setSD] = useState(true)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState(null)
  const [view, setView]       = useState(null)     // filing shown as the printable document

  const load = async () => {
    try {
      const r = await axios.get(`/api/reports/form18/${encodeURIComponent(incidentId)}`)
      setData(r.data); setFields(r.data.prefill || {})
      if (readOnly && r.data.filings.length) setView(r.data.filings[r.data.filings.length - 1])
    } catch (e) { setError(e.response?.data?.error || e.message) }
  }
  useEffect(() => { load() }, [incidentId])

  async function record() {
    setBusy(true); setError(null)
    try {
      const r = await axios.post(`/api/reports/form18/${encodeURIComponent(incidentId)}`, { fields, saveFactoryDefaults: saveDefaults })
      await load(); onFiled && onFiled()
      setView({ version: r.data.version, reportHash: r.data.reportHash, reportedAt: r.data.reportedAt, withinDeadline: r.data.withinDeadline,
                verified: true, document: r.data.document, txId: r.data.txId })
    } catch (e) { setError(e.response?.data?.error || e.message) }
    finally { setBusy(false) }
  }

  const deadlineLeft = data ? Date.parse(data.deadline) - Date.now() : 0
  return (
    <div className="f18-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 50, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', overflowY: 'auto', padding: '24px 12px' }}>
      <style>{`@media print {
        @page { margin: 12mm; }
        body * { visibility: hidden !important; }
        #form18-doc, #form18-doc * { visibility: visible !important; }
        .f18-overlay { position: absolute !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: auto !important;
                       padding: 0 !important; background: none !important; overflow: visible !important; display: block !important; }
        .f18-box { max-width: none !important; box-shadow: none !important; border-radius: 0 !important; }
        #form18-doc { padding: 0 !important; }
        .no-print { display: none !important; }
      }`}</style>
      <div className="f18-box" style={{ background: '#FFFFFF', borderRadius: '12px', width: '100%', maxWidth: '860px', textAlign: 'left', boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
        <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid #E2E8F0' }}>
          <div>
            <div style={{ fontWeight: 700, color: '#014F54' }}>Form 18 · {incidentId}</div>
            {data && <div style={{ fontSize: '12px', color: deadlineLeft > 0 ? '#B7791F' : '#C0392B' }}>
              Statutory deadline (12 h from the incident): {fmt(data.deadline)}{deadlineLeft <= 0 ? ' — passed' : ''}
            </div>}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {view && !readOnly && <button onClick={() => setView(null)} style={btn('#FFFFFF', '#014F54', '#014F54')}>Edit / new version</button>}
            {view?.document && <button onClick={() => window.print()} style={btn('#014F54', '#FFFFFF')}>🖨 Print / save PDF</button>}
            <button onClick={onClose} style={btn('#FFFFFF', '#64748B', '#CBD5E1')}>Close</button>
          </div>
        </div>

        {error && <div className="no-print" style={{ margin: '12px 20px 0', background: '#FBEAE8', color: '#C0392B', borderRadius: '8px', padding: '8px 12px', fontSize: '13px' }}>{error}</div>}
        {!data && !error && <div style={{ padding: '24px', color: '#64748B' }}>Loading…</div>}

        {data && data.filings.length > 0 && (
          <div className="no-print" style={{ padding: '10px 20px 0', display: 'flex', flexWrap: 'wrap', gap: '6px', fontSize: '12px' }}>
            {data.filings.map(f => (
              <button key={f.version} onClick={() => setView(f)} style={{
                border: `1px solid ${view?.version === f.version ? '#014F54' : '#CBD5E1'}`, background: '#FFFFFF', borderRadius: '14px',
                padding: '3px 10px', cursor: 'pointer', fontSize: '12px', color: '#334155' }}>
                v{f.version} · {fmt(f.reportedAt)} · {f.withinDeadline ? 'on time' : 'late'} · {f.verified ? '✓ matches ledger' : '✗ does not match ledger'}
              </button>
            ))}
          </div>
        )}

        {data && view && <Form18Document data={data} filing={view} />}

        {data && !view && readOnly && <div style={{ padding: '20px', color: '#64748B', fontSize: '13px' }}>No Form 18 has been recorded for this incident.</div>}

        {data && !view && !readOnly && (
          <div className="no-print" style={{ padding: '16px 20px 20px' }}>
            <p style={{ fontSize: '12px', color: '#64748B', margin: '0 0 12px', lineHeight: 1.5 }}>
              The personal particulars stay in this server's report store (they can be corrected or erased). The ledger records only a
              fingerprint (SHA-256) of the completed form and the time you record it, so anyone can later prove what was filed and when.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px 14px' }}>
              {data.fields.map(f => (
                <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: '#475569', fontWeight: 600,
                                            gridColumn: LONG.has(f.key) ? '1 / -1' : 'auto' }}>
                  <span>{f.label}{f.required && <span style={{ color: '#C0392B' }}> *</span>}</span>
                  {CHOICES[f.key] ? (
                    <select style={input} value={fields[f.key] || ''} onChange={e => setFields({ ...fields, [f.key]: e.target.value })}>
                      {CHOICES[f.key].map(o => <option key={o} value={o}>{o || 'Select…'}</option>)}
                    </select>
                  ) : LONG.has(f.key) ? (
                    <textarea rows={2} style={{ ...input, resize: 'vertical' }} value={fields[f.key] || ''} maxLength={500}
                      onChange={e => setFields({ ...fields, [f.key]: e.target.value })} />
                  ) : (
                    <input style={input} value={fields[f.key] || ''} maxLength={500} onChange={e => setFields({ ...fields, [f.key]: e.target.value })} />
                  )}
                </label>
              ))}
            </div>
            <label style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', color: '#475569', margin: '14px 0' }}>
              <input type="checkbox" checked={saveDefaults} onChange={e => setSD(e.target.checked)} />
              Remember the factory details and signatory for the next Form 18
            </label>
            <button onClick={record} disabled={busy} style={{ ...btn(busy ? '#CBD5E1' : '#028090', '#FFFFFF'), padding: '10px 18px', fontSize: '14px' }}>
              {busy ? 'Recording on the ledger…' : data.filings.length ? `Record corrected version v${data.filings.length + 1}` : 'Record on ledger and prepare for dispatch'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function btn(bg, color, border) {
  return { background: bg, color, border: `1px solid ${border || bg}`, borderRadius: '6px', padding: '6px 12px', fontSize: '13px', cursor: 'pointer', fontWeight: 600 }
}

// Printable layout following the numbered items of Form 18 (Rule 96)
function Form18Document({ data, filing }) {
  const net = useNetworkInfo()
  if (!filing.document) return (
    <div style={{ margin: '16px 20px 20px', border: '1px solid #F5C6C0', background: '#FBEAE8', color: '#7F1D1D', borderRadius: '8px', padding: '12px 14px', fontSize: '13px', lineHeight: 1.6 }}>
      <strong>Particulars not available for version {filing.version}.</strong> The ledger records a Form 18 fingerprint for this incident,
      but no stored report on this server has that fingerprint (it was erased, or recorded outside this dashboard).
      <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11px', marginTop: '6px', wordBreak: 'break-all' }}>
        Ledger fingerprint: {filing.reportHash}<br />Recorded {fmt(filing.reportedAt)}{filing.reportedBy ? ` by ${cn(filing.reportedBy)}` : ''} — {filing.withinDeadline ? 'within' : 'after'} the 12-hour limit
      </div>
    </div>
  )
  const p = filing.document.particulars || {}
  const inc = filing.document?.incident || data.incident
  const rows = [
    ['1', 'Name of factory', p.factoryName + (p.licenceNo ? ` (Licence/Reg. No. ${p.licenceNo})` : '')],
    ['2', 'Address of works where the accident or dangerous occurrence happened', p.factoryAddress],
    ['3', 'Nature of industry', p.natureOfIndustry],
    ['4', 'Branch or department and exact place where it happened', p.department],
    ['5', "Injured person's name and address", [p.injuredName, p.injuredAddress].filter(Boolean).join(', ') + (p.esiNumber ? ` · ESI No. ${p.esiNumber}` : '')],
    ['6', '(a) Sex  (b) Age (last birthday)  (c) Occupation', `(a) ${p.sex || '—'}   (b) ${p.age || '—'}   (c) ${p.occupation || '—'}`],
    ['7', 'Date and hour of accident or dangerous occurrence', p.accidentDateTime + (p.shift ? ` · shift ${p.shift}` : '')],
    ['8', 'Hour at which the injured person started work that day', p.workStartTime || '—'],
    ['9', '(a) Cause or nature  (b) Machine and part, and whether moved by mechanical power  (c) What the injured person was doing',
          `(a) ${p.cause}\n(b) ${p.machine || 'Not caused by machinery'}${p.mechanicalPower ? ` — mechanical power: ${p.mechanicalPower}` : ''}\n(c) ${p.activity}`],
    ['10', 'Nature and extent of injuries', p.injuries + (p.fatal === 'Yes' ? ' — FATAL' : '')],
    ['11', 'If not fatal: disabled for 48 hours or more?', p.fatal === 'Yes' ? 'Not applicable (fatal)' : (p.disabled48h || '—')],
    ['12', 'Medical officer attending the injured person', p.medicalOfficer || '—'],
  ]
  const td = { border: '1px solid #94A3B8', padding: '7px 9px', verticalAlign: 'top', fontSize: '12.5px', whiteSpace: 'pre-wrap' }
  return (
    <div id="form18-doc" style={{ padding: '24px 28px', color: '#0F172A', fontFamily: 'Georgia, "Times New Roman", serif' }}>
      <div style={{ textAlign: 'center', marginBottom: '14px' }}>
        <div style={{ fontWeight: 700, fontSize: '16px' }}>FORM No. 18</div>
        <div style={{ fontSize: '12px' }}>(Prescribed under Rule 96 · Section 88, Factories Act 1948)</div>
        <div style={{ fontWeight: 700, fontSize: '13.5px', marginTop: '6px' }}>NOTICE OF ACCIDENT OR DANGEROUS OCCURRENCE RESULTING IN DEATH OR BODILY INJURY</div>
        <div style={{ fontSize: '12px', fontStyle: 'italic' }}>(To be sent forthwith to the Inspector of Factories)</div>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>{rows.map(([n, q, a]) => (
          <tr key={n}><td style={{ ...td, width: '28px', textAlign: 'center' }}>{n}</td><td style={{ ...td, width: '42%' }}>{q}</td><td style={td}>{a || '—'}</td></tr>
        ))}</tbody>
      </table>
      <p style={{ fontSize: '12.5px', margin: '16px 0 28px' }}>I certify that to the best of my knowledge and belief the above particulars are correct in every respect.</p>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12.5px' }}>
        <div>Date of dispatch of report: ____________</div>
        <div style={{ textAlign: 'right' }}>________________________________<br />{p.signatory}{p.designation ? `, ${p.designation}` : ''}<br />Occupier or Manager</div>
      </div>
      <div style={{ marginTop: '22px', borderTop: '1px dashed #94A3B8', paddingTop: '10px', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '10.5px', color: '#334155', lineHeight: 1.6 }}>
        <strong>Electronic record — TrustGuard IIoT (Hyperledger Fabric, channel {net?.channel || '…'})</strong><br />
        Incident {inc.incidentId} · {inc.eventType} · beacon {inc.deviceId} · logged {fmt(inc.timestamp)}<br />
        Raw event SHA-256: {inc.eventHash}<br />
        This report, version {filing.version}: SHA-256 {filing.reportHash}<br />
        Recorded on the ledger {fmt(filing.reportedAt)}{filing.reportedBy ? ` by ${cn(filing.reportedBy)}` : ''} — {filing.withinDeadline ? 'within' : 'AFTER'} the 12-hour limit
        {filing.txId ? <><br />Transaction {filing.txId}</> : null}
        <br />{filing.verified ? '✓ The particulars above match the fingerprint recorded on the ledger.' : '✗ WARNING: these particulars do NOT match the fingerprint on the ledger.'}
      </div>
    </div>
  )
}

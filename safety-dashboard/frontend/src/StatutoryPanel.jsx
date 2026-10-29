import { useState } from 'react'
import axios from 'axios'
import Form18Modal, { reportStatus, TONE } from './Form18'

// Supervisor side panel: Form 18 decision + filing for the selected incident (TG-021)
export default function StatutoryPanel({ incident, onChanged }) {
  const [form, setForm]     = useState(false)
  const [nr, setNr]         = useState(false)       // "not reportable" reason box open
  const [reason, setReason] = useState('')
  const [busy, setBusy]     = useState(false)
  const [error, setError]   = useState(null)
  const s = reportStatus(incident), t = TONE[s.tone]
  const filed = (incident.statutoryReports || []).some(r => r.reportType === 'FORM18')

  async function decide(decision) {
    setBusy(true); setError(null)
    try {
      await axios.post(`/api/reports/${encodeURIComponent(incident.incidentId)}/reportability`, { decision, reason })
      setNr(false); setReason(''); onChanged && (await onChanged())
    } catch (e) { setError(e.response?.data?.error || e.message) }
    finally { setBusy(false) }
  }

  return (
    <div style={{ marginTop: '14px', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '10px', textAlign: 'left' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>Statutory report (Form 18)</span>
        {s.key !== 'none' && <span style={{ background: t.bg, color: t.text, borderRadius: '10px', padding: '2px 8px', fontSize: '11px', fontWeight: 600 }}>{s.label}</span>}
      </div>
      <div style={{ fontSize: '11px', color: '#64748B', lineHeight: 1.5, marginBottom: '8px' }}>
        {s.key === 'nr' ? <>Not reportable: {incident.reportability.reason}</>
          : filed ? 'Filed and fingerprinted on the ledger. You can open, print or correct it.'
          : 'Needed when someone died or was injured, or for a dangerous occurrence. Due within 12 h of the incident.'}
      </div>
      {error && <div style={{ color: '#C0392B', fontSize: '12px', marginBottom: '6px' }}>{error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <button onClick={() => setForm(true)} style={{ background: '#014F54', color: '#FFFFFF', border: 'none', borderRadius: '8px', padding: '8px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
          {filed ? '📄 Open Form 18' : '📝 Prepare Form 18'}
        </button>
        {!filed && s.key !== 'nr' && !nr && (
          <button onClick={() => setNr(true)} style={{ background: '#FFFFFF', color: '#475569', border: '1px solid #CBD5E1', borderRadius: '8px', padding: '7px', fontSize: '12px', cursor: 'pointer' }}>
            Not reportable…
          </button>
        )}
        {!filed && s.key === 'nr' && (
          <button onClick={() => decide('REPORTABLE')} disabled={busy} style={{ background: '#FFFFFF', color: '#475569', border: '1px solid #CBD5E1', borderRadius: '8px', padding: '7px', fontSize: '12px', cursor: 'pointer' }}>
            Mark reportable again
          </button>
        )}
        {nr && (
          <div>
            <textarea value={reason} onChange={e => setReason(e.target.value.slice(0, 300))} rows={2}
              placeholder="Why no Form 18 is needed (e.g. false alarm, no injury) — the regulator sees this"
              style={{ width: '100%', boxSizing: 'border-box', padding: '7px', borderRadius: '6px', border: '1px solid #CBD5E1', fontSize: '12px', resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
              <button onClick={() => decide('NOT_REPORTABLE')} disabled={busy || !reason.trim()} style={{ flex: 1, background: reason.trim() ? '#475569' : '#CBD5E1', color: '#FFFFFF', border: 'none', borderRadius: '6px', padding: '7px', fontSize: '12px', cursor: 'pointer' }}>
                {busy ? 'Recording…' : 'Record on ledger'}
              </button>
              <button onClick={() => { setNr(false); setReason('') }} style={{ background: 'none', border: '1px solid #CBD5E1', borderRadius: '6px', padding: '7px 10px', fontSize: '12px', cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      {form && <Form18Modal incidentId={incident.incidentId} onClose={() => setForm(false)} onFiled={onChanged} />}
    </div>
  )
}

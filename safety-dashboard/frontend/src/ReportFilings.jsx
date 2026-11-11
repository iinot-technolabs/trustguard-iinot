import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

// Statutory reports of one incident, of every type in the network rules (chaincode 1.4, TG-028):
// Form 18 is filled in the dashboard (Form18.jsx); another type — a state's own accident form — is filed
// by attaching the completed form (PDF or photo). Only its SHA-256 and the filing time go on the ledger;
// the file stays on this server, and anyone can check it against the ledger hash.
const fmt = ts => ts ? new Date(ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
const small = { fontSize: '11px', color: '#64748B' }
const btn = (bg, fg = '#FFFFFF', border = 'none') => ({ background: bg, color: fg, border, borderRadius: '6px', padding: '6px 10px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' })

async function download(f) {
  const r = await fetch(`/api/reports/file/${f.hash}`)
  if (!r.ok) { alert((await r.json().catch(() => ({}))).error || 'Download failed'); return }
  const url = URL.createObjectURL(await r.blob())
  const a = document.createElement('a'); a.href = url; a.download = f.name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export default function ReportFilings({ incidentId, canFile = false, onChanged, onOpenForm18 }) {
  const [data, setData]   = useState(null)
  const [type, setType]   = useState('')
  const [file, setFile]   = useState(null)
  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone]   = useState(null)
  const [inputKey, setInputKey] = useState(0)   // remounts the file input after a filing

  const load = useCallback(async () => {
    try {
      const r = await axios.get(`/api/reports/${encodeURIComponent(incidentId)}/filings`)
      setData(r.data)
      const others = r.data.reportTypes.filter(t => t.code !== 'FORM18')
      setType(t => t || (others[0] ? others[0].code : ''))
    } catch (e) { setError(e.response?.data?.error || e.message) }
  }, [incidentId])
  useEffect(() => { load() }, [load])

  async function submit() {
    if (!file || !type) return
    setBusy(true); setError(null); setDone(null)
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('The file is larger than 8 MB')
      const dataBase64 = await new Promise((ok, fail) => {
        const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = fail; fr.readAsDataURL(file)
      })
      const r = await axios.post(`/api/reports/${encodeURIComponent(incidentId)}/file`, { reportType: type, fileName: file.name, dataBase64 })
      setDone(`${type} v${r.data.version} recorded on the ledger · ${r.data.withinDeadline ? 'on time' : 'late'} · SHA-256 ${r.data.reportHash.slice(0, 12)}…`)
      setFile(null); setInputKey(k => k + 1); await load(); if (onChanged) await onChanged()
    } catch (e) { setError(e.response?.data?.error || e.message) }
    finally { setBusy(false) }
  }

  if (!data) return error ? <div style={{ color: '#C0392B', fontSize: '12px' }}>{error}</div> : <div style={small}>Loading reports…</div>
  const others = data.reportTypes.filter(t => t.code !== 'FORM18')
  return (
    <div style={{ textAlign: 'left' }}>
      <div style={{ ...small, marginBottom: '6px' }}>
        Report types in force: {data.reportTypes.map(t => `${t.code} (${t.deadlineHours} h)`).join(' · ')}
      </div>
      {data.filings.map(f => (
        <div key={`${f.reportType}-${f.version}`} style={{ borderTop: '1px solid #E2E8F0', padding: '6px 0', fontSize: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
            <span><b>{f.reportType}</b> v{f.version} · {f.withinDeadline ? 'on time' : 'late'}</span>
            <span style={small}>{fmt(f.reportedAt)}</span>
          </div>
          <div style={small}>{f.name}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
            <span style={{ color: f.verified ? '#028090' : '#C0392B' }} title={`SHA-256 ${f.reportHash}`}>{f.verified ? '✓ matches ledger' : '✗ no matching copy'}</span>
            {f.file && <button title={f.file.name} style={{ ...btn('#FFFFFF', '#014F54', '1px solid #CBD5E1'), maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                               onClick={() => download(f.file)}>⬇ {f.file.name}</button>}
            {f.structured && onOpenForm18 && <button style={btn('#FFFFFF', '#014F54', '1px solid #CBD5E1')} onClick={onOpenForm18}>Open Form 18</button>}
          </div>
        </div>
      ))}
      {data.filings.length > 0 && <div style={{ borderTop: '1px solid #E2E8F0', marginBottom: '8px' }} />}
      {canFile && others.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px dashed #CBD5E1', paddingTop: '8px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>Attach a filed form of another type</div>
          <select value={type} onChange={e => setType(e.target.value)} style={{ padding: '6px', borderRadius: '6px', border: '1px solid #CBD5E1', fontSize: '12px' }}>
            {others.map(t => <option key={t.code} value={t.code}>{t.code} — {t.name} (due {t.deadlineHours} h)</option>)}
          </select>
          <input key={inputKey} type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={e => setFile(e.target.files[0] || null)} style={{ fontSize: '12px' }} />
          <button disabled={!file || busy} onClick={submit} style={btn(file ? '#014F54' : '#CBD5E1')}>{busy ? 'Recording…' : 'Record on the ledger'}</button>
          <div style={small}>The file stays on this server; the ledger records its SHA-256 and the filing time.</div>
        </div>
      )}
      {done && <div style={{ color: '#028090', fontSize: '12px', marginTop: '6px' }}>✓ {done}</div>}
      {error && <div style={{ color: '#C0392B', fontSize: '12px', marginTop: '6px' }}>{error}</div>}
    </div>
  )
}

// Read-only view for the auditor (regulator): every filed report of the incident
export function ReportsModal({ incident, onClose, onOpenForm18 }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#FFFFFF', borderRadius: '10px', padding: '18px', width: 'min(640px, 92vw)', maxHeight: '80vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <strong style={{ color: '#014F54' }}>Statutory reports · {incident.incidentId}</strong>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer' }}>×</button>
        </div>
        <ReportFilings incidentId={incident.incidentId} onOpenForm18={onOpenForm18} />
      </div>
    </div>
  )
}

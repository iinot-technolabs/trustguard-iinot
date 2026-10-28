import { useState } from 'react'
import axios from 'axios'
import { riskDrivers } from './SupervisorView'
import { useNetworkInfo, orgLabel } from './networkInfo'

// Insurer (claims-reviewer role) — read-only claim evidence (chaincode 1.2, TG-018).
// The insurer cannot list every incident: it looks up one worker (incidents only while that worker
// wore the beacon) or one beacon, for a claim period, and sees each incident's ledger history.
const STATUS = {
  TRIGGERED:    { bg: '#FBEAE8', text: '#C0392B' },
  ESCALATED:    { bg: '#F3E8FF', text: '#7E22CE' },
  ACKNOWLEDGED: { bg: '#FFF8E6', text: '#B7791F' },
  RESOLVED:     { bg: '#EAF6F4', text: '#028090' },
}
const OUTCOME = { GENUINE: 'Genuine', NEAR_MISS: 'Near miss', FALSE_ALARM: 'False alarm' }
const fmt = ts => ts ? new Date(ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : ''
const cn = id => (String(id || '').match(/CN=([^/:]+)/) || [])[1] || ''
// date input (local day) → ISO bounds: from = start of day, to = start of the next day
const dayStart = d => d ? new Date(`${d}T00:00:00`).toISOString() : ''
const dayAfter = d => { if (!d) return ''; const t = new Date(`${d}T00:00:00`); t.setDate(t.getDate() + 1); return t.toISOString() }

const input = { padding: '8px 10px', border: '1px solid #CBD5E1', borderRadius: '6px', fontSize: '13px', color: '#0F172A', background: '#FFFFFF' }
const label = { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: '#475569', fontWeight: 600 }
const th = { padding: '8px', fontWeight: 600, textAlign: 'left', color: '#475569' }
const td = { padding: '8px', verticalAlign: 'top' }

export default function InsurerView({ session }) {
  const net = useNetworkInfo()
  const [mode, setMode]       = useState('worker')
  const [code, setCode]       = useState('')
  const [from, setFrom]       = useState('')
  const [to, setTo]           = useState('')
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState(null)
  const [busy, setBusy]       = useState(false)
  const [history, setHistory] = useState({})   // incidentId → entries | 'loading'

  async function search(e) {
    e.preventDefault(); setBusy(true); setError(null); setResult(null); setHistory({})
    try {
      const q = `from=${encodeURIComponent(dayStart(from))}&to=${encodeURIComponent(dayAfter(to))}`
      const url = mode === 'worker'
        ? `/api/workers/${encodeURIComponent(code.trim())}/incidents?${q}`
        : `/api/workers/device/${encodeURIComponent(code.trim())}/incidents?${q}`
      const r = await axios.get(url)
      setResult({ mode, code: code.trim(), from, to, assignments: r.data.assignments || null, incidents: r.data.incidents || [], at: new Date() })
    } catch (e) { setError(e.response?.data?.error || e.message) }
    finally { setBusy(false) }
  }

  async function toggleHistory(id) {
    if (history[id]) { setHistory(h => { const n = { ...h }; delete n[id]; return n }); return }
    setHistory(h => ({ ...h, [id]: 'loading' }))
    try {
      const r = await axios.get(`/api/incidents/${encodeURIComponent(id)}/history`)
      setHistory(h => ({ ...h, [id]: r.data.history || [] }))
    } catch (e) { setHistory(h => ({ ...h, [id]: [{ error: e.response?.data?.error || e.message }] })) }
  }

  const inc = result?.incidents || []
  const count = k => inc.filter(i => i.outcome === k).length
  const open = inc.filter(i => i.status !== 'RESOLVED').length

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto', textAlign: 'left' }}>
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #claim-evidence, #claim-evidence * { visibility: visible !important; }
        #claim-evidence { position: absolute; left: 0; top: 0; width: 100%; }
        .no-print { display: none !important; }
      }`}</style>

      <div style={{ background: '#014F54', borderRadius: '12px', padding: '20px 24px', marginBottom: '20px' }}>
        <h2 style={{ color: '#FFFFFF', margin: '0 0 4px', fontSize: '18px' }}>Claims Evidence</h2>
        <p style={{ color: '#EAF6F4', margin: 0, fontSize: '13px' }}>
          Read-only · {orgLabel(net, 'insurer', 'Insurer')} · incidents for one worker or beacon, straight from the ledger
        </p>
      </div>

      <form onSubmit={search} className="no-print" style={{
        background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: '10px', padding: '16px',
        display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end', marginBottom: '20px',
      }}>
        <label style={label}>Look up
          <select style={input} value={mode} onChange={e => { setMode(e.target.value); setResult(null) }}>
            <option value="worker">Worker (employee code)</option>
            <option value="device">Beacon (device id)</option>
          </select>
        </label>
        <label style={label}>{mode === 'worker' ? 'Employee code' : 'Beacon id'}
          <input style={{ ...input, width: '180px' }} value={code} required onChange={e => setCode(e.target.value)}
            placeholder={mode === 'worker' ? 'e.g. EMP-1042' : 'device id'} />
        </label>
        <label style={label}>Claim period from
          <input style={input} type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </label>
        <label style={label}>to
          <input style={input} type="date" value={to} onChange={e => setTo(e.target.value)} />
        </label>
        <button type="submit" disabled={busy} style={{
          background: busy ? '#CBD5E1' : '#028090', color: '#FFFFFF', border: 'none', borderRadius: '6px',
          padding: '9px 18px', fontWeight: 600, fontSize: '13px', cursor: busy ? 'wait' : 'pointer',
        }}>{busy ? 'Searching…' : 'Search ledger'}</button>
      </form>

      {error && <div style={{ background: '#FBEAE8', color: '#C0392B', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', marginBottom: '16px' }}>{error}</div>}

      {result && (
        <div id="claim-evidence" style={{ background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: '10px', padding: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
            <div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#014F54' }}>
                {result.mode === 'worker' ? `Worker ${result.code}` : `Beacon ${result.code}`}
              </div>
              <div style={{ fontSize: '12px', color: '#64748B' }}>
                Period: {result.from || 'beginning'} → {result.to || 'today'} · retrieved {fmt(result.at)} by {session.username} ({session.identity}, {session.mspId})
              </div>
            </div>
            <button className="no-print" onClick={() => window.print()} style={{
              background: '#FFFFFF', color: '#014F54', border: '1px solid #014F54', borderRadius: '6px',
              padding: '6px 14px', fontSize: '13px', cursor: 'pointer', height: 'fit-content',
            }}>🖨 Print / save PDF</button>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
            {[['Incidents', inc.length, '#014F54'], ['Genuine', count('GENUINE'), '#C0392B'], ['Near miss', count('NEAR_MISS'), '#B7791F'],
              ['False alarm', count('FALSE_ALARM'), '#64748B'], ['Not yet resolved', open, '#7E22CE']].map(([k, v, c]) => (
              <div key={k} style={{ border: '1px solid #E2E8F0', borderRadius: '8px', padding: '8px 14px', minWidth: '110px' }}>
                <div style={{ fontSize: '20px', fontWeight: 700, color: c }}>{v}</div>
                <div style={{ fontSize: '12px', color: '#64748B' }}>{k}</div>
              </div>
            ))}
          </div>

          {result.assignments && (
            <>
              <h3 style={{ fontSize: '14px', color: '#014F54', margin: '0 0 6px' }}>Beacons worn (recorded by the employer)</h3>
              {result.assignments.length === 0
                ? <p style={{ fontSize: '13px', color: '#64748B' }}>No beacon assignment is recorded for this code, so no incidents can be attributed to it.</p>
                : (
                  <div style={{ overflowX: 'auto', marginBottom: '16px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead><tr style={{ borderBottom: '1px solid #E2E8F0' }}>{['Beacon', 'From', 'Until', 'Recorded by'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                      <tbody>{result.assignments.map(a => (
                        <tr key={a.deviceId + a.fromTs} style={{ borderBottom: '1px solid #F1F5F9' }}>
                          <td style={td}>{a.deviceId}</td><td style={td}>{fmt(a.fromTs)}</td>
                          <td style={td}>{a.toTs ? fmt(a.toTs) : 'still assigned'}</td><td style={td}>{cn(a.registeredBy)}</td>
                        </tr>))}</tbody>
                    </table>
                  </div>
                )}
            </>
          )}

          <h3 style={{ fontSize: '14px', color: '#014F54', margin: '0 0 6px' }}>Incidents</h3>
          {inc.length === 0 ? <p style={{ fontSize: '13px', color: '#64748B' }}>No incidents in this period.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead><tr style={{ borderBottom: '1px solid #E2E8F0' }}>
                  {['Time', 'Event', 'Beacon', 'Risk', 'Status', 'Outcome', 'Conditions', ''].map(h => <th key={h} style={th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {inc.map(i => {
                    const s = STATUS[i.status] || STATUS.TRIGGERED
                    const f = i.risk?.factors
                    const h = history[i.incidentId]
                    return [
                      <tr key={i.incidentId} style={{ borderBottom: h ? 'none' : '1px solid #F1F5F9' }}>
                        <td style={td}>{fmt(i.timestamp)}<div style={{ fontSize: '11px', color: '#94A3B8' }}>{i.incidentId}</div></td>
                        <td style={td}>{i.eventType}</td>
                        <td style={td}>{i.deviceId}</td>
                        <td style={td} title={riskDrivers(i) || ''}>{i.riskScore}</td>
                        <td style={td}><span style={{ background: s.bg, color: s.text, borderRadius: '10px', padding: '2px 8px', fontSize: '11px', fontWeight: 600 }}>
                          {i.status}{i.escalationLevel ? ` L${i.escalationLevel}` : ''}</span></td>
                        <td style={td}>{OUTCOME[i.outcome] || '—'}{i.resolutionNotes ? <div style={{ fontSize: '11px', color: '#64748B' }}>{i.resolutionNotes}</div> : null}</td>
                        <td style={td}>{f?.heatBand ? `${f.heatBand.replace('_', ' ').toLowerCase()} · HI ${f.heatIndexC}°C` : '—'}</td>
                        <td style={td} className="no-print">
                          <button onClick={() => toggleHistory(i.incidentId)} style={{
                            background: 'none', border: '1px solid #CBD5E1', borderRadius: '6px', padding: '3px 8px', fontSize: '12px', cursor: 'pointer',
                          }}>{h ? 'Hide trail' : 'Ledger trail'}</button>
                        </td>
                      </tr>,
                      h && (
                        <tr key={i.incidentId + '-h'} style={{ borderBottom: '1px solid #F1F5F9', background: '#F8FAFC' }}>
                          <td colSpan={8} style={{ padding: '8px 12px' }}>
                            {h === 'loading' ? 'Loading…' : h.map((e, n) => e.error
                              ? <div key={n} style={{ color: '#C0392B' }}>{e.error}</div>
                              : (
                                <div key={e.txId} style={{ fontSize: '12px', color: '#334155', padding: '2px 0' }}>
                                  <strong>{e.value?.status}</strong> · {fmt(e.value?.updatedAt || e.value?.timestamp)}
                                  {(e.value?.updatedBy || e.value?.createdBy) ? ` · by ${cn(e.value.updatedBy || e.value.createdBy)}` : ''}
                                  <span style={{ color: '#94A3B8' }}> · tx {String(e.txId).slice(0, 16)}…</span>
                                </div>
                              ))}
                          </td>
                        </tr>
                      ),
                    ]
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ fontSize: '11px', color: '#94A3B8', marginTop: '14px' }}>
            Source: Hyperledger Fabric channel {net?.channel || '…'}, chaincode {net?.chaincode || '…'}. Incidents are logged by the site gateway and
            endorsed by the employer and the regulator; transaction ids can be verified on any member peer.
          </p>
        </div>
      )}
    </div>
  )
}

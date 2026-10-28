import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

// Compliance score computed by chaincode 1.3 (GetComplianceScore) on the peer — TG-021.
// Shown to the supervisor and to the regulator (auditor); both get the same number from the ledger.
const GRADE = { A: '#028090', B: '#2F855A', C: '#B7791F', D: '#C0392B', 'N/A': '#64748B' }
const PERIODS = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']]
const SITE_LABEL = { unassigned: 'Unassigned (no site context)' }

export default function ComplianceCard({ onOpenIncident }) {
  const [period, setPeriod] = useState('30')
  const [data, setData]     = useState(null)
  const [error, setError]   = useState(null)
  const [open, setOpen]     = useState(null)   // metric key whose missed incidents are listed

  const load = useCallback(async () => {
    setError(null)
    try {
      const from = period === 'all' ? '' : new Date(Date.now() - Number(period) * 86400000).toISOString()
      const r = await axios.get('/api/compliance/score', { params: { from } })
      setData(r.data)
    } catch (e) { setError(e.response?.data?.error || e.message); setData(null) }
  }, [period])
  useEffect(() => { load(); const t = setInterval(load, 120000); return () => clearInterval(t) }, [load])

  const o = data?.overall
  return (
    <div style={{ background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: '10px', padding: '14px 16px', marginBottom: '20px', textAlign: 'left' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
        <strong style={{ color: '#014F54', fontSize: '14px' }}>📊 Compliance score</strong>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <select value={period} onChange={e => setPeriod(e.target.value)} style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid #CBD5E1', fontSize: '12px' }}>
            {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button onClick={load} style={{ background: 'none', border: '1px solid #CBD5E1', borderRadius: '6px', padding: '4px 8px', fontSize: '12px', cursor: 'pointer' }}>↻</button>
        </div>
      </div>

      {error && <div style={{ color: '#C0392B', fontSize: '13px' }}>{error}</div>}
      {!data && !error && <div style={{ color: '#64748B', fontSize: '13px' }}>Computing on the ledger…</div>}

      {o && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px', alignItems: 'stretch' }}>
          <div style={{ minWidth: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
                        border: `2px solid ${GRADE[o.grade]}`, borderRadius: '10px', padding: '10px 14px' }}>
            <div style={{ fontSize: '34px', fontWeight: 800, color: GRADE[o.grade], lineHeight: 1 }}>{o.score ?? '—'}</div>
            <div style={{ fontSize: '12px', color: '#475569', marginTop: '4px' }}>Grade {o.grade} · {o.incidents} incident{o.incidents === 1 ? '' : 's'}</div>
          </div>
          <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '7px' }}>
            {o.metrics.map(m => (
              <div key={m.key}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#334155' }}>
                  <span>{m.label} <span style={{ color: '#94A3B8' }}>({m.weight}%)</span></span>
                  <span>
                    {m.rate === null ? <span style={{ color: '#94A3B8' }}>no eligible incidents</span> : <>
                      <strong>{m.rate}%</strong> <span style={{ color: '#64748B' }}>· {m.met}/{m.eligible}</span>
                      {m.failedIds.length > 0 && (
                        <button onClick={() => setOpen(open === m.key ? null : m.key)} style={{ marginLeft: '6px', background: 'none', border: 'none', color: '#028090', cursor: 'pointer', fontSize: '12px', padding: 0 }}>
                          {open === m.key ? 'hide' : `${m.eligible - m.met} missed`}
                        </button>)}
                    </>}
                  </span>
                </div>
                <div style={{ height: '6px', background: '#F1F5F9', borderRadius: '3px', overflow: 'hidden', marginTop: '3px' }}>
                  <div style={{ width: `${m.rate ?? 0}%`, height: '100%', background: m.rate >= 90 ? '#02C39A' : m.rate >= 60 ? '#D69E2E' : '#E06C5F' }} />
                </div>
                {open === m.key && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '5px' }}>
                    {m.failedIds.map(id => (
                      <button key={id} onClick={() => onOpenIncident && onOpenIncident(id)} style={{
                        fontFamily: 'monospace', fontSize: '11px', background: '#FBEAE8', color: '#C0392B', border: 'none', borderRadius: '4px',
                        padding: '2px 6px', cursor: onOpenIncident ? 'pointer' : 'default' }}>{id}</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {o && o.form18DueSoon.length > 0 && (
        <div style={{ marginTop: '10px', background: '#FFF8E6', color: '#B7791F', borderRadius: '6px', padding: '6px 10px', fontSize: '12px' }}>
          ⏱ Form 18 still to file within 12 h: {o.form18DueSoon.map(id => (
            <button key={id} onClick={() => onOpenIncident && onOpenIncident(id)} style={{ fontFamily: 'monospace', background: 'none', border: 'none', color: '#B7791F', textDecoration: 'underline', cursor: 'pointer', fontSize: '12px' }}>{id}</button>))}
        </div>
      )}

      {data && data.sites.length > 1 && (
        <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '12px' }}>
          {data.sites.map(s => (
            <span key={s.site} style={{ border: '1px solid #E2E8F0', borderRadius: '6px', padding: '3px 8px', color: '#334155' }}>
              {SITE_LABEL[s.site] || s.site}: <strong style={{ color: GRADE[s.grade] }}>{s.score ?? '—'}</strong> ({s.incidents})
            </span>
          ))}
        </div>
      )}

      {data && (
        <div style={{ marginTop: '8px', fontSize: '11px', color: '#94A3B8' }}>
          Computed by the chaincode ({data.model}) from the ledger as of {new Date(data.asOfTs).toLocaleString('en-IN', { timeStyle: 'short', dateStyle: 'medium' })}.
          Incidents still inside a metric's time limit are counted once the limit has passed.
        </div>
      )}
    </div>
  )
}

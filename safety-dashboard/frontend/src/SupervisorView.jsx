import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'
import SiteConditions from './SiteConditions'
import AssignmentsPanel from './AssignmentsPanel'
import ComplianceCard from './ComplianceCard'
import StatutoryPanel from './StatutoryPanel'

const API = '/api'

const STATUS_COLORS = {
  TRIGGERED:    { bg: '#FBEAE8', text: '#C0392B', border: '#C0392B' },
  ESCALATED:    { bg: '#F3E8FF', text: '#7E22CE', border: '#9333EA' },
  ACKNOWLEDGED: { bg: '#FFF8E6', text: '#B7791F', border: '#D69E2E' },
  RESOLVED:     { bg: '#EAF6F4', text: '#028090', border: '#02C39A' }
}

const EVENT_ICONS = { SOS: '🆘', FALL: '⬇️', INACTIVITY: '💤' }

// Outcome tag recorded on resolve (chaincode 1.1) — training label for the AI risk score
const OUTCOMES = [
  { value: 'GENUINE',     label: 'Genuine emergency' },
  { value: 'NEAR_MISS',   label: 'Near miss' },
  { value: 'FALSE_ALARM', label: 'False alarm' },
]
const OUTCOME_LABEL = Object.fromEntries(OUTCOMES.map(o => [o.value, o.label]))

// Risk breakdown recorded on-chain by the gateway (TG-015)
const FACTOR_LABEL = { base: 'base', heat: 'heat', night: 'night shift', repeat: 'repeat events', genuineHistory: 'genuine history',
  falseAlarmHistory: 'false-alarm history', weakSignal: 'weak signal' }
export function riskDrivers(inc) {
  const f = inc?.risk?.factors
  if (!f) return null
  const parts = Object.keys(FACTOR_LABEL).filter(k => typeof f[k] === 'number')
    .map(k => k === 'base' ? `base ${f[k]}` : `${FACTOR_LABEL[k]} ${f[k] > 0 ? '+' : ''}${f[k]}`)
  if (f.heatBand) parts.push(`(${f.heatBand.replace('_', ' ').toLowerCase()}, HI ${f.heatIndexC}°C)`)
  return `${parts.join(' · ')} — ${inc.risk.modelVersion}`
}


export default function SupervisorView({ session }) {
  const [incidents, setIncidents] = useState([])
  const [selected,  setSelected]  = useState(null)
  const [history,   setHistory]   = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [updating,  setUpdating]  = useState(null)
  const [error,     setError]     = useState(null)
  const [outcome,   setOutcome]   = useState('')
  const [notes,     setNotes]     = useState('')

  const headers = { 'x-identity': session.identity }

  const fetchIncidents = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/incidents`, { headers })
      setIncidents(res.data.incidents || [])
      setError(null)
      return res.data.incidents || []
    } catch (err) {
      setError('Failed to load incidents from ledger')
    } finally {
      setLoading(false)
    }
  }, [session.identity])

  // ── Live alerts (TG-016): banner + beep + tab title for unacknowledged incidents of the last hour
  const seenRef = useRef(null)
  const RECENT_MS = 60 * 60 * 1000
  const openAlerts = incidents
    .filter(i => (i.status === 'TRIGGERED' || i.status === 'ESCALATED') && Date.now() - Date.parse(i.timestamp) < RECENT_MS)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
  useEffect(() => {
    const ids = openAlerts.map(i => i.incidentId)
    if (seenRef.current && ids.some(id => !seenRef.current.has(id))) beep()
    if (!loading) seenRef.current = new Set([...(seenRef.current || []), ...ids])
    document.title = openAlerts.length ? `(${openAlerts.length}) 🚨 IINoT Safety Monitor` : 'IINoT Safety Monitor'
  }, [incidents, loading])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { document.title = 'IINoT Safety Monitor' }, [])

  useEffect(() => {
    fetchIncidents()
    const interval = setInterval(fetchIncidents, 10000)
    return () => clearInterval(interval)
  }, [fetchIncidents])

  async function loadHistory(incidentId) {
    try {
      const res = await axios.get(`${API}/incidents/${incidentId}/history`, { headers })
      setHistory({ id: incidentId, entries: res.data.history })
    } catch (err) {
      setError('Failed to load audit history')
    }
  }

  async function updateStatus(incidentId, status) {
    setUpdating(incidentId)
    try {
      await axios.patch(
        `${API}/incidents/${incidentId}/status`,
        { status }, { headers }
      )
      // Reload from the ledger so the panel shows updatedBy / updatedAt too
      const list = await fetchIncidents()
      setSelected(prev => prev?.incidentId === incidentId
        ? (list?.find(i => i.incidentId === incidentId) || { ...prev, status }) : prev)
    } catch (err) {
      setError(`Failed to update: ${err.response?.data?.error}`)
    } finally {
      setUpdating(null)
    }
  }

  async function resolveIncident(incidentId) {
    setUpdating(incidentId)
    try {
      await axios.post(`${API}/incidents/${incidentId}/resolve`, { outcome, notes })
      const list = await fetchIncidents()
      setSelected(prev => prev?.incidentId === incidentId
        ? (list?.find(i => i.incidentId === incidentId) || { ...prev, status: 'RESOLVED', outcome }) : prev)
      setOutcome(''); setNotes('')
    } catch (err) {
      setError(`Failed to resolve: ${err.response?.data?.error}`)
    } finally {
      setUpdating(null)
    }
  }

  const triggered    = incidents.filter(i => i.status === 'TRIGGERED' || i.status === 'ESCALATED')
  const acknowledged = incidents.filter(i => i.status === 'ACKNOWLEDGED')
  const resolved     = incidents.filter(i => i.status === 'RESOLVED')

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>

      <SiteConditions />

      <ComplianceCard onOpenIncident={id => {
        const i = incidents.find(x => x.incidentId === id)
        if (i) { setSelected(i); setHistory(null); setOutcome(''); setNotes('') }
      }} />

      <AssignmentsPanel />

      {openAlerts.length > 0 && (
        <div style={{
          background: openAlerts.some(i => i.status === 'ESCALATED') ? '#7E22CE' : '#C0392B', color: '#FFFFFF',
          borderRadius: '10px', padding: '12px 16px', marginBottom: '16px',
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px', fontSize: '13px',
        }}>
          <strong style={{ fontSize: '14px' }}>
            🚨 {openAlerts.length} alert{openAlerts.length > 1 ? 's' : ''} waiting for acknowledgement
          </strong>
          {openAlerts.slice(0, 3).map(i => (
            <button key={i.incidentId} onClick={() => { setSelected(i); setHistory(null); setOutcome(''); setNotes('') }} style={{
              background: 'rgba(255,255,255,0.15)', color: '#FFFFFF', border: '1px solid rgba(255,255,255,0.5)',
              borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px',
            }}>
              {i.eventType} · {i.deviceId} · risk {i.riskScore} · {Math.max(0, Math.round((Date.now() - Date.parse(i.timestamp)) / 60000))} min
              {i.escalationLevel ? ` · L${i.escalationLevel}` : ''}
            </button>
          ))}
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        {[
          { label: 'Active Alerts', count: triggered.length,    color: '#C0392B', bg: '#FBEAE8' },
          { label: 'Acknowledged',  count: acknowledged.length, color: '#B7791F', bg: '#FFF8E6' },
          { label: 'Resolved',      count: resolved.length,     color: '#028090', bg: '#EAF6F4' },
          { label: 'Total',         count: incidents.length,    color: '#1E293B', bg: '#F1F5F9' }
        ].map(s => (
          <div key={s.label} style={{
            background: s.bg, borderRadius: '10px',
            padding: '16px 24px', minWidth: '140px', flex: 1
          }}>
            <div style={{ fontSize: '28px', fontWeight: 700, color: s.color }}>
              {s.count}
            </div>
            <div style={{ fontSize: '13px', color: '#64748B' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {error && (
        <div style={{
          background: '#FBEAE8', border: '1px solid #C0392B',
          borderRadius: '8px', padding: '10px 16px',
          color: '#C0392B', fontSize: '13px', marginBottom: '16px'
        }}>⚠️ {error}</div>
      )}

      <div style={{ display: 'flex', gap: '20px' }}>

        {/* List */}
        <div style={{ flex: 1 }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', marginBottom: '12px'
          }}>
            <h2 style={{ margin: 0, fontSize: '16px', color: '#1E293B' }}>Incidents</h2>
            <button onClick={fetchIncidents} style={{
              background: '#EAF6F4', border: '1px solid #02C39A',
              borderRadius: '6px', padding: '4px 12px',
              cursor: 'pointer', fontSize: '12px', color: '#028090'
            }}>↻ Refresh</button>
          </div>

          {loading ? (
            <div style={{ color: '#64748B', padding: '20px', textAlign: 'center' }}>
              Loading incidents from ledger...
            </div>
          ) : incidents.length === 0 ? (
            <div style={{
              color: '#64748B', padding: '40px', textAlign: 'center',
              background: '#F8FAFC', borderRadius: '10px',
              border: '1px dashed #E2E8F0'
            }}>
              No incidents on ledger yet. Run simulateEvent.js to create one.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {incidents.map(inc => {
                const sc = STATUS_COLORS[inc.status] || STATUS_COLORS.RESOLVED
                const isSelected = selected?.incidentId === inc.incidentId
                return (
                  <div
                    key={inc.incidentId}
                    onClick={() => { setSelected(inc); setHistory(null); setOutcome(''); setNotes('') }}
                    style={{
                      background: isSelected ? '#EAF6F4' : '#FFFFFF',
                      border: `1px solid ${isSelected ? '#02C39A' : '#E2E8F0'}`,
                      borderRadius: '10px', padding: '14px 16px', cursor: 'pointer'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '18px' }}>
                          {EVENT_ICONS[inc.eventType] || '⚠️'}
                        </span>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '13px', color: '#1E293B' }}>
                            {inc.incidentId}
                          </div>
                          <div style={{ fontSize: '11px', color: '#64748B' }}>
                            {inc.deviceId} · Risk: {inc.riskScore}
                          </div>
                        </div>
                      </div>
                      <span style={{
                        background: sc.bg, color: sc.text,
                        border: `1px solid ${sc.border}`,
                        borderRadius: '12px', padding: '2px 10px',
                        fontSize: '11px', fontWeight: 600
                      }}>
                        {inc.status}{inc.escalationLevel && inc.status === 'ESCALATED' ? ` L${inc.escalationLevel}` : ''}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: '#94A3B8', marginTop: '6px' }}>
                      {new Date(inc.timestamp).toLocaleString()}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div style={{
            width: '340px', background: '#FFFFFF',
            border: '1px solid #E2E8F0', borderRadius: '12px',
            padding: '20px', alignSelf: 'flex-start'
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: '16px'
            }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#1E293B' }}>
                {EVENT_ICONS[selected.eventType]} {selected.incidentId}
              </h3>
              <button onClick={() => setSelected(null)} style={{
                background: 'none', border: 'none',
                cursor: 'pointer', color: '#94A3B8', fontSize: '18px'
              }}>×</button>
            </div>

            {[
              ['Device',     selected.deviceId],
              ['Event',      selected.eventType],
              ['Risk score', selected.riskScore],
              ...(riskDrivers(selected) ? [['Risk drivers', riskDrivers(selected)]] : []),
              ['Status',     selected.status],
              ...(selected.escalationLevel ? [['Escalation', `Level ${selected.escalationLevel} · ${selected.escalationReason || ''}`]] : []),
              ...(selected.outcome ? [['Outcome', OUTCOME_LABEL[selected.outcome] || selected.outcome]] : []),
              ...(selected.resolutionNotes ? [['Notes', selected.resolutionNotes]] : []),
              ['Time',       new Date(selected.timestamp).toLocaleString()],
              ['Created by', selected.createdBy?.split('/CN=')[1]?.split(':')[0] || '—'],
              ['Updated by', selected.updatedBy?.split('/CN=')[1]?.split(':')[0] || '—'],
              ['Updated at', selected.updatedAt ? new Date(selected.updatedAt).toLocaleString() : '—']
            ].map(([k, v]) => (
              <div key={k} style={{
                display: 'flex', justifyContent: 'space-between',
                padding: '6px 0', borderBottom: '1px solid #F1F5F9', fontSize: '13px'
              }}>
                <span style={{ color: '#64748B' }}>{k}</span>
                <span style={{
                  color: '#1E293B', fontWeight: 500,
                  maxWidth: '180px', textAlign: 'right', wordBreak: 'break-word'
                }}>{v}</span>
              </div>
            ))}

            <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {(selected.status === 'TRIGGERED' || selected.status === 'ESCALATED') && (
                <button
                  onClick={() => updateStatus(selected.incidentId, 'ACKNOWLEDGED')}
                  disabled={updating === selected.incidentId}
                  style={{
                    background: '#D69E2E', color: '#FFFFFF',
                    border: 'none', borderRadius: '8px', padding: '10px',
                    cursor: 'pointer', fontWeight: 600, fontSize: '13px'
                  }}
                >
                  {updating === selected.incidentId ? 'Updating...' : '✓ Acknowledge'}
                </button>
              )}
              {selected.status === 'ACKNOWLEDGED' && (
                <div style={{ border: '1px solid #E2E8F0', borderRadius: '8px', padding: '10px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#334155', marginBottom: '6px' }}>
                    Resolve — what was it?
                  </div>
                  <select value={outcome} onChange={e => setOutcome(e.target.value)} style={{
                    width: '100%', padding: '8px', borderRadius: '6px',
                    border: '1px solid #CBD5E1', fontSize: '13px', marginBottom: '6px'
                  }}>
                    <option value="">Select outcome…</option>
                    {OUTCOMES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <textarea value={notes} onChange={e => setNotes(e.target.value.slice(0, 500))}
                    placeholder="Notes (optional)" rows={2} style={{
                      width: '100%', padding: '8px', borderRadius: '6px', boxSizing: 'border-box',
                      border: '1px solid #CBD5E1', fontSize: '12px', marginBottom: '6px', resize: 'vertical'
                    }} />
                  <button
                    onClick={() => resolveIncident(selected.incidentId)}
                    disabled={!outcome || updating === selected.incidentId}
                    style={{
                      width: '100%', background: outcome ? '#028090' : '#CBD5E1', color: '#FFFFFF',
                      border: 'none', borderRadius: '8px', padding: '10px',
                      cursor: outcome ? 'pointer' : 'not-allowed', fontWeight: 600, fontSize: '13px'
                    }}
                  >
                    {updating === selected.incidentId ? 'Updating...' : '✓ Mark Resolved'}
                  </button>
                </div>
              )}
              <button
                onClick={() => loadHistory(selected.incidentId)}
                style={{
                  background: '#EAF6F4', color: '#028090',
                  border: '1px solid #02C39A', borderRadius: '8px',
                  padding: '8px', cursor: 'pointer', fontSize: '12px'
                }}
              >📋 View Audit Trail</button>
            </div>

            <StatutoryPanel incident={selected} onChanged={async () => {
              const list = await fetchIncidents()
              setSelected(prev => list?.find(i => i.incidentId === prev?.incidentId) || prev)
            }} />

            {history?.id === selected.incidentId && (
              <div style={{ marginTop: '16px' }}>
                <div style={{
                  fontSize: '12px', fontWeight: 600, color: '#64748B',
                  marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px'
                }}>
                  Immutable Ledger History
                </div>
                {history.entries.map((entry, i) => (
                  <div key={i} style={{
                    background: '#F8FAFC', borderRadius: '6px',
                    padding: '8px 10px', marginBottom: '6px', fontSize: '11px'
                  }}>
                    <div style={{ fontWeight: 600, color: '#028090', marginBottom: '2px' }}>
                      {entry.value?.status || 'CREATED'}
                    </div>
                    <div style={{ color: '#64748B', fontFamily: 'monospace' }}>
                      txId: {entry.txId?.slice(0, 16)}…
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Short two-tone alert (Web Audio — works over plain HTTP once the user has clicked on the page)
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    ;[880, 660].forEach((f, k) => {
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination)
      g.gain.setValueAtTime(0.2, ctx.currentTime + k * 0.25)
      o.start(ctx.currentTime + k * 0.25); o.stop(ctx.currentTime + k * 0.25 + 0.2)
    })
    setTimeout(() => ctx.close(), 1000)
  } catch { /* audio not available */ }
}

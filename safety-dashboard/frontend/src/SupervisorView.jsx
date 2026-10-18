import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const API = '/api'

const STATUS_COLORS = {
  TRIGGERED:    { bg: '#FBEAE8', text: '#C0392B', border: '#C0392B' },
  ACKNOWLEDGED: { bg: '#FFF8E6', text: '#B7791F', border: '#D69E2E' },
  RESOLVED:     { bg: '#EAF6F4', text: '#028090', border: '#02C39A' }
}

const EVENT_ICONS = { SOS: '🆘', FALL: '⬇️', INACTIVITY: '💤' }

export default function SupervisorView({ session }) {
  const [incidents, setIncidents] = useState([])
  const [selected,  setSelected]  = useState(null)
  const [history,   setHistory]   = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [updating,  setUpdating]  = useState(null)
  const [error,     setError]     = useState(null)

  const headers = { 'x-identity': session.identity }

  const fetchIncidents = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/incidents`, { headers })
      setIncidents(res.data.incidents || [])
      setError(null)
    } catch (err) {
      setError('Failed to load incidents from ledger')
    } finally {
      setLoading(false)
    }
  }, [session.identity])

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
      await fetchIncidents()
      setSelected(prev => prev?.incidentId === incidentId ? { ...prev, status } : prev)
    } catch (err) {
      setError(`Failed to update: ${err.response?.data?.error}`)
    } finally {
      setUpdating(null)
    }
  }

  const triggered    = incidents.filter(i => i.status === 'TRIGGERED')
  const acknowledged = incidents.filter(i => i.status === 'ACKNOWLEDGED')
  const resolved     = incidents.filter(i => i.status === 'RESOLVED')

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>

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
                    onClick={() => { setSelected(inc); setHistory(null) }}
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
                        {inc.status}
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
              ['Status',     selected.status],
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
              {selected.status === 'TRIGGERED' && (
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
                <button
                  onClick={() => updateStatus(selected.incidentId, 'RESOLVED')}
                  disabled={updating === selected.incidentId}
                  style={{
                    background: '#028090', color: '#FFFFFF',
                    border: 'none', borderRadius: '8px', padding: '10px',
                    cursor: 'pointer', fontWeight: 600, fontSize: '13px'
                  }}
                >
                  {updating === selected.incidentId ? 'Updating...' : '✓ Mark Resolved'}
                </button>
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

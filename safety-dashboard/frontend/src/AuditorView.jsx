import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const API = '/api'

const STATUS_COLORS = {
  TRIGGERED:    { bg: '#FBEAE8', text: '#C0392B' },
  ACKNOWLEDGED: { bg: '#FFF8E6', text: '#B7791F' },
  RESOLVED:     { bg: '#EAF6F4', text: '#028090' }
}

export default function AuditorView({ session }) {
  const [incidents, setIncidents] = useState([])
  const [selected,  setSelected]  = useState(null)
  const [history,   setHistory]   = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [filter,    setFilter]    = useState('ALL')

  const headers = { 'x-identity': session.identity }

  const fetchIncidents = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/incidents`, { headers })
      setIncidents(res.data.incidents || [])
    } finally {
      setLoading(false)
    }
  }, [session.identity])

  useEffect(() => { fetchIncidents() }, [fetchIncidents])

  async function loadHistory(inc) {
    const res = await axios.get(`${API}/incidents/${inc.incidentId}/history`, { headers })
    setSelected(inc)
    setHistory({ id: inc.incidentId, entries: res.data.history })
  }

  const filtered = filter === 'ALL'
    ? incidents
    : incidents.filter(i => i.status === filter)

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>

      <div style={{
        background: '#014F54', borderRadius: '12px',
        padding: '20px 24px', marginBottom: '24px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center'
      }}>
        <div>
          <h2 style={{ color: '#FFFFFF', margin: '0 0 4px', fontSize: '18px' }}>
            Regulatory Audit Dashboard
          </h2>
          <p style={{ color: '#EAF6F4', margin: 0, fontSize: '13px' }}>
            Read-only · IINoT Regulator · All data from the immutable ledger
          </p>
        </div>
        <div style={{
          background: '#02C39A20', border: '1px solid #02C39A',
          borderRadius: '8px', padding: '8px 16px',
          color: '#02C39A', fontSize: '13px', fontWeight: 600
        }}>
          🔒 Auditor access
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {['ALL', 'TRIGGERED', 'ACKNOWLEDGED', 'RESOLVED'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              background: filter === f ? '#028090' : '#FFFFFF',
              color: filter === f ? '#FFFFFF' : '#64748B',
              border: `1px solid ${filter === f ? '#028090' : '#E2E8F0'}`,
              borderRadius: '20px', padding: '5px 14px',
              cursor: 'pointer', fontSize: '12px', fontWeight: 500
            }}
          >
            {f}{f !== 'ALL' && ` (${incidents.filter(i => i.status === f).length})`}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '20px' }}>
        <div style={{ flex: 1, overflowX: 'auto' }}>
          {loading ? (
            <div style={{ color: '#64748B', padding: '40px', textAlign: 'center' }}>
              Loading ledger data...
            </div>
          ) : (
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              background: '#FFFFFF', borderRadius: '10px',
              overflow: 'hidden', fontSize: '13px'
            }}>
              <thead>
                <tr style={{ background: '#F8FAFC' }}>
                  {['Incident ID','Device','Type','Risk','Status','Timestamp','Actions'].map(h => (
                    <th key={h} style={{
                      padding: '10px 14px', textAlign: 'left',
                      color: '#64748B', fontWeight: 600,
                      fontSize: '11px', textTransform: 'uppercase',
                      letterSpacing: '0.5px', borderBottom: '1px solid #E2E8F0'
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((inc, idx) => {
                  const sc = STATUS_COLORS[inc.status] || STATUS_COLORS.RESOLVED
                  return (
                    <tr key={inc.incidentId} style={{
                      background: idx % 2 === 0 ? '#FFFFFF' : '#F8FAFC',
                      borderBottom: '1px solid #F1F5F9'
                    }}>
                      <td style={{ padding: '10px 14px', fontFamily: 'monospace', color: '#028090' }}>
                        {inc.incidentId}
                      </td>
                      <td style={{ padding: '10px 14px', color: '#1E293B' }}>{inc.deviceId}</td>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: '#1E293B' }}>
                        {inc.eventType}
                      </td>
                      <td style={{ padding: '10px 14px', color: '#1E293B' }}>{inc.riskScore}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{
                          background: sc.bg, color: sc.text,
                          borderRadius: '10px', padding: '2px 8px',
                          fontSize: '11px', fontWeight: 600
                        }}>{inc.status}</span>
                      </td>
                      <td style={{ padding: '10px 14px', color: '#64748B', fontSize: '12px' }}>
                        {new Date(inc.timestamp).toLocaleString()}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <button
                          onClick={() => loadHistory(inc)}
                          style={{
                            background: '#EAF6F4', color: '#028090',
                            border: '1px solid #02C39A', borderRadius: '6px',
                            padding: '4px 10px', cursor: 'pointer', fontSize: '11px'
                          }}
                        >Audit trail</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {selected && history?.id === selected.incidentId && (
          <div style={{
            width: '300px', background: '#FFFFFF',
            border: '1px solid #E2E8F0', borderRadius: '12px',
            padding: '20px', alignSelf: 'flex-start'
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: '14px'
            }}>
              <h3 style={{ margin: 0, fontSize: '13px', color: '#1E293B', fontWeight: 600 }}>
                🔒 Immutable Audit Trail
              </h3>
              <button
                onClick={() => { setSelected(null); setHistory(null) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: '18px' }}
              >×</button>
            </div>
            <div style={{ fontSize: '11px', color: '#64748B', marginBottom: '12px' }}>
              {selected.incidentId} · {history.entries.length} ledger entries
            </div>
            {history.entries.map((entry, i) => (
              <div key={i} style={{
                borderLeft: '3px solid #02C39A',
                paddingLeft: '12px', marginBottom: '14px'
              }}>
                <div style={{ fontWeight: 700, color: '#028090', fontSize: '12px', marginBottom: '2px' }}>
                  {entry.value?.status || 'CREATED'}
                </div>
                <div style={{ fontSize: '10px', color: '#64748B', fontFamily: 'monospace', marginBottom: '2px' }}>
                  tx: {entry.txId?.slice(0, 20)}…
                </div>
                <div style={{ fontSize: '10px', color: '#94A3B8' }}>
		  by: {(entry.value?.updatedBy || entry.value?.createdBy)
  		  ?.split('/CN=')[1]?.split(':')[0] || '—'}
                </div>
              </div>
            ))}
            <div style={{
              marginTop: '12px', padding: '8px', background: '#EAF6F4',
              borderRadius: '6px', fontSize: '10px', color: '#028090', textAlign: 'center'
            }}>
              ✓ Verified against immutable Fabric ledger
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

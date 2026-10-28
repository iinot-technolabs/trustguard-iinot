import { useState, useEffect } from 'react'
import axios from 'axios'

// Latest oracle weather reading per site, verified against the ledger (TG-014)
const BAND = {
  NORMAL:          { label: 'Normal',          bg: '#EAF6F4', text: '#028090' },
  CAUTION:         { label: 'Caution',         bg: '#FFF8E6', text: '#B7791F' },
  EXTREME_CAUTION: { label: 'Extreme caution', bg: '#FDEBD3', text: '#C05621' },
  DANGER:          { label: 'Danger',          bg: '#FBEAE8', text: '#C0392B' },
  EXTREME_DANGER:  { label: 'Extreme danger',  bg: '#C0392B', text: '#FFFFFF' },
  UNKNOWN:         { label: 'Unknown',         bg: '#F1F5F9', text: '#64748B' },
}

export default function SiteConditions() {
  const [readings, setReadings] = useState(null)

  useEffect(() => {
    let alive = true
    const load = () => axios.get('/api/oracle/latest')
      .then(r => { if (alive) setReadings(r.data.readings || []) })
      .catch(() => { if (alive) setReadings([]) })
    load()
    const t = setInterval(load, 60000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (!readings || readings.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
      {readings.map(r => {
        const b = BAND[r.heatBand] || BAND.UNKNOWN
        const ageMin = Math.round((Date.now() - Date.parse(r.observedAt)) / 60000)
        return (
          <div key={r.siteId} style={{
            background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: '10px',
            padding: '12px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center',
            gap: '8px 20px', fontSize: '13px', color: '#334155',
          }}>
            <strong style={{ color: '#014F54' }}>🌡 {r.siteName}</strong>
            <span>{r.tempC}°C · RH {r.humidityPct}%</span>
            <span>Heat index <strong>{r.heatIndexC}°C</strong></span>
            <span style={{
              background: b.bg, color: b.text, borderRadius: '12px',
              padding: '2px 10px', fontSize: '11px', fontWeight: 700,
            }}>{b.label.toUpperCase()}</span>
            <span style={{ color: '#64748B' }}>
              observed {new Date(r.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {ageMin > 45 ? ` (${ageMin} min ago)` : ''}
            </span>
            <span title={`tx ${r.txId || '—'}\nsha256 ${r.dataHash}`} style={{
              color: r.verified ? '#028090' : '#B7791F', fontWeight: 600,
            }}>
              {r.verified ? '⛓ ✓ verified on ledger' : '⛓ not verified'}
            </span>
            <span style={{ marginLeft: 'auto', color: '#94A3B8', fontSize: '11px' }}>
              Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" style={{ color: '#94A3B8' }}>Open-Meteo.com</a> (CC BY 4.0)
            </span>
          </div>
        )
      })}
    </div>
  )
}

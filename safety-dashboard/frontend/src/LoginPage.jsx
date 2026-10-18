import { useState } from 'react'
import axios from 'axios'

const API = '/api'

const IDENTITIES = [
  {
    id: 'supervisor1', label: 'Supervisor',
    org: 'IINoT Industry',
    description: 'Acknowledge and resolve safety incidents',
    color: '#028090', icon: '👷'
  },
  {
    id: 'auditor1', label: 'Auditor',
    org: 'IINoT Regulator',
    description: 'Read-only access to incidents and full audit trail',
    color: '#00A896', icon: '🔍'
  },
  {
    id: 'gateway1', label: 'Gateway',
    org: 'IINoT Industry',
    description: 'IoT integration service identity',
    color: '#64748B', icon: '📡'
  }
]

export default function LoginPage({ onLogin }) {
  const [loading, setLoading] = useState(null)
  const [error, setError]     = useState(null)

  async function handleSelect(identity) {
    setLoading(identity)
    setError(null)
    try {
      const res = await axios.post(`${API}/auth/login`, { identity })
      if (res.data.success) onLogin(res.data)
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed — is the backend running?')
    } finally {
      setLoading(null)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#014F54',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: '24px'
    }}>
      <div style={{ marginBottom: '32px', textAlign: 'center' }}>
        <div style={{ fontSize: '48px', marginBottom: '8px' }}>🛡️</div>
        <h1 style={{ color: '#FFFFFF', fontSize: '28px', fontWeight: 700, margin: '0 0 8px' }}>
          IINoT Safety Monitor
        </h1>
        <p style={{ color: '#EAF6F4', fontSize: '14px', margin: 0 }}>
          Select your role to continue
        </p>
      </div>

      <div style={{
        display: 'flex', gap: '16px',
        flexWrap: 'wrap', justifyContent: 'center', maxWidth: '860px'
      }}>
        {IDENTITIES.map(id => (
          <button
            key={id.id}
            onClick={() => handleSelect(id.id)}
            disabled={loading !== null}
            style={{
              background: loading === id.id ? id.color : '#FFFFFF',
              border: `2px solid ${id.color}`,
              borderRadius: '12px', padding: '24px 28px',
              cursor: loading ? 'not-allowed' : 'pointer',
              width: '240px', textAlign: 'left',
              opacity: loading && loading !== id.id ? 0.5 : 1,
              transition: 'all 0.15s'
            }}
          >
            <div style={{ fontSize: '32px', marginBottom: '10px' }}>
              {loading === id.id ? '⏳' : id.icon}
            </div>
            <div style={{
              fontWeight: 700, fontSize: '16px',
              color: loading === id.id ? '#FFFFFF' : '#1E293B',
              marginBottom: '4px'
            }}>
              {id.label}
            </div>
            <div style={{
              fontSize: '12px', fontWeight: 500, marginBottom: '6px',
              color: loading === id.id ? '#EAF6F4' : id.color
            }}>
              {id.org}
            </div>
            <div style={{
              fontSize: '12px',
              color: loading === id.id ? '#EAF6F4' : '#64748B'
            }}>
              {id.description}
            </div>
          </button>
        ))}
      </div>

      {error && (
        <div style={{
          marginTop: '24px', background: '#FBEAE8',
          border: '1px solid #C0392B', borderRadius: '8px',
          padding: '12px 20px', color: '#C0392B',
          fontSize: '13px', maxWidth: '500px', textAlign: 'center'
        }}>
          ⚠️ {error}
        </div>
      )}

      <p style={{ marginTop: '32px', color: '#64748B', fontSize: '12px', textAlign: 'center' }}>
        Identities authenticated via X.509 certificates issued by the IINoT Fabric CA
      </p>
    </div>
  )
}

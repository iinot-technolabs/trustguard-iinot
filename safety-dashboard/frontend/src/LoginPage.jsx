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
  const [loading,       setLoading]       = useState(null)   // identity id being loaded
  const [error,         setError]         = useState(null)
  const [showAdminForm, setShowAdminForm] = useState(false)
  const [adminPassword, setAdminPassword] = useState('')
  const [adminLoading,  setAdminLoading]  = useState(false)
  const [adminError,    setAdminError]    = useState(null)

  // ── Fabric identity login ──────────────────────────────────────────────────
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

  // ── Admin password login ───────────────────────────────────────────────────
  async function handleAdminLogin(e) {
    e.preventDefault()
    setAdminLoading(true)
    setAdminError(null)
    try {
      const res = await axios.post(`${API}/admin/login`, { password: adminPassword })
      if (res.data.success) onLogin(res.data)
    } catch (err) {
      setAdminError(err.response?.data?.error || 'Admin login failed.')
    } finally {
      setAdminLoading(false)
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

      {/* ── Fabric identity cards ────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: '16px',
        flexWrap: 'wrap', justifyContent: 'center', maxWidth: '860px'
      }}>
        {IDENTITIES.map(id => (
          <button
            key={id.id}
            onClick={() => handleSelect(id.id)}
            disabled={loading !== null || showAdminForm}
            style={{
              background: loading === id.id ? id.color : '#FFFFFF',
              border: `2px solid ${id.color}`,
              borderRadius: '12px', padding: '24px 28px',
              cursor: (loading || showAdminForm) ? 'not-allowed' : 'pointer',
              width: '240px', textAlign: 'left',
              opacity: (loading && loading !== id.id) || showAdminForm ? 0.5 : 1,
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

      {/* ── Fabric error ─────────────────────────────────────────────────── */}
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

      {/* ── Admin login section ───────────────────────────────────────────── */}
      <div style={{ marginTop: '36px', textAlign: 'center' }}>
        {!showAdminForm ? (
          <button
            onClick={() => { setShowAdminForm(true); setError(null); }}
            style={{
              background: 'transparent',
              border: '1px solid #02C39A',
              color: '#02C39A',
              borderRadius: '6px',
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            🔧 Admin Login
          </button>
        ) : (
          <div style={{
            background: 'rgba(255,255,255,0.07)',
            border: '1px solid #02C39A',
            borderRadius: '12px',
            padding: '24px 28px',
            width: '320px',
            textAlign: 'left',
          }}>
            <div style={{ color: '#02C39A', fontWeight: 700, fontSize: '15px', marginBottom: '4px' }}>
              🔧 Admin Login
            </div>
            <div style={{ color: '#A0C4BF', fontSize: '12px', marginBottom: '16px' }}>
              Network bootstrap — no enrolled identities required
            </div>

            <form onSubmit={handleAdminLogin}>
              <input
                type="password"
                placeholder="Admin password"
                value={adminPassword}
                onChange={e => setAdminPassword(e.target.value)}
                autoFocus
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  border: '1px solid #CBD5E1',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                  marginBottom: '12px',
                }}
              />

              {adminError && (
                <div style={{
                  marginBottom: '12px',
                  color: '#FF6B6B',
                  fontSize: '12px',
                }}>
                  ⚠️ {adminError}
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="submit"
                  disabled={adminLoading || !adminPassword}
                  style={{
                    flex: 1,
                    background: adminLoading || !adminPassword ? '#CBD5E1' : '#02C39A',
                    color: '#FFFFFF',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '9px 0',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: adminLoading || !adminPassword ? 'not-allowed' : 'pointer',
                  }}
                >
                  {adminLoading ? '⏳ Signing in…' : 'Sign in'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowAdminForm(false); setAdminPassword(''); setAdminError(null); }}
                  style={{
                    background: 'transparent',
                    border: '1px solid #64748B',
                    color: '#A0C4BF',
                    borderRadius: '6px',
                    padding: '9px 14px',
                    cursor: 'pointer',
                    fontSize: '13px',
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      <p style={{ marginTop: '32px', color: '#64748B', fontSize: '12px', textAlign: 'center' }}>
        Identities authenticated via X.509 certificates issued by the IINoT Fabric CA
      </p>
    </div>
  )
}

import { useState } from 'react'
import axios from 'axios'
import { saveSession } from './api'

const API = '/api'

const inputStyle = {
  width: '100%', padding: '11px 12px', borderRadius: '6px',
  border: '1px solid #CBD5E1', fontSize: '14px', boxSizing: 'border-box',
  marginBottom: '12px',
}

export default function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await axios.post(`${API}/auth/login`, { username: username.trim(), password })
      if (res.data.success) {
        saveSession(res.data)
        setPassword('')
        onLogin(res.data)
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed — is the backend running?')
    } finally {
      setLoading(false)
    }
  }

  const disabled = loading || !username.trim() || !password

  return (
    <div style={{
      minHeight: '100vh', background: '#014F54',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: '24px'
    }}>
      <div style={{ marginBottom: '28px', textAlign: 'center' }}>
        <div style={{ fontSize: '48px', marginBottom: '8px' }}>🛡️</div>
        <h1 style={{ color: '#FFFFFF', fontSize: '28px', fontWeight: 700, margin: '0 0 8px' }}>
          IINoT Safety Monitor
        </h1>
        <p style={{ color: '#EAF6F4', fontSize: '14px', margin: 0 }}>
          Sign in to continue
        </p>
      </div>

      <form onSubmit={handleSubmit} style={{
        background: '#FFFFFF', borderRadius: '12px', padding: '28px',
        width: '100%', maxWidth: '360px', boxSizing: 'border-box', textAlign: 'left',
      }}>
        <label style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>Username</label>
        <input
          value={username} onChange={e => setUsername(e.target.value)}
          autoComplete="username" autoFocus style={{ ...inputStyle, marginTop: '6px' }}
        />
        <label style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>Password</label>
        <input
          type="password" value={password} onChange={e => setPassword(e.target.value)}
          autoComplete="current-password" style={{ ...inputStyle, marginTop: '6px' }}
        />

        {error && (
          <div style={{
            marginBottom: '12px', background: '#FBEAE8', border: '1px solid #C0392B',
            borderRadius: '6px', padding: '8px 12px', color: '#C0392B', fontSize: '13px',
          }}>
            ⚠️ {error}
          </div>
        )}

        <button type="submit" disabled={disabled} style={{
          width: '100%', background: disabled ? '#CBD5E1' : '#028090', color: '#FFFFFF',
          border: 'none', borderRadius: '6px', padding: '11px 0', fontWeight: 600,
          fontSize: '14px', cursor: disabled ? 'not-allowed' : 'pointer',
        }}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p style={{ marginTop: '24px', color: '#A0C4BF', fontSize: '12px', textAlign: 'center', maxWidth: '360px' }}>
        Ledger actions are signed with X.509 identities issued by this network's Fabric CAs
      </p>
    </div>
  )
}

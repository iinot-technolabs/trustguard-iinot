import { useState } from 'react'

// Admin landing page — shown when session.role === 'admin'
// Provides quick links to the three bootstrap steps:
//   1. Configure Network  →  parent sets view = 'configure'
//   2. Deploy Network     →  parent sets view = 'deploy'
//   3. Enroll Identities  →  inline action via backend (future)

export default function AdminView({ session, onNavigate }) {
  const [enrollStatus, setEnrollStatus] = useState(null) // null | 'running' | 'done' | 'error'
  const [enrollLog,    setEnrollLog]    = useState([])

  async function handleEnroll() {
    setEnrollStatus('running')
    setEnrollLog(['Starting identity enrollment…'])
    try {
      const res = await fetch('/api/deploy/enroll', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.token}`,
        },
      })
      const data = await res.json()
      if (data.success) {
        setEnrollStatus('done')
        setEnrollLog(prev => [...prev, '✓ Identities enrolled successfully.'])
      } else {
        setEnrollStatus('error')
        setEnrollLog(prev => [...prev, `✗ ${data.error || 'Enrollment failed'}`])
      }
    } catch (err) {
      setEnrollStatus('error')
      setEnrollLog(prev => [...prev, `✗ ${err.message}`])
    }
  }

  const cardStyle = (color) => ({
    background: '#FFFFFF',
    border: `2px solid ${color}`,
    borderRadius: '12px',
    padding: '28px 24px',
    width: '260px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  })

  const btnStyle = (color, disabled) => ({
    marginTop: 'auto',
    background: disabled ? '#CBD5E1' : color,
    color: '#FFFFFF',
    border: 'none',
    borderRadius: '8px',
    padding: '10px 0',
    fontWeight: 600,
    fontSize: '14px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'opacity 0.15s',
  })

  return (
    <div style={{ padding: '40px 32px', maxWidth: '960px', margin: '0 auto' }}>

      {/* Header */}
      <div style={{ marginBottom: '32px' }}>
        <h2 style={{ margin: '0 0 6px', fontSize: '22px', color: '#014F54', fontWeight: 700 }}>
          🔧 Admin — Network Bootstrap
        </h2>
        <p style={{ margin: 0, color: '#64748B', fontSize: '14px' }}>
          Complete these steps in order before any other identities can log in.
        </p>
      </div>

      {/* Step cards */}
      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>

        {/* Step 1 — Configure */}
        <div style={cardStyle('#028090')}>
          <div style={{ fontSize: '32px' }}>⚙️</div>
          <div style={{ fontWeight: 700, fontSize: '16px', color: '#1E293B' }}>
            1 · Configure Network
          </div>
          <div style={{ fontSize: '13px', color: '#64748B', flexGrow: 1 }}>
            Define organisations, domains, ports, channel name, and chaincode settings.
          </div>
          <button
            style={btnStyle('#028090', false)}
            onClick={() => onNavigate('configure')}
          >
            Open Network Designer →
          </button>
        </div>

        {/* Step 2 — Deploy */}
        <div style={cardStyle('#00A896')}>
          <div style={{ fontSize: '32px' }}>🚀</div>
          <div style={{ fontWeight: 700, fontSize: '16px', color: '#1E293B' }}>
            2 · Deploy Network
          </div>
          <div style={{ fontSize: '13px', color: '#64748B', flexGrow: 1 }}>
            Start all Fabric containers, create the channel, and install chaincode.
            Watch the live log to confirm success.
          </div>
          <button
            style={btnStyle('#00A896', false)}
            onClick={() => onNavigate('deploy')}
          >
            Open Deploy →
          </button>
        </div>

        {/* Step 3 — Enroll */}
        <div style={cardStyle('#0077B6')}>
          <div style={{ fontSize: '32px' }}>🪪</div>
          <div style={{ fontWeight: 700, fontSize: '16px', color: '#1E293B' }}>
            3 · Enroll Identities
          </div>
          <div style={{ fontSize: '13px', color: '#64748B', flexGrow: 1 }}>
            Register and enroll <code>supervisor1</code>, <code>auditor1</code>, and{' '}
            <code>gateway1</code> with the Fabric CA so they can log in.
          </div>
          <button
            style={btnStyle('#0077B6', enrollStatus === 'running')}
            onClick={handleEnroll}
            disabled={enrollStatus === 'running'}
          >
            {enrollStatus === 'running' ? '⏳ Enrolling…'
              : enrollStatus === 'done'    ? '✓ Done — Re-enroll'
              : 'Enroll Identities'}
          </button>
        </div>

      </div>

      {/* Enroll log */}
      {enrollLog.length > 0 && (
        <div style={{
          marginTop: '28px',
          background: '#0F1C1C',
          borderRadius: '8px',
          padding: '16px 20px',
          fontFamily: 'monospace',
          fontSize: '13px',
          color: enrollStatus === 'error' ? '#FF6B6B' : '#02C39A',
          maxHeight: '200px',
          overflowY: 'auto',
        }}>
          {enrollLog.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}

      {/* Info footer */}
      <div style={{
        marginTop: '40px',
        padding: '16px 20px',
        background: '#EAF6F4',
        borderRadius: '8px',
        fontSize: '13px',
        color: '#014F54',
        lineHeight: 1.6,
      }}>
        <strong>Note:</strong> The Admin role is purely a bootstrap tool — it has no dependency
        on Fabric certificates or enrolled identities. Once network is deployed and identities
        are enrolled, Supervisor, Auditor, and Gateway users can log in using their own identities.
        The Admin password is set via <code>ADMIN_PASSWORD</code> in the server's <code>.env</code> file.
      </div>

    </div>
  )
}

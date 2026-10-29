import { useState, useEffect, useRef } from 'react'

// Admin landing page (role "admin": no Fabric identity, manages the network).
//   1. Network Designer  → organisations, identities, insurer toggle, endorsement
//   2. Deploy            → builds the network and enrols the app identities into the wallet
//   3. Enroll identities → re-enrol the wallet without redeploying (POST /api/deploy/enroll)
//   4. Dashboard users   → created on the server with scripts/manageUsers.js

export default function AdminView({ onNavigate }) {
  const [net, setNet]       = useState(null)       // /api/network-info, null = not deployed yet
  const [state, setState]   = useState('idle')     // idle | running | done | error
  const [log, setLog]       = useState([])
  const esRef = useRef(null)

  useEffect(() => {
    fetch('/api/network-info').then(r => r.ok ? r.json() : null).then(j => setNet(j?.success ? j : null)).catch(() => {})
    return () => esRef.current?.close()
  }, [])

  async function enroll() {
    setState('running'); setLog(['Enrolling app identities…'])
    const res = await fetch('/api/deploy/enroll', { method: 'POST' }).catch(e => ({ ok: false, json: async () => ({ error: e.message }) }))
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setState('error'); setLog(l => [...l, `✗ ${j.error || (j.problems || []).join('; ') || 'request failed'}`])
      return
    }
    const es = new EventSource('/api/deploy/stream')
    esRef.current = es
    es.addEventListener('log', e => {
      const { line } = JSON.parse(e.data)
      if (/wallet:|app identities|ERROR|error/i.test(line)) setLog(l => [...l, line])
    })
    es.addEventListener('done', e => {
      const { exitCode } = JSON.parse(e.data)
      setState(exitCode === 0 ? 'done' : 'error')
      setLog(l => [...l, exitCode === 0 ? '✓ Identities enrolled.' : `✗ Enrolment failed (exit ${exitCode}); see the Deploy log.`])
      es.close()
    })
  }

  const card = color => ({
    background: '#FFFFFF', border: `2px solid ${color}`, borderRadius: '12px', padding: '24px 20px',
    width: '250px', display: 'flex', flexDirection: 'column', gap: '10px',
  })
  const btn = (color, disabled) => ({
    marginTop: 'auto', background: disabled ? '#CBD5E1' : color, color: '#FFFFFF', border: 'none',
    borderRadius: '8px', padding: '10px 0', fontWeight: 600, fontSize: '14px', cursor: disabled ? 'not-allowed' : 'pointer',
  })
  const code = { background: '#E2E8F0', color: '#0F172A', padding: '1px 5px', borderRadius: '4px', fontSize: '12px' }

  return (
    <div style={{ padding: '40px 32px', maxWidth: '1120px', margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 6px', fontSize: '22px', color: '#014F54', fontWeight: 700 }}>Administration</h2>
      <p style={{ margin: '0 0 24px', color: '#64748B', fontSize: '14px' }}>
        {net
          ? <>Deployed: <strong>{net.network}</strong> · channel <code style={code}>{net.channel}</code> · {net.chaincode} {net.chaincodeVersion} · policy <code style={code}>{net.endorsementPolicy}</code> · {net.orgs.map(o => o.label).join(', ')}</>
          : 'No network deployed yet. Design it, then deploy it.'}
      </p>

      <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap' }}>
        <div style={card('#028090')}>
          <div style={{ fontWeight: 700, fontSize: '16px', color: '#1E293B' }}>1 · Design the network</div>
          <div style={{ fontSize: '13px', color: '#64748B', flexGrow: 1 }}>
            Organisations, domains, ports, channel, identities and their roles, the insurer toggle and who must endorse.
          </div>
          <button style={btn('#028090')} onClick={() => onNavigate('configure')}>Open Network Designer →</button>
        </div>

        <div style={card('#00A896')}>
          <div style={{ fontWeight: 700, fontSize: '16px', color: '#1E293B' }}>2 · Deploy</div>
          <div style={{ fontSize: '13px', color: '#64748B', flexGrow: 1 }}>
            Starts the CAs, orderer and peers, creates the channel, commits the chaincode with the endorsement policy
            and enrols the identities. Fresh installs only.
          </div>
          <button style={btn('#00A896')} onClick={() => onNavigate('deploy')}>Open Deploy →</button>
        </div>

        <div style={card('#0077B6')}>
          <div style={{ fontWeight: 700, fontSize: '16px', color: '#1E293B' }}>3 · Enroll identities</div>
          <div style={{ fontSize: '13px', color: '#64748B', flexGrow: 1 }}>
            Re-enrols the network's app identities into the server wallet{net ? '' : ' (needs a deployed network)'}.
            Deploy already does this; use it if the wallet was cleared.
          </div>
          <button style={btn('#0077B6', state === 'running' || !net)} disabled={state === 'running' || !net} onClick={enroll}>
            {state === 'running' ? 'Enrolling…' : state === 'done' ? '✓ Done — enrol again' : 'Enroll identities'}
          </button>
        </div>

        <div style={card('#64748B')}>
          <div style={{ fontWeight: 700, fontSize: '16px', color: '#1E293B' }}>4 · Dashboard users</div>
          <div style={{ fontSize: '13px', color: '#64748B', flexGrow: 1 }}>
            People log in with their own username and password. On the server, in <code style={code}>safety-dashboard/backend</code>:
            <div style={{ marginTop: '6px', fontFamily: 'monospace', fontSize: '12px', lineHeight: 1.6 }}>
              node scripts/manageUsers.js add <i>name</i> supervisor<br />
              … auditor · claims-reviewer · admin<br />
              node scripts/manageUsers.js list
            </div>
          </div>
        </div>
      </div>

      {log.length > 0 && (
        <div style={{
          marginTop: '24px', background: '#0F1C1C', borderRadius: '8px', padding: '14px 18px',
          fontFamily: 'monospace', fontSize: '13px', color: state === 'error' ? '#FF6B6B' : '#02C39A',
          maxHeight: '220px', overflowY: 'auto',
        }}>
          {log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  )
}

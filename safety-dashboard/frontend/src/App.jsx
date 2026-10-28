import { useState, useEffect } from 'react'

import LoginPage           from './LoginPage'
import SupervisorView      from './SupervisorView'
import AuditorView         from './AuditorView'
import InsurerView         from './InsurerView'
import ConfigureNetworkPage from './ConfigureNetworkPage'
import RulesDesignerPage   from './RulesDesignerPage'
import DeployPage from './DeployPage'
import AdminView from './AdminView'
import { getSession, clearSession } from './api'

// Shared nav-tab style factory
function tabStyle(active) {
  return {
    background: 'transparent',
    border: 'none',
    borderBottom: active ? '2px solid #02C39A' : '2px solid transparent',
    color: active ? '#02C39A' : '#A0C4BF',
    padding: '0 4px',
    height: '56px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 600,
    transition: 'color 0.15s',
  };
}

// ── localStorage helpers (safe — throws silently in private mode) ──
const LS_KEY = 'tg_network_config';

function lsGet() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); }
  catch { return null; }
}
function lsSet(cfg) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }
  catch {}
}
function lsClear() {
  try { localStorage.removeItem(LS_KEY); }
  catch {}
}

export default function App() {
  // Restore a still-valid session after a page refresh (token in sessionStorage)
  const [session, setSession] = useState(() => getSession())
  const [view, setView]       = useState('dashboard')

  // Any 401 from the API (expired or revoked session) returns to the login page
  useEffect(() => {
    const onExpired = () => { setSession(null); setView('dashboard') }
    window.addEventListener('tg-session-expired', onExpired)
    return () => window.removeEventListener('tg-session-expired', onExpired)
  }, [])

  const isAdmin = session?.role === 'admin'

  // Seed from localStorage immediately so the UI isn't blank while the API call resolves
  const [networkConfig, setNetworkConfig] = useState(() => lsGet())

  // After an admin logs in: fetch the canonical config (overwrites stale localStorage).
  // Admin-only on the backend, so other roles keep the localStorage copy.
  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/network-config')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg && typeof cfg === 'object') {
          setNetworkConfig(cfg);
          lsSet(cfg);
        }
      })
      .catch(() => { /* backend not yet up — use localStorage fallback */ });
  }, [isAdmin]);

  // Persist to localStorage whenever networkConfig changes
  useEffect(() => {
    if (networkConfig) {
      lsSet(networkConfig);
      // The Network Designer saves to the server itself (Validate & Save), with validation.
    }
  }, [networkConfig, isAdmin]);

  if (!session) {
    return <LoginPage onLogin={(s) => { setSession(s); setView('dashboard') }} />
  }

  // Called by ConfigureNetworkPage when user previews/generates — we grab the config
  const handleNetworkConfigChange = (cfg) => {
    setNetworkConfig(cfg)
  }

  // Called by RulesDesignerPage when user saves rules
  const handleRulesSave = (rules) => {
    setNetworkConfig(prev => prev
      ? {
          ...prev,
          chaincode: {
            ...(prev.chaincode || {}),
            eventTypes:  rules.eventTypes,
            accessRules: rules.accessRules,
          }
        }
      : null
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#F7FBFA' }}>

      {/* ── Top Navigation ── */}
      <nav style={{
        background: '#014F54', padding: '0 24px', display: 'flex',
        alignItems: 'center', justifyContent: 'space-between', height: '56px',
      }}>
        {/* Left: brand + nav tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '20px' }}>🛡️</span>
            <span style={{ color: '#02C39A', fontWeight: 700, fontSize: '16px', letterSpacing: '0.5px' }}>
              IINoT Safety Monitor
            </span>
          </div>

          {/* Dashboard tab — the admin's is the administration page */}
          <button onClick={() => setView('dashboard')} style={tabStyle(view === 'dashboard')}>
            {isAdmin ? '🏠 Admin' : '📊 Dashboard'}
          </button>

          {/* Network Designer — admin only */}
          {isAdmin && (
            <button onClick={() => setView('configure')} style={tabStyle(view === 'configure')}>
              ⚙️ Network Designer
            </button>
          )}

          {/* Rules Designer — admin only */}
          {isAdmin && (
            <button onClick={() => setView('rules')} style={tabStyle(view === 'rules')}>
              🔐 Rules Designer
            </button>
          )}

          {isAdmin && (
            <button onClick={() => setView('deploy')} style={tabStyle(view === 'deploy')}>
              🚀 Deploy
            </button>
          )}
        </div>

        {/* Right: identity + logout */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{ color: '#EAF6F4', fontSize: '13px' }}>
            Logged in as{' '}
            <strong style={{ color: '#02C39A' }}>{session.username}</strong>{' '}
            ({session.role}{session.identity ? ` · ${session.identity}` : ''})
          </span>
          <button
            onClick={() => { clearSession(); setSession(null); setView('dashboard'); lsClear(); }}
            style={{
              background: 'transparent', border: '1px solid #02C39A',
              color: '#02C39A', borderRadius: '6px', padding: '4px 12px',
              cursor: 'pointer', fontSize: '13px',
            }}
          >
            Logout
          </button>
        </div>
      </nav>

      {/* ── Page Views ── */}

      {view === 'configure' && isAdmin && (
        <ConfigureNetworkPage
          onBack={() => setView('dashboard')}
          onConfigChange={handleNetworkConfigChange}
          initialConfig={networkConfig}
        />
      )}

      {view === 'rules' && isAdmin && (
        <RulesDesignerPage
          networkConfig={networkConfig}
          onBack={() => setView('dashboard')}
          onSave={handleRulesSave}
        />
      )}

      {view === 'deploy' && isAdmin && (
        <DeployPage
          networkConfig={networkConfig}
          onBack={() => setView('dashboard')}
        />
      )}

      {view === 'dashboard' && isAdmin && (
        <AdminView onNavigate={setView} />
      )}

      {view === 'dashboard' && session.role === 'supervisor' && (
        <SupervisorView session={session} />
      )}

      {view === 'dashboard' && session.role === 'auditor' && (
        <AuditorView session={session} />
      )}

      {view === 'dashboard' && session.role === 'claims-reviewer' && (
        <InsurerView session={session} />
      )}


    </div>
  )
}

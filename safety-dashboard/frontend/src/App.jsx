import { useState, useEffect } from 'react'

import LoginPage           from './LoginPage'
import SupervisorView      from './SupervisorView'
import AuditorView         from './AuditorView'
import AdminView           from './AdminView'
import ConfigureNetworkPage from './ConfigureNetworkPage'
import RulesDesignerPage   from './RulesDesignerPage'
import DeployPage from './DeployPage'

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
const LS_KEY = 'iinot_network_config';

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
  const [session, setSession] = useState(null)
  const [view, setView]       = useState('dashboard')

  // Seed from localStorage immediately so the UI isn't blank while the API call resolves
  const [networkConfig, setNetworkConfig] = useState(() => lsGet())

  // On mount: fetch the canonical config from the backend (overwrites stale localStorage)
  useEffect(() => {
    fetch('/api/network-config')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg && typeof cfg === 'object') {
          setNetworkConfig(cfg);
          lsSet(cfg);
        }
      })
      .catch(() => { /* backend not yet up — use localStorage fallback */ });
  }, []);

  // Persist to localStorage whenever networkConfig changes
  useEffect(() => {
    if (networkConfig) {
      lsSet(networkConfig);
      // Also push to backend so it survives a full browser refresh
      fetch('/api/network-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(networkConfig),
      }).catch(() => {});
    }
  }, [networkConfig]);

  if (!session) {
    return <LoginPage onLogin={(s) => { setSession(s); setView('dashboard') }} />
  }

  // Admin: the new dedicated bootstrap role (no Fabric dependency)
  // Supervisor: operational role — can view the dashboard, but NOT the network config / deploy tabs
  const isAdmin = session.role === 'admin'

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

          {/* Dashboard tab — always visible */}
          <button onClick={() => setView('dashboard')} style={tabStyle(view === 'dashboard')}>
            {isAdmin ? '🔧 Admin' : '📊 Dashboard'}
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

          {/* Deploy — admin only */}
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
            <strong style={{ color: '#02C39A' }}>{session.identity}</strong>{' '}
            ({session.role})
          </span>
          <button
            onClick={() => { setSession(null); setView('dashboard'); lsClear(); }}
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

      {/* Admin dashboard — bootstrap guide */}
      {view === 'dashboard' && isAdmin && (
        <AdminView
          session={session}
          onNavigate={(v) => setView(v)}
        />
      )}

      {/* Supervisor dashboard — incident monitoring */}
      {view === 'dashboard' && session.role === 'supervisor' && (
        <SupervisorView session={session} />
      )}

      {view === 'dashboard' && session.role === 'auditor' && (
        <AuditorView session={session} />
      )}

      {view === 'dashboard' && session.role === 'gateway' && (
        <div style={{ padding: '40px', textAlign: 'center', color: '#64748B' }}>
          Gateway identities do not have a dashboard view.
          Use the simulation scripts to submit incidents.
        </div>
      )}

    </div>
  )
}

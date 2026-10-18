import { useState, useEffect, useRef, useCallback } from 'react';
import './DeployPage.css';

// ── Deploy step definitions (matched against log lines) ───────────────────────

// Patterns matched against actual network.sh infoln/successln output
const DEPLOY_STEPS = [
  { id: 'cas',       label: 'Start CAs',           patterns: ['starting ca containers', 'waiting for cas', 'ca.iinot'] },
  { id: 'crypto',    label: 'Identities',           patterns: ['generating cryptographic', 'registerenroll', 'createiinot', 'all identities generated'] },
  { id: 'network',   label: 'Peers & Orderer',      patterns: ['starting peer and orderer', 'peer0.iinot', 'orderer.iinot', 'network is up'] },
  { id: 'channel',   label: 'Channel',              patterns: ['generating genesis', 'configtxgen', 'iinot-safety-channel', 'channel created', 'anchor peer'] },
  { id: 'chaincode', label: 'Chaincode',            patterns: ['packaging chaincode', 'installing chaincode', 'peer lifecycle', 'approved', 'committed', 'safetycc'] },
  { id: 'done',      label: 'Complete',             patterns: ['deployment complete', 'network is ready', 'successln', 'all done'] },
];

function detectStep(line) {
  const lower = line.toLowerCase();
  for (let i = DEPLOY_STEPS.length - 1; i >= 0; i--) {
    if (DEPLOY_STEPS[i].patterns.some(p => lower.includes(p))) return i;
  }
  return -1;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifyLine(line) {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes('fatal') || l.includes('failed')) return 'error';
  if (l.includes('warn'))                                                   return 'warn';
  if (l.startsWith('+'))                                                    return 'cmd';
  return 'info';
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DeployPage({ networkConfig, onBack }) {
  const [status, setStatus]         = useState('idle'); // idle | running | done | error
  const [logs, setLogs]             = useState([]);
  const [currentStep, setCurrentStep] = useState(-1);
  const [startedAt, setStartedAt]   = useState(null);
  const [elapsed, setElapsed]       = useState(0);
  const [exitCode, setExitCode]     = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const termRef    = useRef(null);
  const esRef      = useRef(null);   // EventSource
  const timerRef   = useRef(null);
  const deployedRef = useRef(false); // prevent double-fire in StrictMode

  // ── Elapsed timer ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (status === 'running') {
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [status]);

  // ── Auto-scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (autoScroll && termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // ── Start deploy ───────────────────────────────────────────────────────────
  const startDeploy = useCallback(async () => {
    if (status === 'running') return;

    setStatus('running');
    setLogs([]);
    setCurrentStep(0);
    setElapsed(0);
    setExitCode(null);
    setStartedAt(new Date().toISOString());

    // 1. POST to kick off the process
    try {
      const res = await fetch('/api/deploy', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ networkConfig, mode: 'all' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setLogs(l => [...l, { ts: Date.now(), stream: 'stderr', line: `[error] ${err.error}` }]);
        setStatus('error');
        return;
      }
    } catch (err) {
      setLogs(l => [...l, { ts: Date.now(), stream: 'stderr', line: `[error] ${err.message}` }]);
      setStatus('error');
      return;
    }

    // 2. Open SSE stream
    const es = new EventSource('/api/deploy/stream');
    esRef.current = es;

    es.addEventListener('log', e => {
      const entry = JSON.parse(e.data);
      setLogs(l => [...l, entry]);
      const stepIdx = detectStep(entry.line);
      if (stepIdx >= 0) setCurrentStep(s => Math.max(s, stepIdx));
    });

    es.addEventListener('start', e => {
      const { startedAt: sa } = JSON.parse(e.data);
      setStartedAt(sa);
    });

    es.addEventListener('done', e => {
      const { exitCode: code } = JSON.parse(e.data);
      setExitCode(code);
      setStatus('done');
      setCurrentStep(DEPLOY_STEPS.length - 1); // mark final step
      es.close();
    });

    es.addEventListener('error', e => {
      try {
        const { exitCode: code, message } = JSON.parse(e.data);
        setExitCode(code ?? -1);
        if (message) setLogs(l => [...l, { ts: Date.now(), stream: 'stderr', line: `[spawn error] ${message}` }]);
      } catch (_) {}
      setStatus('error');
      es.close();
    });

    es.onerror = () => {
      // SSE connection dropped — could be normal after 'done' closes it
      if (status === 'running') {
        setLogs(l => [...l, { ts: Date.now(), stream: 'stderr', line: '[connection lost — refreshing status…]' }]);
        es.close();
        // Re-check final status
        fetch('/api/deploy/status').then(r => r.json()).then(s => {
          if (!s.running) {
            setStatus(s.exitCode === 0 ? 'done' : 'error');
            setExitCode(s.exitCode);
          }
        }).catch(() => setStatus('error'));
      }
    };
  }, [networkConfig, status]);

  // ── Cancel ─────────────────────────────────────────────────────────────────
  const cancelDeploy = async () => {
    await fetch('/api/deploy', { method: 'DELETE' }).catch(() => {});
    esRef.current?.close();
    setStatus('error');
    setLogs(l => [...l, { ts: Date.now(), stream: 'stderr', line: '[deployment cancelled by user]' }]);
  };

  // ── Format elapsed ─────────────────────────────────────────────────────────
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="dp-page">
      <button className="dp-back-btn" onClick={onBack}>← Back</button>

      {/* Hero */}
      <div className="dp-hero">
        <h1 className="dp-hero-title">Deploy Network</h1>
        <p className="dp-hero-subtitle">
          Run <code>network.sh all</code> to provision crypto materials, genesis block,
          Docker containers, channel, and chaincode in one step.
        </p>
      </div>

      {/* Step strip */}
      <div className="dp-steps">
        {DEPLOY_STEPS.map((step, i) => {
          const state =
            status === 'idle'                          ? 'pending'
            : i < currentStep                          ? 'done'
            : i === currentStep && status === 'running' ? 'active'
            : i === currentStep && status === 'done'   ? 'done'
            : i === currentStep && status === 'error'  ? 'error'
            : 'pending';
          return (
            <div key={step.id} className={`dp-step dp-step--${state}`}>
              <span className="dp-step-num">
                {state === 'done'  ? '✓'
                 : state === 'error' ? '✗'
                 : i + 1}
              </span>
              <span className="dp-step-label">{step.label}</span>
            </div>
          );
        })}
      </div>

      {/* Status bar */}
      {status !== 'idle' && (
        <div className={`dp-statusbar dp-statusbar--${status}`}>
          <span className="dp-statusbar-icon">
            {status === 'running' && <span className="dp-spinner" />}
            {status === 'done'    && '✓'}
            {status === 'error'   && '✗'}
          </span>
          <span className="dp-statusbar-text">
            {status === 'running' && `Deploying… ${fmt(elapsed)}`}
            {status === 'done'    && `Deployment complete in ${fmt(elapsed)}`}
            {status === 'error'   && `Deployment failed (exit ${exitCode ?? '?'}) after ${fmt(elapsed)}`}
          </span>
          {status === 'running' && (
            <button className="dp-cancel-btn" onClick={cancelDeploy}>Cancel</button>
          )}
        </div>
      )}

      {/* Terminal */}
      <div className="dp-terminal-wrap">
        <div className="dp-terminal-header">
          <span className="dp-terminal-title">
            <span className="dp-term-dot dp-term-dot--red"   />
            <span className="dp-term-dot dp-term-dot--amber" />
            <span className="dp-term-dot dp-term-dot--green" />
            network.sh output
          </span>
          <label className="dp-autoscroll-label">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={e => setAutoScroll(e.target.checked)}
            />
            auto-scroll
          </label>
        </div>

        <div className="dp-terminal" ref={termRef}>
          {logs.length === 0 && status === 'idle' && (
            <span className="dp-term-placeholder">
              Output will appear here once you start the deployment.
            </span>
          )}
          {logs.map((entry, i) => (
            <div key={i} className={`dp-term-line dp-term-line--${classifyLine(entry.line)} dp-term-line--${entry.stream}`}>
              <span className="dp-term-ts">{new Date(entry.ts).toTimeString().slice(0, 8)}</span>
              <span className="dp-term-text">{entry.line}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Action bar */}
      <div className="dp-action-bar">
        <div className="dp-action-info">
          {networkConfig
            ? <>
                <span className="dp-ai-item">
                  <strong>{networkConfig.organizations?.length ?? 0}</strong> orgs
                </span>
                <span className="dp-ai-sep">·</span>
                <span className="dp-ai-item">{networkConfig.channelName}</span>
                <span className="dp-ai-sep">·</span>
                <span className="dp-ai-item">{networkConfig.networkName}</span>
              </>
            : <span className="dp-ai-warn">⚠ No network config — run Network Designer first</span>
          }
        </div>

        <div className="dp-action-btns">
          {status === 'idle' || status === 'done' || status === 'error' ? (
            <button
              className="dp-btn dp-btn--primary"
              onClick={startDeploy}
              disabled={!networkConfig}
            >
              {status === 'idle' ? '▶ Deploy Network' : '↺ Re-deploy'}
            </button>
          ) : (
            <button className="dp-btn dp-btn--primary" disabled>
              <span className="dp-spinner dp-spinner--btn" /> Deploying…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

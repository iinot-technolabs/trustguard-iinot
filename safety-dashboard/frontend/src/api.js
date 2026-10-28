// ─────────────────────────────────────────────────────────────────────────────
// Session + auth header plumbing for every API call (TG-010)
// Imported once from main.jsx. Adds "Authorization: Bearer <token>" to:
//   • axios requests to /api/…        (SupervisorView, AuditorView, LoginPage)
//   • fetch('/api/…') calls          (App, ConfigureNetworkPage, DeployPage)
//   • new EventSource('/api/…')      (DeployPage live log — sent as ?token=)
// A 401 on any call while logged in ends the session and returns to login.
// The token lives in sessionStorage: it survives a page refresh, not a closed tab.
// ─────────────────────────────────────────────────────────────────────────────
import axios from 'axios'

const KEY = 'tg_session'

export function getSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) || 'null')
    if (!s || !s.token || !s.expiresAt || Date.parse(s.expiresAt) <= Date.now()) return null
    return s
  } catch { return null }
}

export function saveSession(s) {
  try { sessionStorage.setItem(KEY, JSON.stringify(s)) } catch { /* private mode */ }
}

export function clearSession() {
  try { sessionStorage.removeItem(KEY) } catch { /* private mode */ }
}

function isApi(url) {
  try { return new URL(String(url), window.location.origin).pathname.startsWith('/api/') }
  catch { return false }
}

function isLoginCall(url) { return String(url).includes('/api/auth/login') }

function sessionExpired() {
  if (!getSession()) return
  clearSession()
  window.dispatchEvent(new Event('tg-session-expired'))
}

// ── axios ───────────────────────────────────────────────────────────────────
axios.interceptors.request.use(cfg => {
  const s = getSession()
  if (s && isApi(cfg.url)) {
    cfg.headers = cfg.headers || {}
    cfg.headers['Authorization'] = `Bearer ${s.token}`
  }
  return cfg
})
axios.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401 && !isLoginCall(err.config?.url)) sessionExpired()
  return Promise.reject(err)
})

// ── fetch ───────────────────────────────────────────────────────────────────
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url
  const s = getSession()
  if (s && isApi(url)) {
    const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined))
    headers.set('Authorization', `Bearer ${s.token}`)
    init = { ...init, headers }
  }
  const res = await nativeFetch(input, init)
  if (res.status === 401 && isApi(url) && !isLoginCall(url)) sessionExpired()
  return res
}

// ── EventSource (cannot send headers, so the token goes in the query) ───────
const NativeES = window.EventSource
if (NativeES) {
  window.EventSource = function (url, opts) {
    const s = getSession()
    if (s && isApi(url)) {
      const u = new URL(String(url), window.location.origin)
      u.searchParams.set('token', s.token)
      url = u.pathname + u.search
    }
    return new NativeES(url, opts)
  }
  window.EventSource.prototype = NativeES.prototype
  Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 })
}

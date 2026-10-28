import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

// Supervisor: which worker wears which beacon, recorded on the ledger (chaincode 1.2, TG-018).
// Insurers look incidents up by worker code, so this is what links a beacon event to a person's claim.
const fmt = ts => ts ? new Date(ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : ''
const localNow = () => { const d = new Date(); d.setSeconds(0, 0); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
const cn = id => (String(id || '').match(/CN=([^/:]+)/) || [])[1] || ''

const input = { padding: '7px 9px', border: '1px solid #CBD5E1', borderRadius: '6px', fontSize: '13px', color: '#0F172A', background: '#FFFFFF' }
const label = { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: '#475569', fontWeight: 600 }

export default function AssignmentsPanel() {
  const [open, setOpen]       = useState(false)
  const [rows, setRows]       = useState(null)
  const [devices, setDevices] = useState([])
  const [form, setForm]       = useState({ workerRef: '', deviceId: '', fromTs: localNow(), toTs: '' })
  const [busy, setBusy]       = useState(false)
  const [msg, setMsg]         = useState(null)

  const load = useCallback(async () => {
    try {
      const [a, d] = await Promise.all([axios.get('/api/workers/assignments'), axios.get('/api/workers/devices')])
      setRows(a.data.assignments || []); setDevices(d.data.devices || [])
    } catch (e) { setRows([]); setMsg({ err: true, text: e.response?.data?.error || e.message }) }
  }, [])
  useEffect(() => { if (open && rows === null) load() }, [open, rows, load])

  async function register(e) {
    e.preventDefault(); setBusy(true); setMsg(null)
    try {
      const body = { workerRef: form.workerRef.trim(), deviceId: form.deviceId.trim(),
        fromTs: form.fromTs ? new Date(form.fromTs).toISOString() : '', toTs: form.toTs ? new Date(form.toTs).toISOString() : '' }
      const r = await axios.post('/api/workers/assignments', body)
      setMsg({ text: `✓ ${r.data.message} — recorded on the ledger` })
      setForm({ workerRef: '', deviceId: '', fromTs: localNow(), toTs: '' }); load()
    } catch (e) { setMsg({ err: true, text: e.response?.data?.error || e.message }) }
    finally { setBusy(false) }
  }

  async function end(a) {
    if (!window.confirm(`End ${a.workerRef}'s use of ${a.deviceId} now?`)) return
    setBusy(true); setMsg(null)
    try {
      await axios.post('/api/workers/assignments/close', { workerRef: a.workerRef, deviceId: a.deviceId, fromTs: a.fromTs })
      setMsg({ text: `✓ ${a.workerRef} / ${a.deviceId} ended` }); load()
    } catch (e) { setMsg({ err: true, text: e.response?.data?.error || e.message }) }
    finally { setBusy(false) }
  }

  const active = (rows || []).filter(a => !a.toTs || Date.parse(a.toTs) > Date.now()).length

  return (
    <div style={{ background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: '10px', marginBottom: '20px', textAlign: 'left' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '12px 16px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '14px', color: '#014F54', fontWeight: 700,
      }}>
        <span>👷 Worker ↔ beacon assignments{rows ? ` · ${active} active` : ''}</span>
        <span style={{ color: '#64748B', fontWeight: 400, fontSize: '12px' }}>{open ? 'Hide ▲' : 'Show ▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 16px 16px' }}>
          <p style={{ fontSize: '12px', color: '#64748B', margin: '0 0 12px', lineHeight: 1.5 }}>
            Record who wears each beacon so insurers can match incidents to a worker's claim.
            Use the employee code, <strong>not the name</strong>: assignments are written to the ledger and cannot be deleted.
          </p>

          <form onSubmit={register} style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end', marginBottom: '12px' }}>
            <label style={label}>Worker code
              <input style={{ ...input, width: '130px' }} value={form.workerRef} required pattern="[A-Za-z0-9._\-]{3,32}"
                placeholder="e.g. EMP-1042" onChange={e => setForm({ ...form, workerRef: e.target.value })} />
            </label>
            <label style={label}>Beacon
              <input style={{ ...input, width: '190px' }} value={form.deviceId} required list="tg-devices"
                placeholder="device id" onChange={e => setForm({ ...form, deviceId: e.target.value })} />
              <datalist id="tg-devices">
                {devices.map(d => <option key={d.deviceId} value={d.deviceId}>{`last event ${fmt(d.lastEventAt)}`}</option>)}
              </datalist>
            </label>
            <label style={label}>From
              <input style={input} type="datetime-local" value={form.fromTs} required onChange={e => setForm({ ...form, fromTs: e.target.value })} />
            </label>
            <label style={label}>Until (optional)
              <input style={input} type="datetime-local" value={form.toTs} onChange={e => setForm({ ...form, toTs: e.target.value })} />
            </label>
            <button type="submit" disabled={busy} style={{
              background: busy ? '#CBD5E1' : '#028090', color: '#FFFFFF', border: 'none', borderRadius: '6px',
              padding: '8px 16px', fontWeight: 600, fontSize: '13px', cursor: busy ? 'wait' : 'pointer',
            }}>{busy ? 'Recording…' : 'Assign'}</button>
          </form>

          {msg && <div style={{ fontSize: '13px', marginBottom: '10px', color: msg.err ? '#C0392B' : '#028090' }}>{msg.text}</div>}

          {rows === null ? <div style={{ fontSize: '13px', color: '#64748B' }}>Loading…</div> :
           rows.length === 0 ? <div style={{ fontSize: '13px', color: '#64748B' }}>No assignments recorded yet.</div> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead><tr style={{ textAlign: 'left', color: '#475569', borderBottom: '1px solid #E2E8F0' }}>
                  {['Worker', 'Beacon', 'From', 'Until', 'Incidents', 'Recorded by', ''].map(h => <th key={h} style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'left' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {rows.map(a => {
                    const isOpen = !a.toTs || Date.parse(a.toTs) > Date.now()
                    return (
                      <tr key={`${a.workerRef}|${a.deviceId}|${a.fromTs}`} style={{ borderBottom: '1px solid #F1F5F9' }}>
                        <td style={{ padding: '6px 8px', fontWeight: 600 }}>{a.workerRef}</td>
                        <td style={{ padding: '6px 8px' }}>{a.deviceId}</td>
                        <td style={{ padding: '6px 8px' }}>{fmt(a.fromTs)}</td>
                        <td style={{ padding: '6px 8px' }}>{a.toTs ? fmt(a.toTs) : <span style={{ color: '#028090', fontWeight: 600 }}>Active</span>}</td>
                        <td style={{ padding: '6px 8px' }}>{a.incidentCount}</td>
                        <td style={{ padding: '6px 8px', color: '#64748B' }}>{cn(a.registeredBy)}</td>
                        <td style={{ padding: '6px 8px' }}>
                          {!a.toTs && isOpen && (
                            <button onClick={() => end(a)} disabled={busy} style={{
                              background: '#FFFFFF', color: '#C0392B', border: '1px solid #F5C6C0', borderRadius: '6px',
                              padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
                            }}>End now</button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

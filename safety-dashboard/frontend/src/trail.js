// Labels for the immutable audit trail (GetIncidentHistory, newest first).
// Every ledger entry is a full copy of the incident, so a status alone repeats after resolve
// (reportability and Form 18 are later writes on a RESOLVED incident). Compare each entry
// with the one before it and name what actually changed.
export function trailLabel(entries, i) {
  const cur = entries[i]?.value || {}
  const prev = entries[i + 1]?.value
  if (entries[i]?.isDelete) return 'DELETED'
  if (!prev) return cur.status || 'CREATED'
  const n = a => (Array.isArray(a) ? a.length : 0)
  if (n(cur.statutoryReports) > n(prev.statutoryReports)) {
    const r = cur.statutoryReports[cur.statutoryReports.length - 1] || {}
    return `${(r.reportType || 'REPORT').replace('FORM18', 'FORM 18')} RECORDED`
  }
  if (cur.status !== prev.status) {
    if (cur.status === 'ESCALATED') return `ESCALATED · L${cur.escalationLevel || 1}`
    if (cur.status === 'RESOLVED' && cur.outcome) return `RESOLVED · ${String(cur.outcome).replace('_', ' ')}`
    return cur.status || 'UPDATED'
  }
  if ((cur.escalationLevel || 0) > (prev.escalationLevel || 0)) return `ESCALATED · L${cur.escalationLevel}`
  if (n(cur.reportabilityHistory) > n(prev.reportabilityHistory) || cur.reportability?.decision !== prev.reportability?.decision) {
    return cur.reportability?.decision === 'NOT_REPORTABLE' ? 'MARKED NOT REPORTABLE' : 'MARKED REPORTABLE'
  }
  if (cur.outcome !== prev.outcome) return `OUTCOME · ${String(cur.outcome).replace('_', ' ')}`
  return `${cur.status || 'UPDATED'} (updated)`
}

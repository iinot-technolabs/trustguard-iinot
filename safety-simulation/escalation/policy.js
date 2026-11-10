'use strict';
// Escalation decisions (TG-016) — pure functions, no I/O, unit-tested.
const OPEN = ['TRIGGERED', 'ESCALATED'];

// Next escalation step for an incident, or null. One level per call, so the ledger
// shows every level as its own transaction even if the service was down for a while.
function nextStep(inc, nowMs, policy, sinceMs) {
  if (!inc || !OPEN.includes(inc.status)) return null;
  const t = Date.parse(inc.timestamp);
  if (!Number.isFinite(t) || t < sinceMs) return null;
  const ageMin = (nowMs - t) / 60000;
  if (ageMin > policy.maxAgeHours * 60) return null;
  const current = inc.escalationLevel || 0;
  const step = policy.levels.find(l => l.level === current + 1);
  if (!step || ageMin < step.afterMinutes) return null;
  if (step.minRisk != null && !(Number(inc.riskScore) >= step.minRisk)) return null;
  return step;
}

// Should we announce this incident as new?
function isNewAlert(inc, nowMs, policy, sinceMs) {
  if (!inc || inc.status !== 'TRIGGERED') return false;
  const t = Date.parse(inc.timestamp);
  return Number.isFinite(t) && t >= sinceMs && (nowMs - t) / 60000 <= policy.notifyNewWithinMinutes;
}

// Levels in force: the escalation levels stored in the network rules on the ledger (chaincode 1.4,
// Rules Designer) when there are any, otherwise policy.json. Timings come from the rules (the chaincode
// refuses an automatic escalation before its time); the reason text and who is notified stay in
// policy.json, matched by level number (a level beyond policy.json uses the last one's groups).
function effectivePolicy(policy, ledgerRules) {
  const levels = ledgerRules && ledgerRules.escalation && ledgerRules.escalation.levels;
  if (!levels || !levels.length) return { ...policy, source: 'policy.json' };
  const fmt = m => (m % 60 === 0 && m >= 60 ? `${m / 60} h` : `${m} min`);
  const merged = levels.map(l => {
    const p = policy.levels.find(x => x.level === l.level) || policy.levels[policy.levels.length - 1] || { notify: ['supervisors'] };
    const reason = p.level === l.level && p.afterMinutes === l.afterMinutes && p.reason
      ? p.reason : `Unacknowledged for ${fmt(l.afterMinutes)} (escalation level ${l.level}, network rules v${ledgerRules.version})`;
    return { level: l.level, afterMinutes: l.afterMinutes, ...(l.minRisk !== undefined ? { minRisk: l.minRisk } : {}), reason, notify: p.notify || ['supervisors'] };
  });
  return { ...policy, levels: merged, source: `network rules v${ledgerRules.version}` };
}

module.exports = { nextStep, isNewAlert, effectivePolicy, OPEN };

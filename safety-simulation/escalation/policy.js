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

module.exports = { nextStep, isNewAlert, OPEN };

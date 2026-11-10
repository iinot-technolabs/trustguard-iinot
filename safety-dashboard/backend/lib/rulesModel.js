'use strict';
/**
 * rulesModel.js — Rules Designer rules (TG-028, chaincode safetycc 1.4).
 *
 * The saved rules live in network-config.json under "rules":
 *   { "eventTypes": [{ "name": "SOS", "riskScore": 10, "statutory": "..." }],
 *     "access": { "<group>": ["supervisor"] | ["any"] } }
 * The chaincode stores them on the ledger (SetRules) and enforces them: access rules narrow the
 * built-in roles per function group; event types classify incidents (severity, statutory
 * reference, risk floor = score × 10). The groups come from the chaincode's own ruleGroups.js.
 */
const { RULE_GROUPS, EVENT_NAME, severityOf, checkPolicyParts, DEFAULT_ESCALATION, DEFAULT_TARGETS, DEFAULT_REPORT_TYPES } =
  require('../../../safety-chaincode/lib/ruleGroups');
const { ConfigError } = require('./networkModel');

// Event types the beacons and gateway send today (ttnGateway.js wake reasons 2/3/4). The floors
// (score × 10) are at or below the risk model's base scores (SOS 80, FALL 75, INACTIVITY 55), so the
// defaults classify without changing today's risk scores; raise a score to make the chaincode lift it.
const DEFAULT_EVENT_TYPES = [
  { name: 'SOS',        riskScore: 8,  statutory: 'Factories Act 1948 s.88 (notice of accident)' },
  { name: 'FALL',       riskScore: 7,  statutory: 'Factories Act 1948 s.88 (notice of accident)' },
  { name: 'INACTIVITY', riskScore: 5,  statutory: '' },
];

// Dashboard screens that call each group: removing a role there shows "Access denied" on that screen
const USED_BY = {
  listAllIncidents:   { supervisor: 'supervisor incident list', auditor: 'auditor incident list' },
  incidentHistory:    { auditor: 'auditor audit trail', supervisor: 'supervisor audit trail', 'claims-reviewer': 'insurer audit trail' },
  claimsQueries:      { 'claims-reviewer': 'insurer Claims Evidence', supervisor: 'worker assignments panel' },
  complianceScore:    { supervisor: 'supervisor compliance card', auditor: 'auditor compliance card' },
  acknowledge:        { supervisor: 'supervisor Acknowledge button' },
  resolve:            { supervisor: 'supervisor Resolve button' },
  statutoryReporting: { supervisor: 'Form 18 panel' },
  logIncident:        { gateway: 'gateway service (beacon alarms would not be recorded)' },
  escalate:           { gateway: 'escalation service' },
  oracleData:         { oracle: 'weather oracle service' },
};

// Older Rules Designer saves keyed access by function name and role attribute
const LEGACY_FN = { LogIncident: 'logIncident', UpdateIncidentStatus: 'acknowledge',
                    GetAllIncidents: 'listAllIncidents', GetIncidentHistory: 'incidentHistory' };

function networkRoles(model) {
  return [...new Set(model.orgs.flatMap(o => o.users.map(u => u.role)))];
}

// Defaults = today's behaviour: escalation levels as in escalation/policy.json, the 1.3 response targets, Form 18.
function defaultRules() {
  return { eventTypes: DEFAULT_EVENT_TYPES.map(e => ({ ...e })), access: {},
           escalation: { levels: DEFAULT_ESCALATION.map(l => ({ ...l })) }, targets: { ...DEFAULT_TARGETS },
           reportTypes: DEFAULT_REPORT_TYPES.map(r => ({ ...r })) };
}

/** Saved rules from before escalation/targets/report types existed: show the defaults for the missing parts. */
function withDefaults(rules) {
  const d = defaultRules();
  return { ...rules, escalation: rules.escalation || d.escalation, targets: rules.targets || d.targets,
           reportTypes: rules.reportTypes || d.reportTypes };
}

/**
 * The rules to show/edit: saved ones, else (migrate=true, the Rules Designer only) the older
 * chaincode.eventTypes/accessRules for review, else defaults. Deploy never uses unsaved legacy data.
 */
function savedOrDefault(cfg, { migrate = true } = {}) {
  if (cfg && cfg.rules && typeof cfg.rules === 'object') return { rules: migrate ? withDefaults(cfg.rules) : cfg.rules, saved: true };
  if (!migrate) return { rules: defaultRules(), saved: false };
  const cc = (cfg && cfg.chaincode) || {};
  const legacyTypes = Array.isArray(cc.eventTypes) && cc.eventTypes.length && typeof cc.eventTypes[0] === 'object' ? cc.eventTypes : null;
  const legacyAccess = cc.accessRules && Object.keys(cc.accessRules).length ? cc.accessRules : null;
  if (legacyTypes || legacyAccess) {
    const access = {};
    for (const [fn, roles] of Object.entries(legacyAccess || {})) {
      const g = LEGACY_FN[fn]; if (!g || !Array.isArray(roles) || !roles.length) continue;
      access[g] = roles.map(r => String(r).replace(/^role[.=]/, '').replace(/:ecert$/, ''));
    }
    return { rules: withDefaults({ eventTypes: legacyTypes || defaultRules().eventTypes, access }), saved: false, migrated: true };
  }
  return { rules: defaultRules(), saved: false };
}

/**
 * Validate rules against the network model. Returns { rules, ledger, warnings }:
 *   rules  = the normalised object to save in network-config.json
 *   ledger = the JSON payload for SetRules (adds adminMsps = the endorsing organisations)
 */
function normalizeRules(input, model) {
  const problems = [], warnings = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigError(['rules must be an object']);
  const present = networkRoles(model);

  const eventTypes = [];
  (Array.isArray(input.eventTypes) ? input.eventTypes : []).forEach((e, i) => {
    const where = `event type ${i + 1}`;
    const name = String((e && e.name) || '').trim();
    if (!EVENT_NAME.test(name)) { problems.push(`${where}: name '${name}' must be 1-32 letters, digits, _ or -, starting with a letter`); return; }
    const score = Number(e.riskScore);
    if (!Number.isInteger(score) || score < 1 || score > 10) problems.push(`${name}: risk score must be a whole number from 1 to 10`);
    const statutory = String(e.statutory || '').trim();
    if (statutory.length > 120) problems.push(`${name}: statutory reference is longer than 120 characters`);
    if (eventTypes.some(x => x.name.toUpperCase() === name.toUpperCase())) problems.push(`${name}: listed twice`);
    eventTypes.push({ name, riskScore: score, statutory });
  });
  if (eventTypes.length > 50) problems.push('at most 50 event types');

  const access = {};
  for (const [group, roles] of Object.entries(input.access || {})) {
    const def = RULE_GROUPS[group];
    if (!def) { problems.push(`unknown function group '${group}'`); continue; }
    if (!Array.isArray(roles) || !roles.length) { problems.push(`${def.label}: choose at least one role, or "any"`); continue; }
    const list = [...new Set(roles.map(String))];
    if (list.includes('any')) {
      if (list.length > 1) problems.push(`${def.label}: "any" cannot be combined with specific roles`);
      continue;   // "any" = built-in roles; nothing to store
    }
    const beyond = list.filter(r => !def.builtin.includes(r));
    if (beyond.length) problems.push(`${def.label}: ${beyond.join(', ')} can never be allowed (at most: ${def.builtin.join(', ')})`);
    const missing = list.filter(r => !present.includes(r));
    if (missing.length) warnings.push(`${def.label}: no identity in this network has role ${missing.join(', ')}`);
    if (!list.some(r => present.includes(r))) warnings.push(`${def.label}: nobody in this network will be able to do this`);
    for (const r of def.builtin.filter(x => present.includes(x) && !list.includes(x))) {
      if (USED_BY[group] && USED_BY[group][r]) warnings.push(`${def.label}: the ${USED_BY[group][r]} will show "Access denied"`);
    }
    access[group] = list;
  }
  const parts = checkPolicyParts(input);          // escalation levels, response targets, report types (same checks as the chaincode)
  problems.push(...parts.problems);
  if (parts.value.reportTypes && !parts.value.reportTypes.some(r => r.code === 'FORM18')) {
    warnings.push('Form 18 is not in the report types: the dashboard\'s Form 18 form will be refused; supervisors attach the filed form of another type instead');
  }
  if (parts.value.escalation) {
    const last = parts.value.escalation.levels[parts.value.escalation.levels.length - 1];
    if (last.level < 3) warnings.push(`Automatic escalation stops at level ${last.level}; the escalation service only notifies the groups of the levels it reaches`);
  }
  if (problems.length) throw new ConfigError(problems);

  const adminMsps = model.orgs.filter(o => o.endorses).map(o => o.mspId);
  const rules = { eventTypes, access, ...parts.value };
  return { rules, ledger: { ...rules, adminMsps }, warnings };
}

function groupsForUi(model) {
  const present = model ? networkRoles(model) : [];
  return Object.entries(RULE_GROUPS).map(([id, g]) => ({ id, label: g.label, builtin: g.builtin,
    available: g.builtin.filter(r => present.includes(r)) }));
}

module.exports = { DEFAULT_EVENT_TYPES, DEFAULT_REPORT_TYPES, defaultRules, withDefaults, savedOrDefault, normalizeRules, groupsForUi, networkRoles, severityOf, RULE_GROUPS };

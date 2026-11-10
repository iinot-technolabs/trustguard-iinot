'use strict';
// Rule groups shared by the chaincode (enforcement) and the dashboard (Rules Designer, validation).
// No dependencies, so the backend can require this file directly (TG-028, safetycc 1.4).
//   builtin = the most any network rule can allow for that group; a rule only narrows it.
const RULE_GROUPS = {
    logIncident:        { label: 'Log incidents',                  builtin: ['gateway'] },
    acknowledge:        { label: 'Acknowledge / update status',    builtin: ['supervisor'] },
    resolve:            { label: 'Resolve with outcome',           builtin: ['supervisor'] },
    escalate:           { label: 'Escalate',                       builtin: ['gateway', 'supervisor'] },
    oracleData:         { label: 'Submit oracle readings',         builtin: ['oracle'] },
    workerAssignments:  { label: 'Worker-beacon assignments',      builtin: ['supervisor'] },
    statutoryReporting: { label: 'Reportability and Form 18',      builtin: ['supervisor'] },
    listAllIncidents:   { label: 'List all incidents',             builtin: ['supervisor', 'auditor'] },
    incidentHistory:    { label: 'Incident audit trail',           builtin: ['auditor', 'supervisor', 'claims-reviewer'] },
    claimsQueries:      { label: 'Incidents by worker / beacon',   builtin: ['supervisor', 'auditor', 'claims-reviewer'] },
    complianceScore:    { label: 'Compliance score',               builtin: ['supervisor', 'auditor'] },
};
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const REPORT_CODE = /^[A-Z][A-Z0-9_-]{1,23}$/;

// Built-in behaviour when the rules leave a part out (the same values as safetycc 1.3):
//   automatic escalation levels (escalation service), response targets (compliance score),
//   statutory report types with their filing deadlines (RecordStatutoryReport, compliance score).
const DEFAULT_ESCALATION = [
    { level: 1, afterMinutes: 5 },
    { level: 2, afterMinutes: 15 },
    { level: 3, afterMinutes: 240, minRisk: 90 },
];
const DEFAULT_TARGETS = { ackMinutes: 5, resolveHours: 24 };
const DEFAULT_REPORT_TYPES = [{ code: 'FORM18', name: 'Form 18: notice of accident (Factories Act 1948 s.88)', deadlineHours: 12 }];

// Shared validation of the escalation / targets / report-type parts. Returns { value, problems }.
function checkPolicyParts(input) {
    const problems = [], out = {};
    const int = (v, lo, hi) => Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi;
    if (input.escalation !== undefined && input.escalation !== null) {
        const levels = Array.isArray(input.escalation.levels) ? input.escalation.levels : null;
        if (!levels || levels.length < 1 || levels.length > 5) problems.push('escalation: 1 to 5 levels');
        else {
            const clean = [];
            levels.forEach((l, i) => {
                const where = `escalation level ${i + 1}`;
                if (!int(l.afterMinutes, 1, 10080)) problems.push(`${where}: minutes must be a whole number from 1 to 10080 (7 days)`);
                if (i > 0 && Number(l.afterMinutes) <= Number(levels[i - 1].afterMinutes)) problems.push(`${where}: must come later than level ${i}`);
                const e = { level: i + 1, afterMinutes: Number(l.afterMinutes) };
                if (l.minRisk !== undefined && l.minRisk !== null && l.minRisk !== '') {
                    if (!int(l.minRisk, 0, 100)) problems.push(`${where}: minimum risk must be 0–100`); else e.minRisk = Number(l.minRisk);
                }
                clean.push(e);
            });
            out.escalation = { levels: clean };
        }
    }
    if (input.targets !== undefined && input.targets !== null) {
        const t = input.targets;
        if (!int(t.ackMinutes, 1, 1440)) problems.push('targets: acknowledge within must be 1–1440 minutes');
        if (!int(t.resolveHours, 1, 720)) problems.push('targets: resolve within must be 1–720 hours');
        out.targets = { ackMinutes: Number(t.ackMinutes), resolveHours: Number(t.resolveHours) };
    }
    if (input.reportTypes !== undefined && input.reportTypes !== null) {
        const list = Array.isArray(input.reportTypes) ? input.reportTypes : null;
        if (!list || list.length < 1 || list.length > 10) problems.push('report types: 1 to 10');
        else {
            out.reportTypes = [];
            list.forEach((r, i) => {
                const code = String((r && r.code) || '').trim().toUpperCase();
                const name = String((r && r.name) || '').trim();
                if (!REPORT_CODE.test(code)) problems.push(`report type ${i + 1}: code '${code}' must be 2-24 capital letters, digits, _ or -`);
                if (!name || name.length > 80) problems.push(`report type ${code || i + 1}: name must be 1-80 characters`);
                if (!int(r && r.deadlineHours, 1, 720)) problems.push(`report type ${code || i + 1}: deadline must be 1–720 hours`);
                if (out.reportTypes.some(x => x.code === code)) problems.push(`report type ${code}: listed twice`);
                out.reportTypes.push({ code, name, deadlineHours: Number(r && r.deadlineHours) });
            });
        }
    }
    return { value: out, problems };
}

// The policy in force: rules where set, built-in values otherwise.
function policyOf(rules) {
    return {
        escalation: (rules && rules.escalation && rules.escalation.levels) || DEFAULT_ESCALATION,
        escalationFromRules: !!(rules && rules.escalation),
        targets: (rules && rules.targets) || DEFAULT_TARGETS,
        reportTypes: (rules && rules.reportTypes) || DEFAULT_REPORT_TYPES,
    };
}
const severityOf = score => (score >= 9 ? 'CRITICAL' : score >= 7 ? 'HIGH' : score >= 4 ? 'MEDIUM' : 'LOW');

module.exports = { RULE_GROUPS, EVENT_NAME, REPORT_CODE, severityOf, DEFAULT_ESCALATION, DEFAULT_TARGETS, DEFAULT_REPORT_TYPES, checkPolicyParts, policyOf };

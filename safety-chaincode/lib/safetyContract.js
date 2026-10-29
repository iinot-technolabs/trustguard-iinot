'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// safetycc 1.3 — TrustGuard IIoT safety contract (TG-013 1.1, TG-017 1.2, TG-021 1.3)
//
// Compatibility: every 1.0 function keeps its exact signature (Fabric rejects
// calls with a different argument count), so the gateway, dashboard and
// simulation scripts keep working unchanged. New behaviour is in new functions:
//   ResolveIncident        supervisor resolves with an outcome tag (AI training label)
//   EscalateIncident       automation/supervisor escalates an unacknowledged incident
//   SubmitOracleData       oracle identity anchors an external reading (hash-verified)
//   GetOracleReading       read one oracle reading
//   LogIncidentWithContext gateway logs an incident with risk-model + oracle references
// 1.2 (insurer org, TG-017):
//   RegisterWorkerAssignment / CloseWorkerAssignment   supervisor links a pseudonymous worker
//                          code (e.g. W-0042) to a beacon for a period — names stay off-chain
//   GetIncidentsByWorker   incidents of one worker inside that worker's assignment windows
//   GetIncidentsByDevice   incidents of one beacon in a time window
//   claims-reviewer (insurer) no longer gets GetAllIncidents — data minimisation
// 1.3 (statutory reporting + compliance, TG-021):
//   SetReportability       supervisor: REPORTABLE / NOT_REPORTABLE (+ reason) for Form 18
//   RecordStatutoryReport  supervisor: SHA-256 + time of the filed Form 18 (personal data off-chain)
//   GetComplianceScore     supervisor/auditor: 0-100 per site from response, escalation,
//                          resolution and Form 18 timeliness — computed on any member's peer
//
// Rules added in 1.1:
//   • riskScore must be a number 0–100; eventHash must be 64-char hex SHA-256
//   • status changes follow a state machine (no edits after RESOLVED)
//   • chaincode stays deterministic: every timestamp is passed in by the client
// ─────────────────────────────────────────────────────────────────────────────
const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

const OUTCOMES = ['GENUINE', 'FALSE_ALARM', 'NEAR_MISS'];
const WORKER_REF = /^[A-Za-z0-9._-]{3,32}$/;     // pseudonymous code, never a name
const READ_ROLES = ['supervisor', 'auditor', 'claims-reviewer'];
const REPORT_TYPES = ['FORM18'];
const REPORT_DECISIONS = ['REPORTABLE', 'NOT_REPORTABLE'];
const REPORT_DEADLINE_MS = { FORM18: 12 * 3600 * 1000 };   // Rule 96: written notice within 12 h

// from-status → allowed next statuses
const TRANSITIONS = {
    TRIGGERED:    ['ACKNOWLEDGED', 'ESCALATED', 'RESOLVED'],
    ESCALATED:    ['ACKNOWLEDGED', 'ESCALATED', 'RESOLVED'],
    ACKNOWLEDGED: ['RESOLVED'],
    RESOLVED:     [],
};

class SafetyContract extends Contract {

    async InitLedger(ctx) {
        console.info('Safety ledger initialised');
        return;
    }

    // ── Incident creation ────────────────────────────────────────────────────

    // 1.0 signature, unchanged. Only the IoT gateway identity (role=gateway) may log incidents.
    async LogIncident(ctx, incidentId, deviceId, eventType, eventHash, timestamp, riskScore) {
        return this._logIncident(ctx, { incidentId, deviceId, eventType, eventHash, timestamp, riskScore });
    }

    // 1.1: same as LogIncident plus a JSON context string:
    //   { "modelVersion": "risk-v1", "featureHash": "<sha256>", "oracleRef": "<siteId>|<readingId>",
    //     "factors": { "heatIndex": 41.2, ... } }   (all optional; factors ≤ 2 KB)
    async LogIncidentWithContext(ctx, incidentId, deviceId, eventType, eventHash, timestamp, riskScore, contextJson) {
        let context;
        try { context = JSON.parse(contextJson || '{}'); }
        catch { throw new Error('contextJson is not valid JSON'); }
        if (typeof context !== 'object' || Array.isArray(context) || context === null) {
            throw new Error('contextJson must be a JSON object');
        }
        const risk = {};
        if (context.modelVersion !== undefined) risk.modelVersion = this._str(context.modelVersion, 'modelVersion', 64);
        if (context.featureHash !== undefined)  risk.featureHash  = this._sha256Hex(context.featureHash, 'featureHash');
        if (context.factors !== undefined) {
            if (JSON.stringify(context.factors).length > 2048) throw new Error('factors exceed 2 KB');
            risk.factors = context.factors;
        }
        if (context.oracleRef !== undefined) {
            const [siteId, readingId] = String(context.oracleRef).split('|');
            const key = ctx.stub.createCompositeKey('oracleReading', [siteId || '', readingId || '']);
            const data = await ctx.stub.getState(key);
            if (!data || data.length === 0) throw new Error(`oracleRef ${context.oracleRef} not found on ledger`);
            risk.oracleRef = String(context.oracleRef);
        }
        return this._logIncident(ctx, { incidentId, deviceId, eventType, eventHash, timestamp, riskScore, risk });
    }

    // ── Status changes ───────────────────────────────────────────────────────

    // 1.0 signature, unchanged. Supervisor moves an incident to ACKNOWLEDGED or RESOLVED.
    // updatedAt is passed in so all endorsing peers compute the same record.
    async UpdateIncidentStatus(ctx, incidentId, newStatus, updatedAt) {
        this._requireRole(ctx, ['supervisor'], 'update incident status');
        const validStatuses = ['ACKNOWLEDGED', 'RESOLVED'];
        if (!validStatuses.includes(newStatus)) {
            throw new Error(`Invalid status '${newStatus}'. Must be ACKNOWLEDGED or RESOLVED`);
        }
        const incident = await this._getIncident(ctx, incidentId);
        this._checkTransition(incident, newStatus);
        this._isoTime(updatedAt, 'updatedAt');

        incident.status    = newStatus;
        incident.updatedBy = ctx.clientIdentity.getID();
        incident.updatedAt = updatedAt;
        if (newStatus === 'ACKNOWLEDGED') incident.acknowledgedAt = updatedAt;

        await this._put(ctx, incident);
        ctx.stub.setEvent('IncidentUpdated', Buffer.from(JSON.stringify({ incidentId, newStatus })));
        return JSON.stringify(incident);
    }

    // 1.1: supervisor resolves with an outcome tag — the label for the AI risk model.
    //   outcome: GENUINE | FALSE_ALARM | NEAR_MISS     notes: free text ≤ 500 chars (may be empty)
    async ResolveIncident(ctx, incidentId, outcome, notes, resolvedAt) {
        this._requireRole(ctx, ['supervisor'], 'resolve incidents');
        if (!OUTCOMES.includes(outcome)) {
            throw new Error(`Invalid outcome '${outcome}'. Must be one of ${OUTCOMES.join(', ')}`);
        }
        const incident = await this._getIncident(ctx, incidentId);
        this._checkTransition(incident, 'RESOLVED');
        this._isoTime(resolvedAt, 'resolvedAt');

        incident.status          = 'RESOLVED';
        incident.outcome         = outcome;
        incident.resolutionNotes = this._str(notes || '', 'notes', 500, true);
        incident.resolvedAt      = resolvedAt;
        incident.updatedBy       = ctx.clientIdentity.getID();
        incident.updatedAt       = resolvedAt;

        await this._put(ctx, incident);
        ctx.stub.setEvent('IncidentUpdated', Buffer.from(JSON.stringify({ incidentId, newStatus: 'RESOLVED', outcome })));
        return JSON.stringify(incident);
    }

    // 1.1: escalate an incident nobody has acknowledged. Called by the escalation
    // service (gateway identity) or a supervisor. Repeat calls raise the level.
    async EscalateIncident(ctx, incidentId, reason, escalatedAt) {
        this._requireRole(ctx, ['gateway', 'supervisor'], 'escalate incidents');
        const incident = await this._getIncident(ctx, incidentId);
        this._checkTransition(incident, 'ESCALATED');
        this._isoTime(escalatedAt, 'escalatedAt');

        incident.status           = 'ESCALATED';
        incident.escalationLevel  = (incident.escalationLevel || 0) + 1;
        incident.escalationReason = this._str(reason, 'reason', 200);
        incident.escalatedAt      = escalatedAt;
        incident.updatedBy        = ctx.clientIdentity.getID();
        incident.updatedAt        = escalatedAt;

        await this._put(ctx, incident);
        ctx.stub.setEvent('IncidentEscalated', Buffer.from(JSON.stringify({
            incidentId, level: incident.escalationLevel, reason: incident.escalationReason,
        })));
        return JSON.stringify(incident);
    }

    // ── Oracle ───────────────────────────────────────────────────────────────

    // 1.1: oracle identity (role=oracle) anchors one external reading, e.g. weather
    // for a site. The chaincode recomputes SHA-256 of dataJson and rejects it if it
    // does not match dataHash, so the stored reading is exactly what was fetched.
    async SubmitOracleData(ctx, siteId, readingId, source, observedAt, dataHash, dataJson) {
        this._requireRole(ctx, ['oracle'], 'submit oracle data');
        this._str(siteId, 'siteId', 64);
        this._str(readingId, 'readingId', 64);
        this._isoTime(observedAt, 'observedAt');
        if (!dataJson || dataJson.length > 4096) throw new Error('dataJson must be 1–4096 characters');
        let data;
        try { data = JSON.parse(dataJson); } catch { throw new Error('dataJson is not valid JSON'); }
        const computed = crypto.createHash('sha256').update(dataJson).digest('hex');
        if (computed !== this._sha256Hex(dataHash, 'dataHash')) {
            throw new Error('dataHash does not match SHA-256 of dataJson');
        }
        const key = ctx.stub.createCompositeKey('oracleReading', [siteId, readingId]);
        const existing = await ctx.stub.getState(key);
        if (existing && existing.length > 0) throw new Error(`Oracle reading ${siteId}|${readingId} already exists`);

        const reading = {
            docType: 'oracleReading', siteId, readingId,
            source: this._str(source, 'source', 128),
            observedAt, dataHash, data,
            submittedBy: ctx.clientIdentity.getID(),
        };
        await ctx.stub.putState(key, Buffer.from(JSON.stringify(reading)));
        ctx.stub.setEvent('OracleDataSubmitted', Buffer.from(JSON.stringify({ siteId, readingId, observedAt })));
        return JSON.stringify(reading);
    }

    async GetOracleReading(ctx, siteId, readingId) {
        const key = ctx.stub.createCompositeKey('oracleReading', [siteId, readingId]);
        const data = await ctx.stub.getState(key);
        if (!data || data.length === 0) throw new Error(`Oracle reading ${siteId}|${readingId} does not exist`);
        return data.toString();
    }

    // ── Reads (1.0 signatures and access rules, unchanged) ───────────────────

    // Any authenticated identity may read a single incident
    async GetIncident(ctx, incidentId) {
        const incident = await this._getIncident(ctx, incidentId);
        return JSON.stringify(incident);
    }

    // Supervisor and auditor see everything; the insurer (claims-reviewer) uses the
    // worker/device queries below so it only sees what a claim needs (1.2).
    async GetAllIncidents(ctx) {
        this._requireRole(ctx, ['supervisor', 'auditor'], 'list all incidents');
        return JSON.stringify(await this._allIncidents(ctx));
    }

    // ── Worker assignments + insurer queries (1.2) ───────────────────────────

    async RegisterWorkerAssignment(ctx, workerRef, deviceId, fromTs, toTs) {
        this._requireRole(ctx, ['supervisor'], 'register worker assignments');
        if (!WORKER_REF.test(workerRef || '')) throw new Error('workerRef must be a 3-32 character code (letters, digits, . _ -), not a name');
        this._str(deviceId, 'deviceId', 64);
        this._isoTime(fromTs, 'fromTs');
        if (toTs) { this._isoTime(toTs, 'toTs'); if (Date.parse(toTs) <= Date.parse(fromTs)) throw new Error('toTs must be after fromTs'); }
        // A beacon is worn by one worker at a time
        for (const a of await this._assignments(ctx, 'deviceAssignment', [deviceId])) {
            if (this._overlaps(a.fromTs, a.toTs, fromTs, toTs)) {
                throw new Error(`${deviceId} is already assigned to ${a.workerRef} from ${a.fromTs}${a.toTs ? ' to ' + a.toTs : ''}`);
            }
        }
        const a = { docType: 'workerAssignment', workerRef, deviceId, fromTs, toTs: toTs || null,
                    registeredBy: ctx.clientIdentity.getID() };
        await this._putAssignment(ctx, a);
        ctx.stub.setEvent('WorkerAssigned', Buffer.from(JSON.stringify({ workerRef, deviceId, fromTs })));
        return JSON.stringify(a);
    }

    async CloseWorkerAssignment(ctx, workerRef, deviceId, fromTs, toTs) {
        this._requireRole(ctx, ['supervisor'], 'close worker assignments');
        this._isoTime(toTs, 'toTs');
        const key = ctx.stub.createCompositeKey('workerAssignment', [workerRef, deviceId, fromTs]);
        const data = await ctx.stub.getState(key);
        if (!data || data.length === 0) throw new Error(`No assignment ${workerRef} / ${deviceId} from ${fromTs}`);
        const a = JSON.parse(data.toString());
        if (a.toTs) throw new Error('Assignment is already closed');
        if (Date.parse(toTs) <= Date.parse(a.fromTs)) throw new Error('toTs must be after fromTs');
        a.toTs = toTs; a.closedBy = ctx.clientIdentity.getID();
        await this._putAssignment(ctx, a);
        return JSON.stringify(a);
    }

    // Incidents raised by the beacons a worker wore, only inside the wearing periods.
    async GetIncidentsByWorker(ctx, workerRef, fromTs, toTs) {
        this._requireRole(ctx, READ_ROLES, 'query incidents by worker');
        if (!WORKER_REF.test(workerRef || '')) throw new Error('invalid workerRef');
        if (fromTs) this._isoTime(fromTs, 'fromTs');
        if (toTs) this._isoTime(toTs, 'toTs');
        const assignments = await this._assignments(ctx, 'workerAssignment', [workerRef]);
        const all = assignments.length ? await this._allIncidents(ctx) : [];
        const incidents = all.filter(i => assignments.some(a => a.deviceId === i.deviceId
            && this._inWindow(i.timestamp, a.fromTs, a.toTs) && this._inWindow(i.timestamp, fromTs || null, toTs || null)));
        return JSON.stringify({ workerRef, assignments, incidents });
    }

    async GetIncidentsByDevice(ctx, deviceId, fromTs, toTs) {
        this._requireRole(ctx, READ_ROLES, 'query incidents by device');
        if (fromTs) this._isoTime(fromTs, 'fromTs');
        if (toTs) this._isoTime(toTs, 'toTs');
        const all = await this._allIncidents(ctx);
        return JSON.stringify(all.filter(i => i.deviceId === deviceId && this._inWindow(i.timestamp, fromTs || null, toTs || null)));
    }

    // ── Statutory reporting (1.3) ────────────────────────────────────────────
    // Factories Act s.88 / Rule 96: accidents causing death or bodily injury and dangerous
    // occurrences need a Form 18 to the Inspector of Factories within 12 h. The personal
    // particulars (name, age, injuries…) stay off-chain; the ledger records the decision,
    // the SHA-256 of the completed report and when it was filed, so timeliness is provable.

    // decision: REPORTABLE | NOT_REPORTABLE (reason required — visible to the regulator)
    async SetReportability(ctx, incidentId, decision, reason, decidedAt) {
        this._requireRole(ctx, ['supervisor'], 'decide reportability');
        if (!REPORT_DECISIONS.includes(decision)) throw new Error(`decision must be one of ${REPORT_DECISIONS.join(', ')}`);
        const why = this._str(reason || '', 'reason', 300, decision === 'REPORTABLE');
        this._isoTime(decidedAt, 'decidedAt');
        const incident = await this._getIncident(ctx, incidentId);
        if (decision === 'NOT_REPORTABLE' && (incident.statutoryReports || []).length) {
            throw new Error(`${incidentId} already has a filed report; it cannot be marked not reportable`);
        }
        const entry = { decision, reason: why, decidedAt, decidedBy: ctx.clientIdentity.getID() };
        incident.reportability = entry;
        incident.reportabilityHistory = [...(incident.reportabilityHistory || []), entry];
        await this._put(ctx, incident);
        ctx.stub.setEvent('ReportabilitySet', Buffer.from(JSON.stringify({ incidentId, decision })));
        return JSON.stringify(incident);
    }

    // reportType: FORM18 (Annexure-I later). Re-filing (correction) appends a new version.
    async RecordStatutoryReport(ctx, incidentId, reportType, reportHash, reportedAt) {
        this._requireRole(ctx, ['supervisor'], 'record statutory reports');
        if (!REPORT_TYPES.includes(reportType)) throw new Error(`reportType must be one of ${REPORT_TYPES.join(', ')}`);
        this._sha256Hex(reportHash, 'reportHash');
        this._isoTime(reportedAt, 'reportedAt');
        const incident = await this._getIncident(ctx, incidentId);
        if (Date.parse(reportedAt) < Date.parse(incident.timestamp)) throw new Error('reportedAt is before the incident');
        const reports = incident.statutoryReports || [];
        const version = reports.filter(r => r.reportType === reportType).length + 1;
        reports.push({ reportType, version, reportHash, reportedAt, reportedBy: ctx.clientIdentity.getID(),
                       withinDeadline: Date.parse(reportedAt) - Date.parse(incident.timestamp) <= REPORT_DEADLINE_MS[reportType] });
        incident.statutoryReports = reports;
        if (!incident.reportability || incident.reportability.decision !== 'REPORTABLE') {
            const entry = { decision: 'REPORTABLE', reason: `${reportType} filed`, decidedAt: reportedAt, decidedBy: ctx.clientIdentity.getID() };
            incident.reportability = entry;
            incident.reportabilityHistory = [...(incident.reportabilityHistory || []), entry];
        }
        await this._put(ctx, incident);
        ctx.stub.setEvent('StatutoryReportRecorded', Buffer.from(JSON.stringify({ incidentId, reportType, version, reportHash })));
        return JSON.stringify(incident);
    }

    // ── Compliance score (1.3) ───────────────────────────────────────────────
    // Read-only: any member peer (the regulator's included) computes the same score from the
    // same ledger. asOfTs is passed in so the result is deterministic; incidents still inside
    // a metric's time limit are left out of that metric until the limit has passed.
    //   acknowledged ≤ 5 min (40) · never escalated past L1 (20) · resolved with outcome ≤ 24 h (20)
    //   reportable incidents with Form 18 ≤ 12 h (20). Reportable = marked REPORTABLE, or outcome
    //   GENUINE not marked NOT_REPORTABLE. Metrics with no eligible incidents are skipped and the
    //   remaining weights rescaled. Site = the oracle site the gateway attached ('unassigned' if none).
    async GetComplianceScore(ctx, fromTs, toTs, asOfTs) {
        this._requireRole(ctx, ['supervisor', 'auditor'], 'view the compliance score');
        if (fromTs) this._isoTime(fromTs, 'fromTs');
        if (toTs) this._isoTime(toTs, 'toTs');
        this._isoTime(asOfTs, 'asOfTs');
        const asOf = Date.parse(asOfTs);
        const all = (await this._allIncidents(ctx)).filter(i => this._inWindow(i.timestamp, fromTs || null, toTs || null)
            && Date.parse(i.timestamp) <= asOf);
        const bySite = {};
        for (const i of all) {
            const site = (i.risk && i.risk.oracleRef && String(i.risk.oracleRef).split('|')[0]) || 'unassigned';
            (bySite[site] = bySite[site] || []).push(i);
        }
        const sites = Object.keys(bySite).sort().map(site => ({ site, ...this._score(bySite[site], asOf) }));
        return JSON.stringify({ fromTs: fromTs || null, toTs: toTs || null, asOfTs, model: 'compliance-v1',
                                overall: this._score(all, asOf), sites });
    }

    // Full audit history for a single incident (immutable ledger trail)
    async GetIncidentHistory(ctx, incidentId) {
        this._requireRole(ctx, ['auditor', 'supervisor', 'claims-reviewer'], 'view incident history');
        const iterator = await ctx.stub.getHistoryForKey(incidentId);
        const history  = [];
        let result     = await iterator.next();
        while (!result.done) {
            history.push({
                txId:      result.value.txId,
                timestamp: result.value.timestamp,
                isDelete:  result.value.isDelete,
                value:     JSON.parse(result.value.value.toString('utf8')),
            });
            result = await iterator.next();
        }
        await iterator.close();
        return JSON.stringify(history);
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    async _allIncidents(ctx) {
        const results = [];
        const iterator = await ctx.stub.getStateByRange('', '');
        let result = await iterator.next();
        while (!result.done) {
            try {
                const record = JSON.parse(result.value.value.toString('utf8'));
                if (record.docType === 'incident') results.push(record);
            } catch (err) { /* skip non-JSON entries */ }
            result = await iterator.next();
        }
        await iterator.close();
        return results;
    }

    async _putAssignment(ctx, a) {
        const buf = Buffer.from(JSON.stringify(a));
        await ctx.stub.putState(ctx.stub.createCompositeKey('workerAssignment', [a.workerRef, a.deviceId, a.fromTs]), buf);
        await ctx.stub.putState(ctx.stub.createCompositeKey('deviceAssignment', [a.deviceId, a.fromTs]), buf);
    }

    async _assignments(ctx, type, attrs) {
        const out = [];
        const it = await ctx.stub.getStateByPartialCompositeKey(type, attrs);
        let r = await it.next();
        while (!r.done) { out.push(JSON.parse(r.value.value.toString('utf8'))); r = await it.next(); }
        await it.close();
        return out;
    }

    _inWindow(ts, from, to) {
        const t = Date.parse(ts);
        return (!from || t >= Date.parse(from)) && (!to || t < Date.parse(to));
    }

    _overlaps(aFrom, aTo, bFrom, bTo) {
        const end = x => (x ? Date.parse(x) : Infinity);
        return Date.parse(aFrom) < end(bTo) && Date.parse(bFrom) < end(aTo);
    }

    async _logIncident(ctx, f) {
        this._requireRole(ctx, ['gateway'], 'log incidents');
        this._str(f.incidentId, 'incidentId', 64);
        this._str(f.deviceId, 'deviceId', 64);
        this._str(f.eventType, 'eventType', 32);
        this._sha256Hex(f.eventHash, 'eventHash');
        this._isoTime(f.timestamp, 'timestamp');
        const score = Number(f.riskScore);
        if (String(f.riskScore).trim() === '' || !Number.isFinite(score) || score < 0 || score > 100) {
            throw new Error(`riskScore must be a number from 0 to 100, got '${f.riskScore}'`);
        }
        if (await this._exists(ctx, f.incidentId)) {
            throw new Error(`Incident ${f.incidentId} already exists`);
        }
        const clientId = ctx.clientIdentity;
        const incident = {
            docType:    'incident',
            incidentId: f.incidentId,
            deviceId:   f.deviceId,
            eventType:  f.eventType,   // FALL | INACTIVITY | SOS (or rule-designer types)
            eventHash:  f.eventHash,   // SHA-256 of raw payload (full payload stored off-chain)
            timestamp:  f.timestamp,
            riskScore:  String(f.riskScore),   // kept as a string, as in 1.0
            status:     'TRIGGERED',
            createdBy:  clientId.getID(),
            updatedBy:  null,
            updatedAt:  null,
        };
        if (f.risk && Object.keys(f.risk).length) incident.risk = f.risk;

        await this._put(ctx, incident);
        ctx.stub.setEvent('IncidentLogged', Buffer.from(JSON.stringify({
            incidentId: f.incidentId, eventType: f.eventType, riskScore: incident.riskScore,
        })));
        return JSON.stringify(incident);
    }

    _score(incidents, asOf) {
        const MIN = 60000, ts = i => Date.parse(i.timestamp);
        const t = v => (v ? Date.parse(v) : null);
        const responded = i => {
            const c = [t(i.acknowledgedAt), t(i.resolvedAt), i.status === 'RESOLVED' ? t(i.updatedAt) : null].filter(x => x !== null);
            return c.length ? Math.min(...c) : null;
        };
        const reportable = i => (i.reportability ? i.reportability.decision === 'REPORTABLE' : i.outcome === 'GENUINE');
        const metric = (key, label, weight, limitMs, eligible, ok) => {
            const due = incidents.filter(i => ts(i) + limitMs <= asOf && eligible(i));
            const failed = due.filter(i => !ok(i));
            return { key, label, weight, eligible: due.length, met: due.length - failed.length,
                     rate: due.length ? Math.round(1000 * (due.length - failed.length) / due.length) / 10 : null,
                     failedIds: failed.slice(0, 50).map(i => i.incidentId) };
        };
        const metrics = [
            metric('ack5', 'Acknowledged within 5 min', 40, 5 * MIN, () => true,
                   i => { const r = responded(i); return r !== null && r - ts(i) <= 5 * MIN; }),
            metric('noEscalation', 'Never escalated past L1', 20, 15 * MIN, () => true,
                   i => (i.escalationLevel || 0) < 2),
            metric('resolved24', 'Resolved with outcome within 24 h', 20, 24 * 60 * MIN, () => true,
                   i => !!i.outcome && t(i.resolvedAt) !== null && t(i.resolvedAt) - ts(i) <= 24 * 60 * MIN),
            metric('form18', 'Form 18 filed within 12 h', 20, REPORT_DEADLINE_MS.FORM18, reportable,
                   i => (i.statutoryReports || []).some(r => r.reportType === 'FORM18' && t(r.reportedAt) - ts(i) <= REPORT_DEADLINE_MS.FORM18)),
        ];
        const used = metrics.filter(m => m.rate !== null);
        const w = used.reduce((a, m) => a + m.weight, 0);
        const score = w ? Math.round(used.reduce((a, m) => a + m.weight * m.rate, 0) / w) : null;
        const pending = incidents.filter(i => reportable(i) && !(i.statutoryReports || []).some(r => r.reportType === 'FORM18')
                                              && ts(i) + REPORT_DEADLINE_MS.FORM18 > asOf).map(i => i.incidentId);
        return { score, grade: score === null ? 'N/A' : score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D',
                 incidents: incidents.length, metrics, form18DueSoon: pending.slice(0, 50) };
    }

    _requireRole(ctx, roles, action) {
        const role = ctx.clientIdentity.getAttributeValue('role');
        if (!roles.includes(role)) throw new Error(`Access denied: role '${role}' cannot ${action}`);
        return role;
    }

    _checkTransition(incident, next) {
        const current = incident.status || 'TRIGGERED';
        const allowed = TRANSITIONS[current] || [];
        if (!allowed.includes(next)) {
            throw new Error(`Incident ${incident.incidentId} is ${current}; cannot change to ${next}`);
        }
    }

    _str(v, name, max, allowEmpty = false) {
        if (typeof v !== 'string' || (!allowEmpty && v.trim() === '') || v.length > max) {
            throw new Error(`${name} must be a ${allowEmpty ? '' : 'non-empty '}string of at most ${max} characters`);
        }
        return v;
    }

    _sha256Hex(v, name) {
        if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) {
            throw new Error(`${name} must be a 64-character lowercase hex SHA-256`);
        }
        return v;
    }

    _isoTime(v, name) {
        if (typeof v !== 'string' || v.length > 40 || Number.isNaN(Date.parse(v))) {
            throw new Error(`${name} must be an ISO-8601 timestamp`);
        }
        return v;
    }

    async _put(ctx, incident) {
        await ctx.stub.putState(incident.incidentId, Buffer.from(JSON.stringify(incident)));
    }

    async _exists(ctx, incidentId) {
        const data = await ctx.stub.getState(incidentId);
        return data && data.length > 0;
    }

    async _getIncident(ctx, incidentId) {
        const data = await ctx.stub.getState(incidentId);
        if (!data || data.length === 0) {
            throw new Error(`Incident ${incidentId} does not exist`);
        }
        return JSON.parse(data.toString());
    }
}

module.exports = SafetyContract;

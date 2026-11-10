const assert = require('assert'); const crypto = require('crypto');
// Run: node test/safetyContract.test.js   (from the safety-chaincode folder, after npm install)
const New = require('../lib/safetyContract');
// Argument counts of the 1.0 functions — must never change (Fabric rejects other counts)
const V1_ARG_COUNTS = { InitLedger: 1, LogIncident: 7, UpdateIncidentStatus: 4, GetIncident: 2, GetAllIncidents: 1, GetIncidentHistory: 2, _exists: 2, _getIncident: 2,
  // 1.1 functions — also frozen once deployed
  ResolveIncident: 5, EscalateIncident: 4, SubmitOracleData: 7, GetOracleReading: 3, LogIncidentWithContext: 8,
  // 1.2 functions — frozen
  RegisterWorkerAssignment: 5, CloseWorkerAssignment: 5, GetIncidentsByWorker: 4, GetIncidentsByDevice: 4,
  // 1.3 functions — frozen once deployed
  SetReportability: 5, RecordStatutoryReport: 5, GetComplianceScore: 4,
  // 1.4 functions — frozen once deployed
  SetRules: 3, GetRules: 1, GetRulesHistory: 1 };
const h = s => crypto.createHash('sha256').update(s).digest('hex');
const state = new Map(), hist = new Map(); let events = [];
const ctxFor = role => ({
  clientIdentity: { getAttributeValue: () => role, getID: () => `x509::CN=${role}1` },
  stub: {
    async getState(k) { return state.has(k) ? Buffer.from(state.get(k)) : Buffer.alloc(0); },
    async putState(k, v) { state.set(k, v.toString()); (hist.get(k) || hist.set(k, []).get(k)).push(v.toString()); },
    createCompositeKey(t, a) { return '\u0000' + t + '\u0000' + a.join('\u0000') + '\u0000'; },
    async getStateByPartialCompositeKey(t, a) { const pre = '\u0000' + t + '\u0000' + a.map(x => x + '\u0000').join('');
      const it = [...state.entries()].filter(([k]) => k.startsWith(pre)).sort().map(([k, v]) => ({ key: k, value: Buffer.from(v) })); let i = 0;
      return { async next() { return i < it.length ? { done: false, value: it[i++] } : { done: true }; }, async close() {} }; },
    setEvent(n, p) { events.push([n, JSON.parse(p.toString())]); },
    async getStateByRange() { const it = [...state.entries()].filter(([k]) => !k.startsWith('\u0000')).map(([k, v]) => ({ value: { key: k, value: Buffer.from(v) } })); let i = 0; return { async next() { return i < it.length ? { done: false, value: it[i++].value } : { done: true }; }, async close() {} }; },
    async getHistoryForKey(k) { const it = (hist.get(k) || []).map((v, i) => ({ txId: 'tx' + i, timestamp: {}, isDelete: false, value: Buffer.from(v) })); let i = 0; return { async next() { return i < it.length ? { done: false, value: it[i++] } : { done: true }; }, async close() {} }; },
  } });
const c = new New(); let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log('  ✓', name); };
const bad = async (name, fn, re) => { await assert.rejects(fn, re); pass++; console.log('  ✓', name); };
(async () => {
  // signature compatibility with 1.0
  for (const [f, n] of Object.entries(V1_ARG_COUNTS))
    assert.strictEqual(New.prototype[f].length, n, `${f} arg count changed`);
  console.log('  ✓ all 1.0 functions keep their argument counts'); pass++;
  const G = ctxFor('gateway'), S = ctxFor('supervisor'), A = ctxFor('auditor'), O = ctxFor('oracle');
  const T = '2026-10-08T06:19:54.612593889+00:00', H = h('payload');
  await ok('LogIncident (1.0 args, ChirpStack ns timestamp)', () => c.LogIncident(G, 'CS-1', 'loneworker-1', 'SOS', H, T, '95'));
  await bad('duplicate incident rejected', () => c.LogIncident(G, 'CS-1', 'd', 'SOS', H, T, '95'), /already exists/);
  await bad('supervisor cannot log', () => c.LogIncident(S, 'CS-2', 'd', 'SOS', H, T, '95'), /Access denied/);
  for (const r of ['101', '-1', 'abc', '', 'NaN']) await bad(`riskScore '${r}' rejected`, () => c.LogIncident(G, 'CS-R' + r, 'd', 'SOS', H, T, r), /riskScore/);
  await bad('bad eventHash rejected', () => c.LogIncident(G, 'CS-3', 'd', 'SOS', 'xyz', T, '95'), /eventHash/);
  await bad('bad timestamp rejected', () => c.LogIncident(G, 'CS-4', 'd', 'SOS', H, 'yesterday', '95'), /timestamp/);
  await ok('ACK then RESOLVED via 1.0 UpdateIncidentStatus (simulateEvent.js path)', async () => {
    await c.UpdateIncidentStatus(S, 'CS-1', 'ACKNOWLEDGED', '2026-10-25T10:00:00Z');
    const r = JSON.parse(await c.UpdateIncidentStatus(S, 'CS-1', 'RESOLVED', '2026-10-25T10:05:00Z'));
    assert.strictEqual(r.status, 'RESOLVED'); assert.strictEqual(r.acknowledgedAt, '2026-10-25T10:00:00Z'); });
  await bad('no change after RESOLVED', () => c.UpdateIncidentStatus(S, 'CS-1', 'ACKNOWLEDGED', '2026-10-25T10:06:00Z'), /is RESOLVED/);
  await bad('auditor cannot update', () => c.UpdateIncidentStatus(A, 'CS-1', 'RESOLVED', '2026-10-25T10:06:00Z'), /Access denied/);
  await c.LogIncident(G, 'CS-5', 'loneworker-2', 'FALL', H, T, '85');
  await bad('ACKNOWLEDGED -> ACKNOWLEDGED rejected', async () => { await c.UpdateIncidentStatus(S, 'CS-5', 'ACKNOWLEDGED', '2026-10-25T10:00:00Z'); await c.UpdateIncidentStatus(S, 'CS-5', 'ACKNOWLEDGED', '2026-10-25T10:01:00Z'); }, /cannot change to ACKNOWLEDGED/);
  await bad('invalid outcome rejected', () => c.ResolveIncident(S, 'CS-5', 'MAYBE', '', '2026-10-25T10:02:00Z'), /Invalid outcome/);
  await bad('notes > 500 rejected', () => c.ResolveIncident(S, 'CS-5', 'GENUINE', 'x'.repeat(501), '2026-10-25T10:02:00Z'), /notes/);
  await ok('ResolveIncident with outcome', async () => { const r = JSON.parse(await c.ResolveIncident(S, 'CS-5', 'FALSE_ALARM', 'Button pressed while charging', '2026-10-25T10:02:00Z')); assert.strictEqual(r.outcome, 'FALSE_ALARM'); assert.strictEqual(r.status, 'RESOLVED'); });
  await c.LogIncident(G, 'CS-6', 'loneworker-3', 'INACTIVITY', H, T, '70');
  await bad('auditor cannot escalate', () => c.EscalateIncident(A, 'CS-6', 'unack 5 min', '2026-10-25T10:05:00Z'), /Access denied/);
  await ok('escalate twice raises level, then ACK, then resolve', async () => {
    await c.EscalateIncident(G, 'CS-6', 'Unacknowledged for 5 min', '2026-10-25T10:05:00Z');
    const r = JSON.parse(await c.EscalateIncident(G, 'CS-6', 'Unacknowledged for 10 min', '2026-10-25T10:10:00Z'));
    assert.strictEqual(r.escalationLevel, 2); assert.strictEqual(r.status, 'ESCALATED');
    await c.UpdateIncidentStatus(S, 'CS-6', 'ACKNOWLEDGED', '2026-10-25T10:11:00Z');
    await c.ResolveIncident(S, 'CS-6', 'GENUINE', '', '2026-10-25T10:20:00Z'); });
  await bad('cannot escalate an acknowledged incident', async () => { await c.LogIncident(G, 'CS-7', 'd', 'SOS', H, T, '95'); await c.UpdateIncidentStatus(S, 'CS-7', 'ACKNOWLEDGED', '2026-10-25T10:00:00Z'); await c.EscalateIncident(G, 'CS-7', 'late', '2026-10-25T10:06:00Z'); }, /cannot change to ESCALATED/);
  const data = JSON.stringify({ tempC: 34.1, humidity: 68, heatIndexC: 43.0 });
  await bad('gateway cannot submit oracle data', () => c.SubmitOracleData(G, 'kakinada-01', 'r1', 'open-meteo', '2026-10-25T10:00:00Z', h(data), data), /Access denied/);
  await bad('oracle hash mismatch rejected', () => c.SubmitOracleData(O, 'kakinada-01', 'r1', 'open-meteo', '2026-10-25T10:00:00Z', h('other'), data), /does not match/);
  await ok('SubmitOracleData + GetOracleReading', async () => { await c.SubmitOracleData(O, 'kakinada-01', 'r1', 'open-meteo', '2026-10-25T10:00:00Z', h(data), data); assert.strictEqual(JSON.parse(await c.GetOracleReading(A, 'kakinada-01', 'r1')).data.heatIndexC, 43.0); });
  await bad('duplicate oracle reading rejected', () => c.SubmitOracleData(O, 'kakinada-01', 'r1', 'open-meteo', '2026-10-25T10:00:00Z', h(data), data), /already exists/);
  await ok('LogIncidentWithContext links oracle + model', async () => { const r = JSON.parse(await c.LogIncidentWithContext(G, 'CS-8', 'loneworker-1', 'INACTIVITY', H, T, '88', JSON.stringify({ modelVersion: 'risk-v1', featureHash: h('f'), oracleRef: 'kakinada-01|r1', factors: { heatIndexC: 43 } }))); assert.strictEqual(r.risk.oracleRef, 'kakinada-01|r1'); });
  await bad('unknown oracleRef rejected', () => c.LogIncidentWithContext(G, 'CS-9', 'd', 'SOS', H, T, '95', JSON.stringify({ oracleRef: 'nowhere|r9' })), /not found/);
  await ok('GetAllIncidents returns incidents only (oracle readings excluded)', async () => { const all = JSON.parse(await c.GetAllIncidents(A)); assert(all.every(i => i.docType === 'incident')); assert.strictEqual(all.length, 5); });
  await bad('gateway cannot list all', () => c.GetAllIncidents(G), /Access denied/);
  await ok('history shows every change', async () => { const hst = JSON.parse(await c.GetIncidentHistory(A, 'CS-6')); assert.strictEqual(hst.length, 5); });
  await ok('1.0-era record (no new fields) still readable and resolvable', async () => {
    state.set('INC-OLD', JSON.stringify({ docType: 'incident', incidentId: 'INC-OLD', deviceId: 'DEV-BEACON-001', eventType: 'SOS', eventHash: H, timestamp: T, riskScore: '95', status: 'ACKNOWLEDGED', createdBy: 'x', updatedBy: 'y', updatedAt: T }));
    await c.ResolveIncident(S, 'INC-OLD', 'NEAR_MISS', '', '2026-10-25T11:00:00Z'); });
  // ── 1.2: worker assignments + insurer queries ──
  const C = ctxFor('claims-reviewer');
  await bad('insurer cannot list all incidents (1.2)', () => c.GetAllIncidents(C), /Access denied/);
  await bad('name as workerRef rejected', () => c.RegisterWorkerAssignment(S, 'Ravi Kumar', 'loneworker-1', '2026-10-01T00:00:00Z', ''), /not a name/);
  await bad('only supervisor registers assignments', () => c.RegisterWorkerAssignment(A, 'W-0042', 'loneworker-1', '2026-10-01T00:00:00Z', ''), /Access denied/);
  await ok('assign W-0042 to loneworker-1 for 1–10 Oct', () => c.RegisterWorkerAssignment(S, 'W-0042', 'loneworker-1', '2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z'));
  await bad('overlapping assignment of the same beacon rejected', () => c.RegisterWorkerAssignment(S, 'W-0077', 'loneworker-1', '2026-10-05T00:00:00Z', ''), /already assigned to W-0042/);
  await ok('assign W-0077 to loneworker-1 from 10 Oct (open-ended, no overlap)', () => c.RegisterWorkerAssignment(S, 'W-0077', 'loneworker-1', '2026-10-10T00:00:00Z', ''));
  await ok('assign W-0042 to loneworker-2 from 20 Oct (open)', () => c.RegisterWorkerAssignment(S, 'W-0042', 'loneworker-2', '2026-10-20T00:00:00Z', ''));
  await c.LogIncident(G, 'W1', 'loneworker-1', 'FALL', H, '2026-10-05T09:00:00Z', '85');   // W-0042 period
  await c.LogIncident(G, 'W2', 'loneworker-1', 'SOS', H, '2026-10-12T09:00:00Z', '95');    // W-0077 period
  await c.LogIncident(G, 'W3', 'loneworker-2', 'SOS', H, '2026-10-21T09:00:00Z', '95');    // W-0042 period
  await c.LogIncident(G, 'W4', 'loneworker-2', 'SOS', H, '2026-10-15T09:00:00Z', '95');    // before W-0042 had it
  await ok('insurer: W-0042 sees its 1–10 Oct incidents on loneworker-1 (CS-1, CS-8, W1) + W3', async () => {
    const r = JSON.parse(await c.GetIncidentsByWorker(C, 'W-0042', '', ''));
    assert.deepStrictEqual(r.incidents.map(i => i.incidentId).sort(), ['CS-1', 'CS-8', 'W1', 'W3']); assert.strictEqual(r.assignments.length, 2); });
  await ok('insurer: W-0042 with a claim window (20–31 Oct) sees only W3', async () => {
    const r = JSON.parse(await c.GetIncidentsByWorker(C, 'W-0042', '2026-10-20T00:00:00Z', '2026-11-01T00:00:00Z'));
    assert.deepStrictEqual(r.incidents.map(i => i.incidentId), ['W3']); });
  await ok('W-0077 sees only W2 (not W-0042\'s FALL on the same beacon)', async () => {
    const r = JSON.parse(await c.GetIncidentsByWorker(C, 'W-0077', '', '')); assert.deepStrictEqual(r.incidents.map(i => i.incidentId), ['W2']); });
  await ok('close W-0077 assignment on 13 Oct; later incidents no longer count', async () => {
    await c.CloseWorkerAssignment(S, 'W-0077', 'loneworker-1', '2026-10-10T00:00:00Z', '2026-10-13T00:00:00Z');
    await c.LogIncident(G, 'W5', 'loneworker-1', 'SOS', H, '2026-10-14T09:00:00Z', '95');
    const r = JSON.parse(await c.GetIncidentsByWorker(C, 'W-0077', '', '')); assert.deepStrictEqual(r.incidents.map(i => i.incidentId), ['W2']); });
  await ok('GetIncidentsByDevice with window', async () => {
    const r = JSON.parse(await c.GetIncidentsByDevice(C, 'loneworker-2', '2026-10-01T00:00:00Z', '2026-10-20T00:00:00Z')); assert.deepStrictEqual(r.map(i => i.incidentId).sort(), ['CS-5', 'W4']); });
  await ok('insurer can read the audit trail of an incident it found', async () => { assert.strictEqual(JSON.parse(await c.GetIncidentHistory(C, 'W3')).length, 1); });
  await bad('gateway cannot query by worker', () => c.GetIncidentsByWorker(G, 'W-0042', '', ''), /Access denied/);
  await ok('assignments do not appear in GetAllIncidents', async () => { const all = JSON.parse(await c.GetAllIncidents(A)); assert(all.every(i => i.docType === 'incident')); });

  // ── 1.3: statutory reporting + compliance score (fresh ledger) ─────────────
  state.clear(); hist.clear();
  const at = (base, min) => new Date(Date.parse(base) + min * 60000).toISOString();
  const D0 = '2026-10-26T08:00:00.000Z', ASOF = '2026-10-27T12:00:00.000Z';
  const odata = JSON.stringify({ tempC: 31, humidity: 60, heatIndexC: 34 });
  await c.SubmitOracleData(O, 'vsp-telecom', 'r9', 'open-meteo', D0, h(odata), odata);
  // K1: ack 3 min, GENUINE 1 h, Form 18 at 6 h → all met
  await c.LogIncident(G, 'K1', 'lw-1', 'FALL', H, D0, '90');
  await c.UpdateIncidentStatus(S, 'K1', 'ACKNOWLEDGED', at(D0, 3));
  await c.ResolveIncident(S, 'K1', 'GENUINE', 'fall from ladder', at(D0, 60));
  // K2: escalated L1, ack 7 min (late), FALSE_ALARM
  const K2 = at(D0, 10); await c.LogIncident(G, 'K2', 'lw-2', 'SOS', H, K2, '80');
  await c.EscalateIncident(G, 'K2', 'unack 5 min', at(K2, 5)); await c.UpdateIncidentStatus(S, 'K2', 'ACKNOWLEDGED', at(K2, 7));
  await c.ResolveIncident(S, 'K2', 'FALSE_ALARM', '', at(K2, 120));
  // K3: escalated to L2, GENUINE only after 25 h, no Form 18
  const K3 = at(D0, 20); await c.LogIncident(G, 'K3', 'lw-3', 'SOS', H, K3, '95');
  await c.EscalateIncident(G, 'K3', 'unack 5 min', at(K3, 5)); await c.EscalateIncident(G, 'K3', 'unack 15 min', at(K3, 15));
  await c.ResolveIncident(S, 'K3', 'GENUINE', '', at(K3, 25 * 60));
  // K4: resolved GENUINE after 20 min without ack; not reportable (no injury)
  const K4 = at(D0, 60); await c.LogIncident(G, 'K4', 'lw-1', 'SOS', H, K4, '70');
  await c.ResolveIncident(S, 'K4', 'GENUINE', 'slipped, no injury', at(K4, 20));
  // K5: 2 min before asOf — too recent for every metric; marked reportable → due soon
  const K5 = at(ASOF, -2); await c.LogIncident(G, 'K5', 'lw-2', 'FALL', H, K5, '95');
  // K6: at site vsp-telecom (oracle context), ack 2 min, NEAR_MISS
  const K6 = at(D0, 120); await c.LogIncidentWithContext(G, 'K6', 'lw-4', 'SOS', H, K6, '60', JSON.stringify({ oracleRef: 'vsp-telecom|r9' }));
  await c.UpdateIncidentStatus(S, 'K6', 'ACKNOWLEDGED', at(K6, 2)); await c.ResolveIncident(S, 'K6', 'NEAR_MISS', '', at(K6, 60));

  await bad('NOT_REPORTABLE needs a reason', () => c.SetReportability(S, 'K4', 'NOT_REPORTABLE', '', at(K4, 30)), /reason/);
  await bad('auditor cannot decide reportability', () => c.SetReportability(A, 'K4', 'NOT_REPORTABLE', 'x', at(K4, 30)), /Access denied/);
  await bad('unknown decision rejected', () => c.SetReportability(S, 'K4', 'MAYBE', 'x', at(K4, 30)), /decision must be/);
  await ok('K4 marked NOT_REPORTABLE with reason (after resolution)', async () => {
    const r = JSON.parse(await c.SetReportability(S, 'K4', 'NOT_REPORTABLE', 'No injury; first aid not needed', at(K4, 30)));
    assert.strictEqual(r.reportability.decision, 'NOT_REPORTABLE'); assert.strictEqual(r.status, 'RESOLVED'); });
  await ok('K5 marked REPORTABLE while still TRIGGERED', () => c.SetReportability(S, 'K5', 'REPORTABLE', '', at(K5, 1)));
  await bad('bad report hash rejected', () => c.RecordStatutoryReport(S, 'K1', 'FORM18', 'abc', at(D0, 360)), /reportHash/);
  await bad('report before the incident rejected', () => c.RecordStatutoryReport(S, 'K1', 'FORM18', h('f18'), at(D0, -1)), /before the incident/);
  await bad('unknown report type rejected', () => c.RecordStatutoryReport(S, 'K1', 'FORM99', h('f18'), at(D0, 360)), /reportType/);
  await bad('insurer cannot record reports', () => c.RecordStatutoryReport(C, 'K1', 'FORM18', h('f18'), at(D0, 360)), /Access denied/);
  await ok('Form 18 for K1 at 6 h: version 1, within deadline, marks REPORTABLE', async () => {
    const r = JSON.parse(await c.RecordStatutoryReport(S, 'K1', 'FORM18', h('f18 v1'), at(D0, 360)));
    assert.deepStrictEqual([r.statutoryReports[0].version, r.statutoryReports[0].withinDeadline, r.reportability.decision], [1, true, 'REPORTABLE']); });
  await ok('corrected Form 18 at 14 h appends version 2 (late), v1 kept', async () => {
    const r = JSON.parse(await c.RecordStatutoryReport(S, 'K1', 'FORM18', h('f18 v2'), at(D0, 14 * 60)));
    assert.deepStrictEqual(r.statutoryReports.map(x => [x.version, x.withinDeadline]), [[1, true], [2, false]]); });
  await bad('filed incident cannot be marked NOT_REPORTABLE', () => c.SetReportability(S, 'K1', 'NOT_REPORTABLE', 'x', at(D0, 900)), /already has a filed report/);
  await bad('insurer cannot see the compliance score', () => c.GetComplianceScore(C, '', '', ASOF), /Access denied/);
  await bad('asOf is required', () => c.GetComplianceScore(A, '', '', ''), /asOfTs/);
  await ok('compliance score: ack 40% · no-esc 80% · resolved 80% · Form 18 50% → 58 (D)', async () => {
    const r = JSON.parse(await c.GetComplianceScore(A, '', '', ASOF));
    const m = Object.fromEntries(r.overall.metrics.map(x => [x.key, [x.met, x.eligible, x.rate]]));
    assert.deepStrictEqual(m, { ack5: [2, 5, 40], noEscalation: [4, 5, 80], resolved24: [4, 5, 80], form18: [1, 2, 50] });
    assert.deepStrictEqual([r.overall.score, r.overall.grade, r.overall.incidents], [58, 'D', 6]);
    assert.deepStrictEqual(r.overall.metrics.find(x => x.key === 'form18').failedIds, ['K3']);
    assert.deepStrictEqual(r.overall.form18DueSoon, ['K5']); });
  await ok('per site: vsp-telecom = K6 only, 100 with Form 18 metric N/A (weights rescaled)', async () => {
    const r = JSON.parse(await c.GetComplianceScore(S, '', '', ASOF));
    const v = r.sites.find(x => x.site === 'vsp-telecom');
    assert.deepStrictEqual([v.incidents, v.score, v.metrics.find(x => x.key === 'form18').rate], [1, 100, null]);
    assert.deepStrictEqual(r.sites.map(x => x.site), ['unassigned', 'vsp-telecom']); });
  await ok('period filter: only 26 Oct 08:00–08:15 → K1, K2', async () => {
    const r = JSON.parse(await c.GetComplianceScore(A, D0, at(D0, 15), ASOF)); assert.strictEqual(r.overall.incidents, 2); });
  await ok('no incidents → score null, grade N/A', async () => {
    const r = JSON.parse(await c.GetComplianceScore(A, '2030-01-01T00:00:00Z', '', ASOF)); assert.deepStrictEqual([r.overall.score, r.overall.grade], [null, 'N/A']); });

  // ── 1.4 network rules (a fresh ctx per call, as Fabric gives each transaction its own) ──
  const fresh = (role, msp = 'EmployerMSP', admin = false) => { const x = ctxFor(role);
    x.clientIdentity.getMSPID = () => msp;
    x.clientIdentity.getID = () => admin ? `x509::/C=IN/O=Hyperledger/OU=admin/CN=orgadmin::/C=IN/CN=ca.${msp}` : `x509::/C=IN/OU=client/CN=${role}1::/C=IN/CN=ca.${msp}`;
    return x; };
  const ADM = () => fresh(undefined, 'EmployerMSP', true), RADM = () => fresh(undefined, 'RegulatorMSP', true), IADM = () => fresh(undefined, 'InsurerMSP', true);
  const R1 = { adminMsps: ['EmployerMSP', 'RegulatorMSP'],
    eventTypes: [{ name: 'SOS', riskScore: 10, statutory: 'Factories Act s.88' }, { name: 'FALL', riskScore: 9 }, { name: 'GasAlert', riskScore: 8, statutory: 'Factories Act s.41B' }],
    access: { resolve: ['supervisor'], incidentHistory: ['auditor', 'supervisor'] } };
  const RT = '2026-11-10T10:00:00Z';
  await ok('no rules yet: GetRules returns null and built-in roles', async () => {
    const r = JSON.parse(await c.GetRules(fresh('auditor'))); assert.strictEqual(r.rules, null);
    assert.deepStrictEqual(r.effective.incidentHistory.allowed, ['auditor', 'supervisor', 'claims-reviewer']); });
  await bad('supervisor (not an org admin) cannot set rules', () => c.SetRules(fresh('supervisor'), JSON.stringify(R1), RT), /only an organisation admin/);
  await bad('admin must be in adminMsps', () => c.SetRules(IADM(), JSON.stringify(R1), RT), /must include the caller/);
  await bad('rules cannot widen built-in roles', () => c.SetRules(ADM(), JSON.stringify({ ...R1, access: { resolve: ['claims-reviewer'] } }), RT), /cannot be allowed/);
  await bad('unknown access group rejected', () => c.SetRules(ADM(), JSON.stringify({ ...R1, access: { deleteAll: ['any'] } }), RT), /unknown access group/);
  await bad('riskScore outside 1–10 rejected', () => c.SetRules(ADM(), JSON.stringify({ ...R1, eventTypes: [{ name: 'SOS', riskScore: 11 }] }), RT), /riskScore/);
  await bad('duplicate event type rejected', () => c.SetRules(ADM(), JSON.stringify({ ...R1, eventTypes: [{ name: 'SOS', riskScore: 9 }, { name: 'sos', riskScore: 8 }] }), RT), /listed twice/);
  await ok('employer admin sets rules v1', async () => { const r = JSON.parse(await c.SetRules(ADM(), JSON.stringify(R1), RT)); assert.strictEqual(r.version, 1); assert.strictEqual(r.setByMsp, 'EmployerMSP'); });
  await bad('insurer admin cannot change rules (not in adminMsps)', () => c.SetRules(IADM(), JSON.stringify({ ...R1, adminMsps: ['InsurerMSP'] }), RT), /not allowed to change/);
  await ok('claims-reviewer loses incident history under rules v1', async () => {
    await assert.rejects(() => c.GetIncidentHistory(fresh('claims-reviewer', 'InsurerMSP'), 'CS-1'), /Access denied by network rules v1/);
    JSON.parse(await c.GetIncidentHistory(fresh('auditor', 'RegulatorMSP'), 'CS-1')); });
  await ok('FALL (rule score 9) classified CRITICAL: risk raised from 50 to the floor 90, original kept', async () => {
    const r = JSON.parse(await c.LogIncident(fresh('gateway'), 'R-1', 'loneworker-1', 'fall', H, '2026-11-10T10:01:00Z', '50'));
    assert.deepStrictEqual([r.riskScore, r.classification.severity, r.classification.reportedRiskScore, r.classification.rulesVersion], ['90', 'CRITICAL', '50', 1]); });
  await ok('SOS keeps a higher gateway score; statutory reference attached', async () => {
    const r = JSON.parse(await c.LogIncident(fresh('gateway'), 'R-2', 'loneworker-1', 'SOS', H, '2026-11-10T10:02:00Z', '100'));
    assert.deepStrictEqual([r.riskScore, r.classification.statutory, r.classification.reportedRiskScore], ['100', 'Factories Act s.88', undefined]); });
  await ok('unknown event type still recorded, marked UNCLASSIFIED', async () => {
    const r = JSON.parse(await c.LogIncident(fresh('gateway'), 'R-3', 'loneworker-1', 'INACTIVITY', H, '2026-11-10T10:03:00Z', '70'));
    assert.deepStrictEqual([r.status, r.riskScore, r.classification.severity], ['TRIGGERED', '70', 'UNCLASSIFIED']); });
  await ok('regulator admin sets v2: auditor loses list-all and history', async () => {
    const r = JSON.parse(await c.SetRules(RADM(), JSON.stringify({ eventTypes: R1.eventTypes, access: { incidentHistory: ['supervisor'], listAllIncidents: ['supervisor'] } }), '2026-11-10T11:00:00Z'));
    assert.deepStrictEqual([r.version, r.adminMsps], [2, ['EmployerMSP', 'RegulatorMSP']]);
    await assert.rejects(() => c.GetAllIncidents(fresh('auditor', 'RegulatorMSP')), /network rules v2/);
    JSON.parse(await c.GetAllIncidents(fresh('supervisor'))); });
  await ok('"any" keeps the built-in roles; rules history lists v1, v2, v3; no event types = no classification', async () => {
    await c.SetRules(ADM(), JSON.stringify({ eventTypes: [], access: { listAllIncidents: ['any'] } }), '2026-11-10T12:00:00Z');
    JSON.parse(await c.GetAllIncidents(fresh('auditor', 'RegulatorMSP')));
    await assert.rejects(() => c.GetAllIncidents(fresh('claims-reviewer', 'InsurerMSP')), /Access denied: role/);
    const h = JSON.parse(await c.GetRulesHistory(fresh('auditor'))); assert.deepStrictEqual(h.map(x => x.value.version), [1, 2, 3]);
    const r = JSON.parse(await c.LogIncident(fresh('gateway'), 'R-4', 'd', 'SOS', H, '2026-11-10T12:01:00Z', '95')); assert.strictEqual(r.classification, undefined); });
  // escalation levels, response targets and report types in the rules
  const R4 = { eventTypes: [], access: {}, escalation: { levels: [{ afterMinutes: 2 }, { afterMinutes: 10 }] },
               targets: { ackMinutes: 10, resolveHours: 48 },
               reportTypes: [{ code: 'FORM18', name: 'Form 18', deadlineHours: 12 }, { code: 'ANNEX-1', name: 'Annexure I (state form)', deadlineHours: 24 }] };
  await bad('escalation levels must get later', () => c.SetRules(ADM(), JSON.stringify({ ...R4, escalation: { levels: [{ afterMinutes: 10 }, { afterMinutes: 5 }] } }), RT), /must come later/);
  await bad('report type code checked', () => c.SetRules(ADM(), JSON.stringify({ ...R4, reportTypes: [{ code: 'f', name: 'x', deadlineHours: 12 }] }), RT), /code/);
  await ok('rules v4 with escalation 2/10 min, targets 10 min / 48 h, two report types', async () => {
    const r = JSON.parse(await c.SetRules(ADM(), JSON.stringify(R4), '2026-11-10T13:00:00Z'));
    assert.deepStrictEqual([r.version, r.escalation.levels.map(l => l.level), r.reportTypes.map(x => x.code)], [4, [1, 2], ['FORM18', 'ANNEX-1']]);
    const g = JSON.parse(await c.GetRules(fresh('auditor'))); assert.strictEqual(g.policy.escalationEnforced, true); });
  const E0 = '2026-11-10T13:10:00Z', at2 = m => new Date(Date.parse(E0) + m * 60000).toISOString();
  await c.LogIncident(fresh('gateway'), 'E-1', 'loneworker-1', 'SOS', H, E0, '95');
  await bad('automatic escalation at 1 min refused (level 1 due at 2)', () => c.EscalateIncident(fresh('gateway'), 'E-1', 'auto', at2(1)), /Too early: level 1/);
  await ok('automatic L1 at 3 min', async () => { assert.strictEqual(JSON.parse(await c.EscalateIncident(fresh('gateway'), 'E-1', 'auto', at2(3))).escalationLevel, 1); });
  await bad('automatic L2 at 5 min refused (due at 10)', () => c.EscalateIncident(fresh('gateway'), 'E-1', 'auto', at2(5)), /Too early: level 2/);
  await ok('automatic L2 at 11 min', async () => { assert.strictEqual(JSON.parse(await c.EscalateIncident(fresh('gateway'), 'E-1', 'auto', at2(11))).escalationLevel, 2); });
  await bad('no automatic level 3 (rules have 2 levels)', () => c.EscalateIncident(fresh('gateway'), 'E-1', 'auto', at2(300)), /no escalation level 3/);
  await ok('a supervisor can still escalate by hand', async () => { assert.strictEqual(JSON.parse(await c.EscalateIncident(fresh('supervisor'), 'E-1', 'manual: site manager called', at2(12))).escalationLevel, 3); });
  await bad('report type not in the rules refused', () => c.RecordStatutoryReport(fresh('supervisor'), 'E-1', 'FORM99', H, at2(60)), /one of FORM18, ANNEX-1/);
  await ok('state form ANNEX-1 at 20 h is within its 24 h deadline', async () => {
    const r = JSON.parse(await c.RecordStatutoryReport(fresh('supervisor'), 'E-1', 'ANNEX-1', H, at2(20 * 60)));
    const e = r.statutoryReports[0]; assert.deepStrictEqual([e.withinDeadline, e.deadlineHours, e.rulesVersion], [true, 24, 4]); });
  await ok('compliance score uses the targets and lists them', async () => {
    const r = JSON.parse(await c.GetComplianceScore(fresh('auditor'), E0, '', at2(3 * 24 * 60)));
    assert.deepStrictEqual([r.rulesVersion, r.targets.ackMinutes, r.targets.escalateToLevel2AfterMinutes], [4, 10, 10]);
    const m = Object.fromEntries(r.overall.metrics.map(x => [x.key, x]));
    assert.deepStrictEqual([m.ack5.label, m.resolved24.label, m.form18.label], ['Acknowledged within 10 min', 'Resolved with outcome within 48 h', 'Statutory report filed within its deadline']);
    assert.deepStrictEqual([m.form18.met, m.form18.eligible], [1, 1]); });
  await ok('rules key is not returned as an incident', async () => {
    const all = JSON.parse(await c.GetAllIncidents(fresh('supervisor'))); assert.ok(all.every(i => i.docType === 'incident')); });

  console.log(`\n${pass} checks passed; events: ${[...new Set(events.map(e => e[0]))].join(', ')}`);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

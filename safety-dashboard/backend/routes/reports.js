'use strict';
// Statutory reporting — Form 18 (Factories Act s.88, Rule 96) — chaincode 1.3 (TG-021)
//
//   GET  /api/reports/form18/:incidentId          supervisor, auditor   prefill + filed versions (+ hash check)
//   POST /api/reports/form18/:incidentId          supervisor            { fields, saveFactoryDefaults? }
//   POST /api/reports/:incidentId/reportability   supervisor            { decision, reason }
//
// Personal particulars (injured person's name, age, injuries…) are stored OFF the ledger in
// data/reports.db so they can be corrected or erased (DPDP Act). The ledger gets the SHA-256 of the
// completed report and the filing time (RecordStatutoryReport), which proves what was filed and when.
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const express  = require('express');
const Database = require('better-sqlite3');
const router   = express.Router();
const { getConnection } = require('../fabricClient');

const DATA_DIR     = process.env.REPORTS_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH      = path.join(DATA_DIR, 'reports.db');
const FACTORY_PATH = path.join(DATA_DIR, 'factory.json');
const tg           = require('../../../common/tgnet');
const SITES_PATH   = process.env.ORACLE_SITES_PATH ||
                     tg.clientFile('sites.json', path.join(tg.TG_HOME, 'safety-simulation', 'oracle', 'sites.json'));
const DEADLINE_MS  = 12 * 3600 * 1000;

// Form 18 particulars (Rule 96). required = must be filled before recording.
const FIELDS = [
    ['factoryName',      'Name of factory', true],
    ['factoryAddress',   'Address of works where the accident or dangerous occurrence happened', true],
    ['natureOfIndustry', 'Nature of industry', true],
    ['licenceNo',        'Factory licence / registration number', false],
    ['department',       'Branch or department and exact place where it happened', true],
    ['injuredName',      "Injured person's name", true],
    ['injuredAddress',   "Injured person's address", false],
    ['sex',              'Sex', true],
    ['age',              'Age (last birthday)', true],
    ['occupation',       'Occupation of injured person', true],
    ['esiNumber',        'ESI insurance number (if covered)', false],
    ['accidentDateTime', 'Date and hour of accident or dangerous occurrence', true],
    ['shift',            'Shift', false],
    ['workStartTime',    'Hour at which the person started work that day', false],
    ['cause',            'Cause or nature of the accident or dangerous occurrence', true],
    ['machine',          'If caused by machinery: machine and part causing it', false],
    ['mechanicalPower',  'Was it moved by mechanical power at the time?', false],
    ['activity',         'Exactly what the injured person was doing at the time', true],
    ['injuries',         'Nature and extent of injuries', true],
    ['fatal',            'Fatal?', true],
    ['disabled48h',      'If not fatal: disabled for 48 hours or more?', false],
    ['medicalOfficer',   'Medical officer attending the injured person', false],
    ['signatory',        'Occupier or manager (name)', true],
    ['designation',      'Designation', false],
];
const FACTORY_KEYS = ['factoryName', 'factoryAddress', 'natureOfIndustry', 'licenceNo', 'signatory', 'designation'];

let db = null;
function store() {
    if (db) return db;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS statutory_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL, report_type TEXT NOT NULL,
        doc_json TEXT NOT NULL, doc_hash TEXT NOT NULL, status TEXT NOT NULL, tx_id TEXT, error TEXT,
        prepared_by TEXT NOT NULL, prepared_at TEXT NOT NULL, recorded_at TEXT)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sr_incident ON statutory_reports(incident_id, report_type)');
    return db;
}
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
// Canonical JSON: sorted keys at every level, so the same report always gives the same hash.
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v);
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const fabricError = err => (err?.details?.[0]?.message || err?.message || String(err)).replace(/^.*chaincode response \d+, /, '');
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

async function contractFor(req) {
    const { identity, mspId } = req.identity;
    return (await getConnection(identity, mspId)).contract;
}
async function incidentOf(req, id) {
    const r = await (await contractFor(req)).evaluateTransaction('GetIncident', id);
    return JSON.parse(Buffer.from(r).toString('utf8'));
}
function siteName(inc) {
    const siteId = inc.risk?.oracleRef ? String(inc.risk.oracleRef).split('|')[0] : null;
    const sites = readJson(SITES_PATH, []);
    const list = Array.isArray(sites) ? sites : sites.sites || [];
    const s = list.find(x => siteId && (x.id === siteId || x.siteId === siteId))
           || list.find(x => (x.devices || []).includes(inc.deviceId));
    return s ? (s.name || s.siteName || siteId) : siteId;
}
const fmtIST = ts => new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';

router.get('/form18/:incidentId', async (req, res) => {
    try {
        const id = req.params.incidentId;
        if (!ID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid incident id' });
        const inc = await incidentOf(req, id);
        const rows = store().prepare('SELECT * FROM statutory_reports WHERE incident_id = ? AND report_type = ? ORDER BY id').all(id, 'FORM18');
        const onChain = (inc.statutoryReports || []).filter(r => r.reportType === 'FORM18');
        // Each ledger entry is matched to the stored report with the same hash → verified
        const filings = onChain.map(r => {
            const row = rows.find(x => x.doc_hash === r.reportHash);
            return { ...r, verified: !!row && sha256(row.doc_json) === r.reportHash,
                     document: row ? JSON.parse(row.doc_json) : null };
        });
        const latest = filings.length ? filings[filings.length - 1].document : null;
        const factory = readJson(FACTORY_PATH, {});
        const site = siteName(inc);
        const prefill = latest ? { ...latest.particulars } : {
            ...Object.fromEntries(FACTORY_KEYS.map(k => [k, factory[k] || ''])),
            department: [site, `beacon ${inc.deviceId}`].filter(Boolean).join(' — '),
            accidentDateTime: fmtIST(inc.timestamp),
            cause: `${inc.eventType} alert from wearable beacon${inc.resolutionNotes ? ': ' + inc.resolutionNotes : ''}`,
            fatal: 'No',
        };
        const deadline = new Date(Date.parse(inc.timestamp) + DEADLINE_MS).toISOString();
        res.json({ success: true, incident: inc, fields: FIELDS.map(([key, label, required]) => ({ key, label, required })),
                   prefill, filings, deadline, unsaved: rows.filter(r => r.status !== 'RECORDED').length });
    } catch (err) { res.status(err.status || 500).json({ success: false, error: fabricError(err) }); }
});

router.post('/form18/:incidentId', async (req, res) => {
    if (req.identity.role !== 'supervisor') return res.status(403).json({ success: false, error: 'Only supervisors file Form 18' });
    const id = req.params.incidentId;
    if (!ID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid incident id' });
    const input = req.body?.fields || {};
    const particulars = {};
    for (const [key, label, required] of FIELDS) {
        const v = input[key] === undefined || input[key] === null ? '' : String(input[key]).trim();
        if (v.length > 500) return res.status(400).json({ success: false, error: `${label}: at most 500 characters` });
        if (required && !v) return res.status(400).json({ success: false, error: `${label} is required` });
        particulars[key] = v;
    }
    let rowId = null;
    try {
        const inc = await incidentOf(req, id);
        const now = new Date().toISOString();
        const version = (inc.statutoryReports || []).filter(r => r.reportType === 'FORM18').length + 1;
        const doc = {
            form: 'FORM18', rule: 'Factories Act 1948 s.88; Factories Rules, Rule 96', version,
            incident: { incidentId: inc.incidentId, deviceId: inc.deviceId, eventType: inc.eventType,
                        timestamp: inc.timestamp, eventHash: inc.eventHash, outcome: inc.outcome || null },
            particulars, preparedBy: req.identity.username, preparedAt: now,
        };
        const json = canonical(doc), hash = sha256(json);
        rowId = store().prepare(`INSERT INTO statutory_reports (incident_id, report_type, doc_json, doc_hash, status, prepared_by, prepared_at)
                                 VALUES (?, 'FORM18', ?, ?, 'PENDING', ?, ?)`).run(id, json, hash, req.identity.username, now).lastInsertRowid;
        const contract = await contractFor(req);
        const proposal = contract.newProposal('RecordStatutoryReport', { arguments: [id, 'FORM18', hash, now] });
        const tx = await proposal.endorse();
        const commit = await tx.submit();
        const status = await commit.getStatus();
        if (!status.successful) throw new Error(`ledger transaction ${commit.getTransactionId()} was not valid (code ${status.code})`);
        store().prepare("UPDATE statutory_reports SET status = 'RECORDED', tx_id = ?, recorded_at = ? WHERE id = ?")
               .run(commit.getTransactionId(), new Date().toISOString(), rowId);
        if (req.body?.saveFactoryDefaults) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(FACTORY_PATH, JSON.stringify(Object.fromEntries(FACTORY_KEYS.map(k => [k, particulars[k]])), null, 2));
        }
        const late = Date.parse(now) - Date.parse(inc.timestamp) > DEADLINE_MS;
        console.log(`[audit] ${req.identity.username} filed Form 18 v${version} for ${id} hash=${hash.slice(0, 16)} tx=${commit.getTransactionId().slice(0, 16)}${late ? ' (after 12 h)' : ''}`);
        res.json({ success: true, version, reportHash: hash, txId: commit.getTransactionId(), reportedAt: now, withinDeadline: !late, document: doc });
    } catch (err) {
        if (rowId) store().prepare("UPDATE statutory_reports SET status = 'FAILED', error = ? WHERE id = ?").run(fabricError(err), rowId);
        res.status(err.status || 500).json({ success: false, error: fabricError(err) });
    }
});

router.post('/:incidentId/reportability', async (req, res) => {
    if (req.identity.role !== 'supervisor') return res.status(403).json({ success: false, error: 'Only supervisors decide reportability' });
    const id = req.params.incidentId;
    const { decision, reason = '' } = req.body || {};
    if (!ID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid incident id' });
    if (!['REPORTABLE', 'NOT_REPORTABLE'].includes(decision)) return res.status(400).json({ success: false, error: 'decision must be REPORTABLE or NOT_REPORTABLE' });
    if (decision === 'NOT_REPORTABLE' && !String(reason).trim()) return res.status(400).json({ success: false, error: 'Give the reason it is not reportable (the regulator sees it)' });
    try {
        const contract = await contractFor(req);
        await contract.submitTransaction('SetReportability', id, decision, String(reason).trim().slice(0, 300), new Date().toISOString());
        console.log(`[audit] ${req.identity.username} marked ${id} ${decision}${reason ? ': ' + reason : ''}`);
        res.json({ success: true, message: `${id} marked ${decision === 'REPORTABLE' ? 'reportable' : 'not reportable'}` });
    } catch (err) { res.status(500).json({ success: false, error: fabricError(err) }); }
});

module.exports = router;

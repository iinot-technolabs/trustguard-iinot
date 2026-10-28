'use strict';
// Worker ↔ beacon assignments and insurer queries (chaincode 1.2, TG-018)
//
//   GET  /api/workers/:workerRef/incidents?from&to   supervisor, auditor, claims-reviewer
//   GET  /api/workers/device/:deviceId/incidents?from&to
//   GET  /api/workers/devices                         supervisor  (beacons seen on the ledger)
//   GET  /api/workers/assignments                     supervisor  (assignments of known workers)
//   POST /api/workers/assignments                     supervisor  { workerRef, deviceId, fromTs, toTs? }
//   POST /api/workers/assignments/close               supervisor  { workerRef, deviceId, fromTs, toTs? }
//
// The ledger is the record. The chaincode has no "list every assignment" call, so this
// backend keeps a small index of the worker codes registered through the dashboard
// (data/workers.json, codes only) to know which workers to look up.
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const router  = express.Router();
const { getConnection } = require('../fabricClient');

const INDEX_PATH = process.env.WORKER_INDEX_PATH || path.join(__dirname, '..', 'data', 'workers.json');
const WORKER_REF = /^[A-Za-z0-9._-]{3,32}$/;
const DEVICE_ID  = /^[A-Za-z0-9._:-]{1,64}$/;

function fabricError(err) {
    const m = err?.details?.[0]?.message || err?.message || String(err);
    return m.replace(/^.*chaincode response \d+, /, '');
}
function readIndex() {
    try { const a = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); return Array.isArray(a) ? a.filter(r => WORKER_REF.test(r)) : []; }
    catch { return []; }
}
function addToIndex(ref) {
    const refs = readIndex();
    if (refs.includes(ref)) return;
    refs.push(ref); refs.sort();
    fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
    const tmp = INDEX_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(refs, null, 2));
    fs.renameSync(tmp, INDEX_PATH);
}
// Optional ISO bound from a query/body value; '' when absent. Throws on garbage.
function isoOrEmpty(v, name) {
    if (v === undefined || v === null || v === '') return '';
    const t = Date.parse(String(v));
    if (!Number.isFinite(t)) throw Object.assign(new Error(`${name} must be a date/time`), { status: 400 });
    return new Date(t).toISOString();
}
function supervisorOnly(req, res) {
    if (req.identity.role === 'supervisor') return true;
    res.status(403).json({ success: false, error: 'Only supervisors manage worker assignments' });
    return false;
}
async function contractFor(req) {
    const { identity, mspId } = req.identity;
    return (await getConnection(identity, mspId)).contract;
}
const parse = r => JSON.parse(Buffer.from(r).toString('utf8'));
const send = (res, err) => res.status(err.status || 500).json({ success: false, error: fabricError(err) });

router.get('/devices', async (req, res) => {
    if (!supervisorOnly(req, res)) return;
    try {
        const all = parse(await (await contractFor(req)).evaluateTransaction('GetAllIncidents'));
        const seen = new Map();
        for (const i of all) {
            const last = seen.get(i.deviceId);
            if (!last || i.timestamp > last) seen.set(i.deviceId, i.timestamp);
        }
        res.json({ success: true, devices: [...seen].map(([deviceId, lastEventAt]) => ({ deviceId, lastEventAt }))
            .sort((a, b) => a.deviceId.localeCompare(b.deviceId)) });
    } catch (err) { send(res, err); }
});

router.get('/assignments', async (req, res) => {
    if (!supervisorOnly(req, res)) return;
    try {
        const contract = await contractFor(req);
        const assignments = [];
        for (const ref of readIndex()) {
            const r = parse(await contract.evaluateTransaction('GetIncidentsByWorker', ref, '', ''));
            for (const a of r.assignments) {
                assignments.push({ ...a, incidentCount: r.incidents.filter(i => i.deviceId === a.deviceId
                    && i.timestamp >= a.fromTs && (!a.toTs || i.timestamp < a.toTs)).length });
            }
        }
        // open assignments first, then newest first
        assignments.sort((a, b) => (a.toTs ? 1 : 0) - (b.toTs ? 1 : 0) || b.fromTs.localeCompare(a.fromTs));
        res.json({ success: true, assignments });
    } catch (err) { send(res, err); }
});

router.post('/assignments', async (req, res) => {
    if (!supervisorOnly(req, res)) return;
    try {
        const { workerRef, deviceId } = req.body || {};
        if (!WORKER_REF.test(workerRef || '')) return res.status(400).json({ success: false,
            error: 'Worker code must be 3-32 letters, digits, . _ or - (an employee code, not a name)' });
        if (!DEVICE_ID.test(deviceId || '')) return res.status(400).json({ success: false, error: 'Choose a beacon' });
        const fromTs = isoOrEmpty(req.body.fromTs, 'fromTs') || new Date().toISOString();
        const toTs = isoOrEmpty(req.body.toTs, 'toTs');
        await (await contractFor(req)).submitTransaction('RegisterWorkerAssignment', workerRef, deviceId, fromTs, toTs);
        addToIndex(workerRef);
        console.log(`[audit] ${req.identity.username} assigned ${deviceId} to ${workerRef} from ${fromTs}${toTs ? ' to ' + toTs : ''}`);
        res.json({ success: true, message: `${deviceId} assigned to ${workerRef}` });
    } catch (err) { send(res, err); }
});

router.post('/assignments/close', async (req, res) => {
    if (!supervisorOnly(req, res)) return;
    try {
        const { workerRef, deviceId, fromTs } = req.body || {};
        if (!WORKER_REF.test(workerRef || '') || !DEVICE_ID.test(deviceId || '') || !fromTs) {
            return res.status(400).json({ success: false, error: 'workerRef, deviceId and fromTs are required' });
        }
        const toTs = isoOrEmpty(req.body.toTs, 'toTs') || new Date().toISOString();
        // fromTs must be passed exactly as stored on the ledger (it is part of the key)
        await (await contractFor(req)).submitTransaction('CloseWorkerAssignment', workerRef, deviceId, String(fromTs), toTs);
        console.log(`[audit] ${req.identity.username} ended ${workerRef} / ${deviceId} at ${toTs}`);
        res.json({ success: true, message: `Assignment ended at ${toTs}` });
    } catch (err) { send(res, err); }
});

router.get('/device/:deviceId/incidents', async (req, res) => {
    try {
        if (!DEVICE_ID.test(req.params.deviceId)) return res.status(400).json({ success: false, error: 'invalid beacon id' });
        const from = isoOrEmpty(req.query.from, 'from'), to = isoOrEmpty(req.query.to, 'to');
        const incidents = parse(await (await contractFor(req)).evaluateTransaction('GetIncidentsByDevice', req.params.deviceId, from, to));
        incidents.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        res.json({ success: true, deviceId: req.params.deviceId, from, to, incidents });
    } catch (err) { send(res, err); }
});

router.get('/:workerRef/incidents', async (req, res) => {
    try {
        if (!WORKER_REF.test(req.params.workerRef)) return res.status(400).json({ success: false, error: 'invalid worker code' });
        const from = isoOrEmpty(req.query.from, 'from'), to = isoOrEmpty(req.query.to, 'to');
        const r = parse(await (await contractFor(req)).evaluateTransaction('GetIncidentsByWorker', req.params.workerRef, from, to));
        r.incidents.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        console.log(`[audit] ${req.identity.username} (${req.identity.role}) looked up worker ${req.params.workerRef}`);
        res.json({ success: true, from, to, ...r });
    } catch (err) { send(res, err); }
});

module.exports = router;

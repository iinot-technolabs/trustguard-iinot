'use strict';
// GET /api/compliance/score?from&to — chaincode 1.3 GetComplianceScore (TG-021)
// The score is computed by the chaincode on the peer, so the regulator's own peer gives the
// same answer from the same ledger. asOf = now, passed in to keep the chaincode deterministic.
const express = require('express');
const router  = express.Router();
const { getConnection } = require('../fabricClient');

const iso = (v, name) => {
    if (v === undefined || v === null || v === '') return '';
    const t = Date.parse(String(v));
    if (!Number.isFinite(t)) throw Object.assign(new Error(`${name} must be a date/time`), { status: 400 });
    return new Date(t).toISOString();
};

router.get('/score', async (req, res) => {
    try {
        const from = iso(req.query.from, 'from'), to = iso(req.query.to, 'to');
        const { identity, mspId } = req.identity;
        const { contract } = await getConnection(identity, mspId);
        const r = await contract.evaluateTransaction('GetComplianceScore', from, to, new Date().toISOString());
        res.json({ success: true, ...JSON.parse(Buffer.from(r).toString('utf8')) });
    } catch (err) {
        const m = err?.details?.[0]?.message || err.message;
        res.status(err.status || 500).json({ success: false, error: m.replace(/^.*chaincode response \d+, /, '') });
    }
});

module.exports = router;

'use strict';

const express = require('express');
const router  = express.Router();
const { getConnection } = require('../fabricClient');

router.get('/', async (req, res) => {
    try {
        const { identity, mspId } = req.identity;
        const { contract } = await getConnection(identity, mspId);
        const result = await contract.evaluateTransaction('GetAllIncidents');
        const incidents = JSON.parse(Buffer.from(result).toString('utf8'));
        incidents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.json({ success: true, incidents });
    } catch (err) {
        console.error('GetAllIncidents error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const { identity, mspId } = req.identity;
        const { contract } = await getConnection(identity, mspId);
        const result = await contract.evaluateTransaction('GetIncident', req.params.id);
        const incident = JSON.parse(Buffer.from(result).toString('utf8'));
        res.json({ success: true, incident });
    } catch (err) {
        res.status(404).json({ success: false, error: err.message });
    }
});

router.get('/:id/history', async (req, res) => {
    try {
        const { identity, mspId } = req.identity;
        const { contract } = await getConnection(identity, mspId);
        const result = await contract.evaluateTransaction('GetIncidentHistory', req.params.id);
        const history = JSON.parse(Buffer.from(result).toString('utf8'));
        res.json({ success: true, history });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.patch('/:id/status', async (req, res) => {
    try {
        const { identity, mspId, role } = req.identity;
        if (role !== 'supervisor') {
            return res.status(403).json({
                success: false,
                error: 'Only supervisors can update incident status'
            });
        }
        const { status } = req.body;
        if (!['ACKNOWLEDGED', 'RESOLVED'].includes(status)) {
            return res.status(400).json({
                success: false,
                error: 'Status must be ACKNOWLEDGED or RESOLVED'
            });
        }
        const { contract } = await getConnection(identity, mspId);
        await contract.submitTransaction(
            'UpdateIncidentStatus', req.params.id,
            status, new Date().toISOString()
        );
        // Fabric signs as the shared identity; record which user acted (TG-010)
        console.log(`[audit] ${req.identity.username} (${identity}) set ${req.params.id} -> ${status}`);
        res.json({
            success: true,
            message: `Incident ${req.params.id} updated to ${status}`
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Resolve with an outcome tag (chaincode 1.1 ResolveIncident) — TG-013
router.post('/:id/resolve', async (req, res) => {
    try {
        const { identity, mspId, role, username } = req.identity;
        if (role !== 'supervisor') {
            return res.status(403).json({ success: false, error: 'Only supervisors can resolve incidents' });
        }
        const { outcome, notes = '' } = req.body || {};
        if (!['GENUINE', 'FALSE_ALARM', 'NEAR_MISS'].includes(outcome)) {
            return res.status(400).json({ success: false, error: 'outcome must be GENUINE, FALSE_ALARM or NEAR_MISS' });
        }
        if (typeof notes !== 'string' || notes.length > 500) {
            return res.status(400).json({ success: false, error: 'notes must be text of at most 500 characters' });
        }
        const { contract } = await getConnection(identity, mspId);
        await contract.submitTransaction('ResolveIncident', req.params.id, outcome, notes, new Date().toISOString());
        console.log(`[audit] ${username} (${identity}) resolved ${req.params.id} outcome=${outcome}`);
        res.json({ success: true, message: `Incident ${req.params.id} resolved as ${outcome}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.details?.[0]?.message || err.message });
    }
});

module.exports = router;

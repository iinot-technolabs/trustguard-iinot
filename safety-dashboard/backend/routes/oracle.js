'use strict';
// GET /api/oracle/latest — latest anchored weather reading per site (TG-014)
// Reads the oracle's off-chain copy, then re-reads the reading from the ledger
// with the caller's Fabric identity and checks the hashes match ("verified").
const express  = require('express');
const Database = require('better-sqlite3');
const router   = express.Router();
const { getConnection } = require('../fabricClient');

const tg = require('../../../common/tgnet');
const DB_PATH = process.env.ORACLE_DB_PATH || tg.offchainDb();   // shared with the gateway and oracle services

router.get('/latest', async (req, res) => {
    let rows = [];
    try {
        const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        rows = db.prepare(`
            SELECT r.site_id, r.reading_id, r.observed_at, r.data_json, r.data_hash, r.tx_id
            FROM oracle_readings r
            JOIN (SELECT site_id, MAX(observed_at) AS m FROM oracle_readings
                  WHERE status = 'ANCHORED' GROUP BY site_id) l
              ON l.site_id = r.site_id AND l.m = r.observed_at
            WHERE r.status = 'ANCHORED'`).all();
        db.close();
    } catch (err) {
        // No database or no oracle_readings table yet → oracle not running yet
        return res.json({ success: true, readings: [], note: 'No oracle readings yet' });
    }

    const { identity, mspId } = req.identity;
    let contract = null;
    try { ({ contract } = await getConnection(identity, mspId)); } catch { /* verification skipped */ }

    const readings = [];
    for (const r of rows) {
        let verified = false;
        if (contract) {
            try {
                const onChain = JSON.parse(Buffer.from(
                    await contract.evaluateTransaction('GetOracleReading', r.site_id, r.reading_id)).toString('utf8'));
                verified = onChain.dataHash === r.data_hash;
            } catch { verified = false; }
        }
        readings.push({
            siteId: r.site_id, readingId: r.reading_id, observedAt: r.observed_at,
            txId: r.tx_id, dataHash: r.data_hash, verified, ...JSON.parse(r.data_json),
        });
    }
    res.json({ success: true, readings });
});

module.exports = router;

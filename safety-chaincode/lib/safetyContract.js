'use strict';
const { Contract } = require('fabric-contract-api');


class SafetyContract extends Contract {

    async InitLedger(ctx) {
        console.info('Safety ledger initialised');
        return;
    }

    // Only IoT gateway identity (role=gateway) may log incidents
    async LogIncident(ctx, incidentId, deviceId, eventType, eventHash, timestamp, riskScore) {
        const clientId = ctx.clientIdentity;
        const role = clientId.getAttributeValue('role');

        if (role !== 'gateway') {
            throw new Error(`Access denied: role '${role}' cannot log incidents`);
        }

        const exists = await this._exists(ctx, incidentId);
        if (exists) {
            throw new Error(`Incident ${incidentId} already exists`);
        }
        const incident = {
            docType:    'incident',
            incidentId,
            deviceId,
            eventType,   // FALL | INACTIVITY | SOS
            eventHash,   // SHA-256 of raw TTN payload (full payload stored off-chain)
            timestamp,
            riskScore,
            status:     'TRIGGERED',
            createdBy:  clientId.getID(),
            updatedBy:  null,
            updatedAt:  null
        };

        await ctx.stub.putState(incidentId, Buffer.from(JSON.stringify(incident)));
        ctx.stub.setEvent('IncidentLogged', Buffer.from(JSON.stringify({ incidentId, eventType, riskScore })));
        return JSON.stringify(incident);
    }

    // Only supervisor identity (role=supervisor) may update status.
    // updatedAt is passed in by the client so all endorsing peers agree
    // on the exact value (chaincode must be deterministic - it cannot
    // call new Date() internally, since peers would compute different
    // timestamps and the endorsements would mismatch).
    async UpdateIncidentStatus(ctx, incidentId, newStatus, updatedAt) {
        const clientId = ctx.clientIdentity;
        const role = clientId.getAttributeValue('role');

        if (role !== 'supervisor') {
            throw new Error(`Access denied: role '${role}' cannot update incident status`);
        }

        const validStatuses = ['ACKNOWLEDGED', 'RESOLVED'];
        if (!validStatuses.includes(newStatus)) {
            throw new Error(`Invalid status '${newStatus}'. Must be ACKNOWLEDGED or RESOLVED`);
        }

        const incident = await this._getIncident(ctx, incidentId);
        incident.status    = newStatus;
        incident.updatedBy = clientId.getID();
        incident.updatedAt = updatedAt;

        await ctx.stub.putState(incidentId, Buffer.from(JSON.stringify(incident)));
        ctx.stub.setEvent('IncidentUpdated', Buffer.from(JSON.stringify({ incidentId, newStatus })));
        return JSON.stringify(incident);
    }

    // Any authenticated identity may read a single incident
    async GetIncident(ctx, incidentId) {
        const incident = await this._getIncident(ctx, incidentId);
        return JSON.stringify(incident);
    }

    // Restricted to supervisor, auditor, claims-reviewer roles
    async GetAllIncidents(ctx) {
        const clientId = ctx.clientIdentity;
        const role = clientId.getAttributeValue('role');

        const allowedRoles = ['supervisor', 'auditor', 'claims-reviewer'];
        if (!allowedRoles.includes(role)) {
            throw new Error(`Access denied: role '${role}' cannot list all incidents`);
        }

        const results = [];
        const iterator = await ctx.stub.getStateByRange('', '');
        let result = await iterator.next();

        while (!result.done) {
            const strValue = result.value.value.toString('utf8');
            try {
                const record = JSON.parse(strValue);
                if (record.docType === 'incident') {
                    results.push(record);
                }
            } catch (err) {
                // skip non-JSON or non-incident entries
            }
            result = await iterator.next();
        }
        await iterator.close();
        return JSON.stringify(results);
    }
    // Get full audit history for a single incident (immutable ledger trail)
    async GetIncidentHistory(ctx, incidentId) {
        const clientId = ctx.clientIdentity;
        const role = clientId.getAttributeValue('role');

        const allowedRoles = ['auditor', 'supervisor'];
        if (!allowedRoles.includes(role)) {
            throw new Error(`Access denied: role '${role}' cannot view incident history`);
        }

        const iterator = await ctx.stub.getHistoryForKey(incidentId);
        const history  = [];
        let result     = await iterator.next();

        while (!result.done) {
            const entry = {
                txId:      result.value.txId,
                timestamp: result.value.timestamp,
                isDelete:  result.value.isDelete,
                value:     JSON.parse(result.value.value.toString('utf8'))
            };
            history.push(entry);
            result = await iterator.next();
        }
        await iterator.close();
        return JSON.stringify(history);
    }

    // --- Private helpers ---
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

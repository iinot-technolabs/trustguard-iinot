'use strict';
/**
 * /api/rules — Rules Designer (TG-028, chaincode safetycc 1.4). Admin only.
 *   GET    /         saved rules (or defaults), function groups, roles in the network
 *   PUT    /         validate and save { eventTypes, access } into network-config.json "rules"
 *   GET    /ledger   rules now in force on the channel (GetRules) and every earlier version
 * Applying the saved rules to the channel = POST /api/deploy { mode: "rules" } (network.sh rules),
 * so it runs and streams like a deploy and is signed by an endorsing organisation's admin.
 */
const express = require('express');
const tg = require('../../../common/tgnet');
const { buildModel, ConfigError } = require('../lib/networkModel');
const { savedOrDefault, normalizeRules, groupsForUi, networkRoles, defaultRules } = require('../lib/rulesModel');
const { readConfig, writeConfig } = require('../lib/configFile');
const { TG_HOME } = require('../lib/paths');
const { getConnection } = require('../fabricClient');

const router = express.Router();

function current() {
  const cfg = readConfig();
  if (!cfg) throw new ConfigError(['no network config saved yet: design the network first']);
  return { cfg, model: buildModel(cfg, { tgHome: TG_HOME }) };
}
const fail = (res, err) => err instanceof ConfigError
  ? res.status(400).json({ ok: false, problems: err.problems })
  : res.status(500).json({ ok: false, error: err.message });

router.get('/', (req, res) => {
  try {
    const { cfg, model } = current();
    const { rules, saved, migrated } = savedOrDefault(cfg);
    res.json({ ok: true, rules, saved, migrated: !!migrated, groups: groupsForUi(model), roles: networkRoles(model),
               adminMsps: model.orgs.filter(o => o.endorses).map(o => o.mspId), defaults: defaultRules(),
               network: model.network.name, channel: model.network.channel, chaincode: model.chaincode.label });
  } catch (err) { fail(res, err); }
});

router.put('/', (req, res) => {
  try {
    const { cfg, model } = current();
    const { rules, warnings } = normalizeRules(req.body, model);
    writeConfig({ ...cfg, rules });
    res.json({ ok: true, rules, warnings });
  } catch (err) { fail(res, err); }
});

router.get('/ledger', async (req, res) => {
  try {
    const id = tg.identityForRole('auditor') || tg.identityForRole('supervisor') || tg.identityForRole('gateway');
    if (!id) throw new Error('no app identity in this network to read the ledger with');
    const { contract } = await getConnection(id.name, id.mspId);
    const now = JSON.parse(Buffer.from(await contract.evaluateTransaction('GetRules')).toString('utf8'));
    const history = JSON.parse(Buffer.from(await contract.evaluateTransaction('GetRulesHistory')).toString('utf8'))
      .map(h => ({ txId: h.txId, version: h.value.version, setAt: h.value.setAt, setByMsp: h.value.setByMsp,
                   eventTypes: h.value.eventTypes.length, restricted: Object.keys(h.value.access || {}),
                   escalation: h.value.escalation ? h.value.escalation.levels.map(l => l.afterMinutes) : null,
                   reportTypes: h.value.reportTypes ? h.value.reportTypes.map(r => r.code) : null }));
    res.json({ ok: true, ...now, history: history.reverse() });
  } catch (err) {
    const m = err?.details?.[0]?.message || err.message;
    const old = /GetRules|function .* not found|does not exist/i.test(m);
    res.status(old ? 409 : 500).json({ ok: false, error: old
      ? 'The chaincode on this channel has no network rules (it is older than safetycc 1.4). Redeploy with 1.4 to enforce rules.'
      : m.replace(/^.*chaincode response \d+, /, '') });
  }
});

module.exports = router;

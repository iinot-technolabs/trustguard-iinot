'use strict';
// Rules Designer model (TG-028). Run: npm test (node --test)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { buildModel, ConfigError } = require('../lib/networkModel');
const { savedOrDefault, normalizeRules, groupsForUi, RULE_GROUPS } = require('../lib/rulesModel');

const EX = path.join(__dirname, '..', '..', '..', 'examples');
const load = f => JSON.parse(fs.readFileSync(path.join(EX, f), 'utf8'));
const demo = load('iinot-demo.network-config.json');
const model = buildModel(demo, { tgHome: '/opt/tg' });

test('defaults when nothing is saved; deploy ignores legacy designer data', () => {
  const r = savedOrDefault(demo);
  assert.equal(r.saved, false);
  assert.deepEqual(r.rules.eventTypes.map(e => [e.name, e.riskScore]), [['SOS', 8], ['FALL', 7], ['INACTIVITY', 5]]);
  const legacy = { ...demo, chaincode: { ...demo.chaincode, eventTypes: [{ id: 'a', name: 'ManDown', riskScore: 9, statutory: '' }],
                                         accessRules: { GetIncidentHistory: ['role.auditor'] } } };
  const ui = savedOrDefault(legacy);
  assert.equal(ui.migrated, true);
  assert.deepEqual(ui.rules.access, { incidentHistory: ['auditor'] });
  assert.equal(savedOrDefault(legacy, { migrate: false }).rules.eventTypes[0].name, 'SOS');
});

test('normalise: adminMsps = endorsing orgs; "any" is not stored', () => {
  const { rules, ledger } = normalizeRules({ eventTypes: [{ name: 'GasAlert', riskScore: 9, statutory: ' s.41B ' }],
                                             access: { resolve: ['supervisor'], listAllIncidents: ['any'] } }, model);
  assert.deepEqual(ledger.adminMsps, ['IINoTIndustryMSP', 'IINoTRegulatorMSP']);
  assert.deepEqual(rules.access, { resolve: ['supervisor'] });
  assert.equal(rules.eventTypes[0].statutory, 's.41B');
});

test('normalise rejects widening, unknown groups, bad scores and duplicates', () => {
  assert.throws(() => normalizeRules({ eventTypes: [{ name: 'SOS', riskScore: 0 }, { name: 'sos', riskScore: 5 }],
    access: { resolve: ['claims-reviewer'], wipe: ['any'], acknowledge: [] } }, model), e => {
    assert.ok(e instanceof ConfigError);
    assert.equal(e.problems.length, 5, e.problems.join(' | '));
    return true;
  });
});

test('warnings name the dashboard screens a restriction breaks', () => {
  const { warnings } = normalizeRules({ eventTypes: [], access: { listAllIncidents: ['supervisor'], incidentHistory: ['auditor', 'supervisor'] } }, model);
  assert.ok(warnings.some(w => w.includes('auditor incident list')));
  assert.ok(warnings.some(w => w.includes('insurer audit trail')));
});

test('groups for the UI: available roles are those present in the network', () => {
  const tgm = buildModel(load('tg-mining.network-config.json'), { tgHome: '/opt/tg' });   // no insurer
  const h = groupsForUi(tgm).find(g => g.id === 'incidentHistory');
  assert.ok(!h.available.includes('claims-reviewer'));
  assert.equal(groupsForUi(model).length, Object.keys(RULE_GROUPS).length);
});

test('configFile keeps saved rules when the designer saves the network again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rules-'));
  process.env.NETWORK_ROOT = dir;
  delete require.cache[require.resolve('../lib/paths')]; delete require.cache[require.resolve('../lib/configFile')];
  const { writeConfig, readConfig } = require('../lib/configFile');
  writeConfig({ ...demo, rules: { eventTypes: [], access: { resolve: ['supervisor'] } } });
  writeConfig(demo);
  assert.deepEqual(readConfig().rules.access, { resolve: ['supervisor'] });
  writeConfig({ ...demo, rules: { eventTypes: [], access: {} } });
  assert.deepEqual(readConfig().rules.access, {});
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.NETWORK_ROOT;
});

test('defaults carry today\'s escalation levels, targets and Form 18', () => {
  const r = savedOrDefault(demo).rules;
  assert.deepEqual(r.escalation.levels.map(l => l.afterMinutes), [5, 15, 240]);
  assert.deepEqual(r.targets, { ackMinutes: 5, resolveHours: 24 });
  assert.deepEqual(r.reportTypes.map(x => [x.code, x.deadlineHours]), [['FORM18', 12]]);
  const old = savedOrDefault({ ...demo, rules: { eventTypes: [], access: {} } });   // saved before these parts existed
  assert.equal(old.rules.reportTypes[0].code, 'FORM18');
  assert.equal(savedOrDefault({ ...demo, rules: { eventTypes: [], access: {} } }, { migrate: false }).rules.reportTypes, undefined);
});

test('escalation, targets and report types are checked and normalised', () => {
  const { rules, warnings } = normalizeRules({ eventTypes: [], access: {},
    escalation: { levels: [{ afterMinutes: '10' }, { afterMinutes: 30, minRisk: '' }] }, targets: { ackMinutes: 10, resolveHours: 48 },
    reportTypes: [{ code: 'annex-1', name: 'Annexure I', deadlineHours: 24 }] }, model);
  assert.deepEqual(rules.escalation.levels, [{ level: 1, afterMinutes: 10 }, { level: 2, afterMinutes: 30 }]);
  assert.equal(rules.reportTypes[0].code, 'ANNEX-1');
  assert.ok(warnings.some(w => w.includes('Form 18 is not in the report types')));
  assert.ok(warnings.some(w => w.includes('stops at level 2')));
  assert.throws(() => normalizeRules({ escalation: { levels: [{ afterMinutes: 20 }, { afterMinutes: 10 }] }, targets: { ackMinutes: 0, resolveHours: 24 },
    reportTypes: [{ code: 'X', name: '', deadlineHours: 0 }] }, model), e => e.problems.length === 5);
});

test('the chaincode and the dashboard share one list of groups', () => {
  const cc = require('../../../safety-chaincode/lib/ruleGroups');
  assert.strictEqual(cc.RULE_GROUPS, RULE_GROUPS);
});

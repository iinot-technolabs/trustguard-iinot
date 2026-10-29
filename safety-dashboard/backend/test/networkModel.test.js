'use strict';
// Run: npm test   (= node --test, from safety-dashboard/backend; Node 20+)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildModel, parseRole, ConfigError } = require('../lib/networkModel');
const { generate } = require('../lib/generateConfigs');

const EX = path.join(__dirname, '..', '..', '..', 'examples');
const load = f => JSON.parse(fs.readFileSync(path.join(EX, f), 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));

test('parseRole accepts the designer formats', () => {
  assert.equal(parseRole({ attrs: 'role.gateway:ecert' }), 'gateway');
  assert.equal(parseRole({ attrs: 'role=claims-reviewer:ecert' }), 'claims-reviewer');
  assert.equal(parseRole({ attrs: 'role=oracle' }), 'oracle');
  assert.equal(parseRole({ role: 'auditor' }), 'auditor');
});

test('iinot-demo: AND(employer, regulator), insurer present but not endorsing', () => {
  const m = buildModel(load('iinot-demo.network-config.json'), { tgHome: '/opt/tg' });
  assert.equal(m.chaincode.policy, "AND('IINoTIndustryMSP.peer','IINoTRegulatorMSP.peer')");
  assert.deepEqual(m.orgs.map(o => o.type), ['employer', 'regulator', 'insurer']);
  assert.equal(m.orderer.batchTimeout, '500ms');
  assert.equal(m.orderer.host, 'orderer.iinot-safety.com');
  assert.equal(m.chaincode.label, 'safetycc_1.3');
  assert.equal(m.paths.wallet, '/opt/tg/wallet');
});

test('insurer toggle off removes the org; policy unchanged', () => {
  const c = load('iinot-demo.network-config.json');
  c.organizations[2].enabled = false;
  const m = buildModel(c);
  assert.equal(m.orgs.length, 2);
  assert.equal(m.insurerOrg, null);
  assert.equal(m.chaincode.policy, "AND('IINoTIndustryMSP.peer','IINoTRegulatorMSP.peer')");
});

test('tg-mining: no IINoT names, orderer host not doubled, non-endorsing regulator', () => {
  const m = buildModel(load('tg-mining.network-config.json'));
  assert.equal(m.orderer.host, 'orderer.tg-mining-safety.in');
  assert.equal(m.chaincode.policy, "AND('TGMineOperatorMSP.peer','TGDGMSMSP.peer')");
  assert.ok(!JSON.stringify({ n: m.network, o: m.orderer, g: m.orgs, c: m.chaincode.name }).match(/iinot/i));
});

test('free-text MAJORITY policy is ignored with a warning', () => {
  const c = load('iinot-demo.network-config.json');
  c.chaincode.endorsementPolicy = "MAJORITY('IINoTIndustryMSP.member','IINoTRegulatorMSP.member')";
  const m = buildModel(c);
  assert.match(m.chaincode.policy, /^AND\(/);
  assert.ok(m.warnings.some(w => w.includes('is ignored')));
});

test('validation lists every problem at once', () => {
  const c = clone(load('iinot-demo.network-config.json'));
  c.network.channel = 'Bad Channel';
  c.organizations[1].peerPort = 7051;                 // clash with employer
  c.organizations[0].roles.push({ name: 'auditor1', attrs: 'role.auditor:ecert' }); // duplicate user
  c.organizations[0].domain = 'bad_domain';
  c.orderer.batchTimeout = '30s';
  try { buildModel(c); assert.fail('expected ConfigError'); }
  catch (e) {
    assert.ok(e instanceof ConfigError);
    const all = e.problems.join('\n');
    for (const s of ['network.channel', 'port "7051"', 'user name "auditor1"', 'bad_domain', 'batchTimeout']) assert.ok(all.includes(s), s);
  }
});

test('names that could break YAML or shell are rejected', () => {
  for (const [k, v] of [['id', "X'MSP"], ['domain', 'a.com; rm -rf /'], ['caName', 'ca $(id)']]) {
    const c = load('iinot-demo.network-config.json');
    c.organizations[0][k] = v;
    assert.throws(() => buildModel(c), ConfigError, `${k}=${v}`);
  }
});

test('at least one employer and one endorser are required', () => {
  const c = load('iinot-demo.network-config.json');
  c.organizations[0].type = 'regulator';
  assert.throws(() => buildModel(c), /type "employer"/);
  const d = load('iinot-demo.network-config.json');
  d.organizations.forEach(o => { o.endorses = false; });
  assert.throws(() => buildModel(d), /must endorse/);
});

test('generate writes all outputs; secrets 0600, kept across runs, not in other files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-test-'));
  const root = path.join(home, 'iinot-network');
  fs.mkdirSync(root);
  const cfg = path.join(home, 'cfg.json');
  fs.copyFileSync(path.join(EX, 'iinot-demo.network-config.json'), cfg);
  generate(cfg, root, () => {});
  const sfile = path.join(root, 'config', 'secrets', 'secrets.json');
  const first = fs.readFileSync(sfile, 'utf8');
  assert.equal(fs.statSync(sfile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, 'config', 'secrets')).mode & 0o777, 0o700);
  generate(cfg, root, () => {});
  assert.equal(fs.readFileSync(sfile, 'utf8'), first, 'secrets must not change on regenerate');
  const secrets = Object.values(JSON.parse(first)).flatMap(o => Object.values(o));
  for (const f of ['docker/docker-compose.yaml', 'configtx.yaml', 'config/app.env', 'config/network.derived.json']) {
    const body = fs.readFileSync(path.join(root, f), 'utf8');
    secrets.forEach(s => assert.ok(!body.includes(s), `secret in ${f}`));
  }
  const compose = fs.readFileSync(path.join(root, 'docker/docker-compose.yaml'), 'utf8');
  assert.ok(!compose.includes('adminpw'));
  assert.ok(!/"(?!127\.0\.0\.1:)\d+:\d+"/.test(compose), 'all ports bound to 127.0.0.1');
  assert.match(fs.readFileSync(path.join(root, 'configtx.yaml'), 'utf8'), /BatchTimeout: 500ms/);
  fs.rmSync(home, { recursive: true, force: true });
});

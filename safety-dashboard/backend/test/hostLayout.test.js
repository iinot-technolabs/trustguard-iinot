'use strict';
// Two-host layout (config/host.json, TG-031). Run: npm test (node --test, Node 20+)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generate } = require('../lib/generateConfigs');

const EX = path.join(__dirname, '..', '..', '..', 'examples', 'two-host-proof.network-config.json');

function setup(hostJson) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-host-'));
  const net = path.join(root, 'iinot-network');
  fs.mkdirSync(path.join(net, 'config'), { recursive: true });
  const cfg = path.join(net, 'config', 'network-config.json');
  fs.copyFileSync(EX, cfg);
  if (hostJson) fs.writeFileSync(path.join(net, 'config', 'host.json'), JSON.stringify(hostJson));
  return { root, net, cfg };
}
const quiet = () => {};

test('no host.json: everything local, compose unchanged in shape', () => {
  const { net, cfg } = setup(null);
  const m = generate(cfg, net, quiet);
  assert.equal(m.hosts, null);
  assert.ok(m.orderer.local && m.orgs.every(o => o.local));
  const compose = fs.readFileSync(path.join(net, 'docker', 'docker-compose.yaml'), 'utf8');
  assert.ok(!compose.includes('extra_hosts'));
  assert.ok(compose.includes('container_name: peer0.regulator.twohost.trustguard.in'));
});

test('regulator host: only its CA and peer, other nodes as extra_hosts, secrets only for it', () => {
  const { net, cfg } = setup({
    thisHost: { orgs: ['TwoHostRegulatorMSP'], orderer: false, publishAddress: '0.0.0.0' },
    otherHosts: [{ address: '203.0.113.10', orgs: ['TwoHostEmployerMSP'], orderer: true }],
  });
  const m = generate(cfg, net, quiet);
  const compose = fs.readFileSync(path.join(net, 'docker', 'docker-compose.yaml'), 'utf8');
  assert.ok(compose.includes('container_name: peer0.regulator.twohost.trustguard.in'));
  assert.ok(compose.includes('container_name: ca.regulator.twohost.trustguard.in'));
  assert.ok(!compose.includes('container_name: peer0.employer.twohost.trustguard.in'));
  assert.ok(!compose.includes('container_name: orderer.twohost.trustguard.in'));
  assert.ok(compose.includes('- "orderer.twohost.trustguard.in:203.0.113.10"'));
  assert.ok(compose.includes('- "peer0.employer.twohost.trustguard.in:203.0.113.10"'));
  assert.ok(compose.includes('"0.0.0.0:28051:28051"'), 'peer port published for the other host');
  assert.ok(compose.includes('"127.0.0.1:28054:28054"'), 'CA port stays on the bind address');
  const secrets = JSON.parse(fs.readFileSync(path.join(net, 'config', 'secrets', 'secrets.json'), 'utf8'));
  assert.deepEqual(Object.keys(secrets.ca), ['twohost-regulator']);
  assert.deepEqual(Object.keys(secrets.orderer), []);
  assert.equal(m.orderer.hostAddress, '203.0.113.10');
  const derived = JSON.parse(fs.readFileSync(path.join(net, 'config', 'network.derived.json'), 'utf8'));
  assert.equal(derived.orgs.find(o => o.mspId === 'TwoHostEmployerMSP').local, false);
});

test('host.json mistakes are refused', () => {
  const bad = [
    [{ thisHost: { orgs: ['TwoHostEmployerMSP'], orderer: true }, otherHosts: [] }, /TwoHostRegulatorMSP is not placed/],
    [{ thisHost: { orgs: ['TwoHostEmployerMSP', 'TwoHostRegulatorMSP'], orderer: true },
       otherHosts: [{ address: '203.0.113.10', orgs: ['TwoHostRegulatorMSP'], orderer: true }] }, /placed on two hosts[\s\S]*exactly one host/],
    [{ thisHost: { orgs: ['TwoHostEmployerMSP', 'NoSuchMSP'], orderer: true },
       otherHosts: [{ address: 'vm2', orgs: ['TwoHostRegulatorMSP'] }] }, /NoSuchMSP[\s\S]*IPv4/],
  ];
  for (const [h, re] of bad) {
    const { net, cfg } = setup(h);
    assert.throws(() => generate(cfg, net, quiet), re);
  }
});

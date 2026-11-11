'use strict';
/**
 * twoHostEvidence.js — the transaction part of the two-host proof (TG-031). Run on the host with the
 * gateway identity (the employer's host); iinot-network/scripts/two-host-evidence.sh calls it.
 *
 *   node twoHostEvidence.js sos        log one test SOS, then read its block back and list which
 *                                      organisations' peers endorsed it (expected: every endorsing org)
 *   node twoHostEvidence.js refused    the same SOS while the other host's peer is stopped:
 *                                      expected to be refused, because the policy needs that organisation
 *
 * Prints no keys or secrets: transaction ID, block number, endorsing MSP IDs and certificate subjects.
 */
const crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const { common, peer, msp } = require('@hyperledger/fabric-protos');
const tg = require('../common/tgnet');

const mode = process.argv[2] || 'sos';
const now = () => new Date().toISOString();

function endorsersOf(blockBytes, txId) {
  const block = common.Block.deserializeBinary(blockBytes);
  for (const envBytes of block.getData().getDataList_asU8()) {
    const env = common.Envelope.deserializeBinary(envBytes);
    const payload = common.Payload.deserializeBinary(env.getPayload_asU8());
    const ch = common.ChannelHeader.deserializeBinary(payload.getHeader().getChannelHeader_asU8());
    if (ch.getTxId() !== txId) continue;
    const tx = peer.Transaction.deserializeBinary(payload.getData_asU8());
    const out = [];
    for (const action of tx.getActionsList()) {
      const cap = peer.ChaincodeActionPayload.deserializeBinary(action.getPayload_asU8());
      for (const e of cap.getAction().getEndorsementsList()) {
        const id = msp.SerializedIdentity.deserializeBinary(e.getEndorser_asU8());
        const cert = new crypto.X509Certificate(Buffer.from(id.getIdBytes_asU8()));
        out.push({ mspId: id.getMspid(), subject: cert.subject.replace(/\n/g, ', '), issuer: cert.issuer.split('\n').find(l => l.startsWith('CN=')) || '' });
      }
    }
    return { block: Number(block.getHeader().getNumber()), endorsers: out };
  }
  return null;
}

(async () => {
  const m = tg.load();
  const id = tg.identityForRole('gateway');
  const { gateway, client, network } = tg.connect(id, { grpc, connect, signers }, {
    endorseOptions: () => ({ deadline: Date.now() + 20000 }),
    submitOptions:  () => ({ deadline: Date.now() + 10000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 30000 }),
  });
  const contract = network.getContract(m.chaincode.name);
  const incidentId = `TWOHOST-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const raw = JSON.stringify({ device: 'twohost-test-beacon', event: 'SOS', at: now(), note: 'two-host proof (TG-031)' });
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const endorsing = m.orgs.filter(o => o.endorses).map(o => o.mspId);
  console.log(`Network ${m.network.name} · channel ${m.network.channel} · policy ${m.chaincode.policy}`);
  console.log(`Submitting test SOS ${incidentId} as ${id.name} (${id.mspId}) through ${id.peerHostOverride}`);
  try {
    const commit = await contract.submitAsync('LogIncident', { arguments: [incidentId, 'twohost-test-beacon', 'SOS', hash, now(), '80'] });
    const txId = commit.getTransactionId();
    const status = await commit.getStatus();
    if (!status.successful) throw new Error(`transaction ${txId} was not valid: code ${status.code}`);
    if (mode === 'refused') {
      console.log(`UNEXPECTED: ${incidentId} was accepted (tx ${txId}) although the other host's peer should be stopped.`);
      process.exitCode = 1; return;
    }
    const qscc = network.getContract('qscc');
    const blockBytes = await qscc.evaluateTransaction('GetBlockByTxID', m.network.channel, txId);
    const r = endorsersOf(blockBytes, txId);
    console.log(`Committed: tx ${txId} in block ${r.block}`);
    r.endorsers.forEach(e => console.log(`  endorsed by ${e.mspId}: ${e.subject} (issuer ${e.issuer})`));
    const missing = endorsing.filter(x => !r.endorsers.some(e => e.mspId === x));
    if (missing.length) { console.log(`MISSING endorsement from ${missing.join(', ')}`); process.exitCode = 1; }
    else console.log(`OK: endorsed by every endorsing organisation (${endorsing.join(', ')}), each signing on its own host.`);
  } catch (e) {
    const detail = ((e.details || []).map(d => `${d.address}: ${d.message}`).join('; ') || e.message).slice(0, 400);
    if (mode === 'refused') {
      console.log(`OK: ${incidentId} was refused, as expected without the other host's endorsement.`);
      console.log(`  ${e.constructor.name}: ${detail}`);
    } else {
      console.log(`FAILED: ${e.constructor.name}: ${detail}`);
      process.exitCode = 1;
    }
  } finally {
    gateway.close(); client.close();
  }
})().catch(e => { console.error(e.message); process.exit(1); });

'use strict';
/**
 * fabricClient.js — one cached Fabric Gateway connection per wallet identity.
 *
 * Which peer, TLS certificate, MSP, channel and chaincode to use all come from the
 * deployed network model (common/tgnet.js), so the same code serves any network the
 * Network Designer produced. Each identity connects through its own organisation's peer.
 */
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const tg = require('../../common/tgnet');

const cache = new Map();

/**
 * @param {string} identityName  wallet identity, e.g. "supervisor1"
 * @param {string} [mspId]       kept for compatibility with the routes; checked if given
 */
async function getConnection(identityName, mspId) {
  const id = tg.identity(identityName);
  if (mspId && mspId !== id.mspId) {
    throw new Error(`Identity '${identityName}' belongs to ${id.mspId}, not ${mspId}`);
  }
  // A redeploy changes certificates and possibly names: drop stale connections.
  const key = `${tg.derivedFile()}|${identityName}`;
  const stamp = tg.load();
  const hit = cache.get(key);
  if (hit && hit.model === stamp) return hit.conn;
  if (hit) { try { hit.conn.gateway.close(); hit.conn.client.close(); } catch { /* ignore */ } }

  const conn = tg.connect(id, { grpc, connect, signers });
  cache.set(key, { model: stamp, conn });
  return conn;
}

function closeAll() {
  for (const { conn } of cache.values()) {
    try { conn.gateway.close(); conn.client.close(); } catch { /* ignore */ }
  }
  cache.clear();
}

module.exports = { getConnection, closeAll };

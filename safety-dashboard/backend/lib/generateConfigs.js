#!/usr/bin/env node
/**
 * generateConfigs.js — TrustGuard IIoT
 * Generates docker-compose.yaml and configtx.yaml from network-config.json
 *
 * Usage:
 *   node generateConfigs.js <config-file> <network-root>
 *
 * Writes:
 *   <network-root>/docker/docker-compose.yaml
 *   <network-root>/configtx.yaml
 */

const fs   = require('fs');
const path = require('path');
const { normalizeConfig } = require('./normalizeConfig');

// ── Args ──────────────────────────────────────────────────────
const [,, configFile, networkRoot] = process.argv;
if (!configFile || !networkRoot) {
  console.error('Usage: node generateConfigs.js <config-file> <network-root>');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const cfg = normalizeConfig(raw);

const { networkName, channel, chaincode, orgs, ordererOrg } = cfg;
const CHANNEL = channel.name;

// ── docker-compose.yaml ───────────────────────────────────────
function generateDockerCompose(cfg) {
  const { networkName, orgs, ordererOrg } = cfg;

  const networkSlug = ordererOrg.domain.replace(/\./g, '_').replace(/-/g, '_');

  // Volumes section
  const volumes = [
    `  orderer.${ordererOrg.domain}:`,
    ...orgs.map(o => `  peer0.${o.domain}:`),
  ].join('\n');

  // Orderer CA service
  const ordererCaService = `
  ca.${ordererOrg.domain}:
    image: hyperledger/fabric-ca:1.5.17
    environment:
      - FABRIC_CA_HOME=/etc/hyperledger/fabric-ca-server
      - FABRIC_CA_SERVER_CA_NAME=${ordererOrg.caName}
      - FABRIC_CA_SERVER_TLS_ENABLED=true
      - FABRIC_CA_SERVER_PORT=${ordererOrg.caPort}
    ports:
      - "${ordererOrg.caPort}:${ordererOrg.caPort}"
    command: sh -c 'fabric-ca-server start -b admin:adminpw -d'
    volumes:
      - ../organizations/fabric-ca/${ordererOrg.caSlug}:/etc/hyperledger/fabric-ca-server
    container_name: ca.${ordererOrg.domain}
    networks:
      - iinot_network`;

  // Peer org CA services
  const peerCaServices = orgs.map(o => `
  ca.${o.domain}:
    image: hyperledger/fabric-ca:1.5.17
    environment:
      - FABRIC_CA_HOME=/etc/hyperledger/fabric-ca-server
      - FABRIC_CA_SERVER_CA_NAME=${o.caName}
      - FABRIC_CA_SERVER_TLS_ENABLED=true
      - FABRIC_CA_SERVER_PORT=${o.caPort}
    ports:
      - "${o.caPort}:${o.caPort}"
    command: sh -c 'fabric-ca-server start -b admin:adminpw -d'
    volumes:
      - ../organizations/fabric-ca/${o.caSlug}:/etc/hyperledger/fabric-ca-server
    container_name: ca.${o.domain}
    networks:
      - iinot_network`).join('\n');

  // Orderer service
  const ordererService = `
  orderer.${ordererOrg.domain}:
    container_name: orderer.${ordererOrg.domain}
    image: hyperledger/fabric-orderer:2.5.15
    environment:
      - FABRIC_LOGGING_SPEC=INFO
      - ORDERER_GENERAL_LISTENADDRESS=0.0.0.0
      - ORDERER_GENERAL_LISTENPORT=${ordererOrg.port}
      - ORDERER_GENERAL_LOCALMSPID=${ordererOrg.mspId}
      - ORDERER_GENERAL_LOCALMSPDIR=/var/hyperledger/orderer/msp
      - ORDERER_GENERAL_TLS_ENABLED=true
      - ORDERER_GENERAL_TLS_PRIVATEKEY=/var/hyperledger/orderer/tls/server.key
      - ORDERER_GENERAL_TLS_CERTIFICATE=/var/hyperledger/orderer/tls/server.crt
      - ORDERER_GENERAL_TLS_ROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_GENERAL_CLUSTER_CLIENTCERTIFICATE=/var/hyperledger/orderer/tls/server.crt
      - ORDERER_GENERAL_CLUSTER_CLIENTPRIVATEKEY=/var/hyperledger/orderer/tls/server.key
      - ORDERER_GENERAL_BOOTSTRAPMETHOD=none
      - ORDERER_CHANNELPARTICIPATION_ENABLED=true
      - ORDERER_ADMIN_TLS_ENABLED=true
      - ORDERER_ADMIN_TLS_CERTIFICATE=/var/hyperledger/orderer/tls/server.crt
      - ORDERER_ADMIN_TLS_PRIVATEKEY=/var/hyperledger/orderer/tls/server.key
      - ORDERER_ADMIN_TLS_ROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_ADMIN_TLS_CLIENTROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_ADMIN_LISTENADDRESS=0.0.0.0:${ordererOrg.adminPort}
    working_dir: /root
    command: orderer
    volumes:
      - ../organizations/ordererOrganizations/${ordererOrg.domain}/orderers/orderer.${ordererOrg.domain}/msp:/var/hyperledger/orderer/msp
      - ../organizations/ordererOrganizations/${ordererOrg.domain}/orderers/orderer.${ordererOrg.domain}/tls:/var/hyperledger/orderer/tls
      - orderer.${ordererOrg.domain}:/var/hyperledger/production/orderer
    ports:
      - "${ordererOrg.port}:${ordererOrg.port}"
      - "${ordererOrg.adminPort}:${ordererOrg.adminPort}"
    networks:
      - iinot_network`;

  // Peer services
  const peerServices = orgs.map(o => `
  peer0.${o.domain}:
    container_name: peer0.${o.domain}
    image: hyperledger/fabric-peer:2.5.15
    environment:
      - CORE_VM_ENDPOINT=unix:///host/var/run/docker.sock
      - CORE_VM_DOCKER_HOSTCONFIG_NETWORKMODE=iinot_network
      - FABRIC_LOGGING_SPEC=INFO
      - CORE_PEER_TLS_ENABLED=true
      - CORE_PEER_PROFILE_ENABLED=false
      - CORE_PEER_TLS_CERT_FILE=/etc/hyperledger/fabric/tls/server.crt
      - CORE_PEER_TLS_KEY_FILE=/etc/hyperledger/fabric/tls/server.key
      - CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt
      - CORE_PEER_ID=peer0.${o.domain}
      - CORE_PEER_ADDRESS=peer0.${o.domain}:${o.peerPort}
      - CORE_PEER_LISTENADDRESS=0.0.0.0:${o.peerPort}
      - CORE_PEER_CHAINCODEADDRESS=peer0.${o.domain}:${o.chaincodePort}
      - CORE_PEER_CHAINCODELISTENADDRESS=0.0.0.0:${o.chaincodePort}
      - CORE_PEER_GOSSIP_BOOTSTRAP=peer0.${o.domain}:${o.peerPort}
      - CORE_PEER_GOSSIP_EXTERNALENDPOINT=peer0.${o.domain}:${o.peerPort}
      - CORE_PEER_LOCALMSPID=${o.mspId}
      - CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/fabric/msp
      - CORE_OPERATIONS_LISTENADDRESS=peer0.${o.domain}:${o.opsPort}
      - CORE_METRICS_PROVIDER=prometheus
    volumes:
      - /var/run/docker.sock:/host/var/run/docker.sock
      - ../organizations/peerOrganizations/${o.domain}/peers/peer0.${o.domain}/msp:/etc/hyperledger/fabric/msp
      - ../organizations/peerOrganizations/${o.domain}/peers/peer0.${o.domain}/tls:/etc/hyperledger/fabric/tls
      - peer0.${o.domain}:/var/hyperledger/production
    working_dir: /root
    command: peer node start
    ports:
      - "${o.peerPort}:${o.peerPort}"
      - "${o.opsPort}:${o.opsPort}"
    networks:
      - iinot_network`).join('\n');

  return `# Generated by TrustGuard IIoT generateConfigs.js
# Network: ${networkName}

version: "3.7"

volumes:
${volumes}

networks:
  iinot_network:
    name: iinot_network

services:
${ordererCaService}
${peerCaServices}
${ordererService}
${peerServices}

  cli:
    container_name: cli
    image: hyperledger/fabric-tools:2.5.15
    tty: true
    stdin_open: true
    environment:
      - GOPATH=/opt/gopath
      - FABRIC_LOGGING_SPEC=INFO
      - FABRIC_CFG_PATH=/etc/hyperledger/peercfg
      - CORE_PEER_TLS_ENABLED=true
    working_dir: /opt/gopath/src/github.com/hyperledger/fabric/peer
    command: /bin/bash
    volumes:
      - /var/run/docker.sock:/host/var/run/docker.sock
      - ../organizations:/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations
      - ../channel-artifacts:/opt/gopath/src/github.com/hyperledger/fabric/peer/channel-artifacts
    networks:
      - iinot_network
`;
}

// ── configtx.yaml ─────────────────────────────────────────────
function generateConfigtx(cfg) {
  const { networkName, channel, orgs, ordererOrg } = cfg;

  const orgBlocks = orgs.map((o, i) => {
    const anchor = `    - &${o.mspId.replace('MSP', '')}
        Name: ${o.mspId}
        ID:   ${o.mspId}
        MSPDir: organizations/peerOrganizations/${o.domain}/msp
        Policies:
            Readers:
                Type: Signature
                Rule: "OR('${o.mspId}.admin', '${o.mspId}.peer', '${o.mspId}.client')"
            Writers:
                Type: Signature
                Rule: "OR('${o.mspId}.admin', '${o.mspId}.client')"
            Admins:
                Type: Signature
                Rule: "OR('${o.mspId}.admin')"
            Endorsement:
                Type: Signature
                Rule: "OR('${o.mspId}.peer')"
        AnchorPeers:
            - Host: peer0.${o.domain}
              Port: ${o.peerPort}`;
    return anchor;
  }).join('\n\n');

  const ordererOrgBlock = `    - &${ordererOrg.mspId.replace('MSP', '')}
        Name: ${ordererOrg.mspId}
        ID:   ${ordererOrg.mspId}
        MSPDir: organizations/ordererOrganizations/${ordererOrg.domain}/msp
        Policies:
            Readers:
                Type: Signature
                Rule: "OR('${ordererOrg.mspId}.member')"
            Writers:
                Type: Signature
                Rule: "OR('${ordererOrg.mspId}.member')"
            Admins:
                Type: Signature
                Rule: "OR('${ordererOrg.mspId}.admin')"`;

  const peerOrgRefs = orgs.map(o => `                - *${o.mspId.replace('MSP', '')}`).join('\n');

  return `---
# Generated by TrustGuard IIoT generateConfigs.js
# Network: ${networkName}  |  Channel: ${channel.name}

Organizations:

${orgBlocks}

${ordererOrgBlock}

Capabilities:
    Channel: &ChannelCapabilities
        V2_0: true
    Orderer: &OrdererCapabilities
        V2_0: true
    Application: &ApplicationCapabilities
        V2_5: true

Application: &ApplicationDefaults
    Organizations:
    Policies:
        Readers:
            Type: ImplicitMeta
            Rule: "ANY Readers"
        Writers:
            Type: ImplicitMeta
            Rule: "ANY Writers"
        Admins:
            Type: ImplicitMeta
            Rule: "MAJORITY Admins"
        LifecycleEndorsement:
            Type: ImplicitMeta
            Rule: "MAJORITY Endorsement"
        Endorsement:
            Type: ImplicitMeta
            Rule: "MAJORITY Endorsement"
    Capabilities:
        <<: *ApplicationCapabilities

Orderer: &OrdererDefaults
    OrdererType: etcdraft
    Addresses:
    - orderer.${ordererOrg.domain}:${ordererOrg.port}
    EtcdRaft:
        Consenters:

            - Host: orderer.${ordererOrg.domain}
              Port: ${ordererOrg.port}
              ClientTLSCert: organizations/ordererOrganizations/${ordererOrg.domain}/orderers/orderer.${ordererOrg.domain}/tls/server.crt
              ServerTLSCert: organizations/ordererOrganizations/${ordererOrg.domain}/orderers/orderer.${ordererOrg.domain}/tls/server.crt
        Options:
            TickInterval:         500ms
            ElectionTick:         10
            HeartbeatTick:        1
            MaxInflightBlocks:    5
            SnapshotIntervalSize: 16 MB
    BatchTimeout: 2s
    BatchSize:
        MaxMessageCount:   10
        AbsoluteMaxBytes:  99 MB
        PreferredMaxBytes: 512 KB
    Organizations:
    Policies:
        Readers:
            Type: ImplicitMeta
            Rule: "ANY Readers"
        Writers:
            Type: ImplicitMeta
            Rule: "ANY Writers"
        Admins:
            Type: ImplicitMeta
            Rule: "MAJORITY Admins"
        BlockValidation:
            Type: ImplicitMeta
            Rule: "ANY Writers"
    Capabilities:
        <<: *OrdererCapabilities

Channel: &ChannelDefaults
    Policies:
        Readers:
            Type: ImplicitMeta
            Rule: "ANY Readers"
        Writers:
            Type: ImplicitMeta
            Rule: "ANY Writers"
        Admins:
            Type: ImplicitMeta
            Rule: "MAJORITY Admins"
    Capabilities:
        <<: *ChannelCapabilities

Profiles:
    IINoTSafetyGenesis:
        <<: *ChannelDefaults
        Orderer:
            <<: *OrdererDefaults
            Organizations:
                - *${ordererOrg.mspId.replace('MSP', '')}
            Capabilities:
                <<: *OrdererCapabilities
        Application:
            <<: *ApplicationDefaults
            Organizations:
${peerOrgRefs}
            Capabilities:
                <<: *ApplicationCapabilities
`;
}

// ── Write files ───────────────────────────────────────────────
const dockerDir = path.join(networkRoot, 'docker');
fs.mkdirSync(dockerDir, { recursive: true });

const dockerCompose = generateDockerCompose(cfg);
fs.writeFileSync(path.join(dockerDir, 'docker-compose.yaml'), dockerCompose);
console.log('[INFO] Written: docker/docker-compose.yaml');

const configtx = generateConfigtx(cfg);
fs.writeFileSync(path.join(networkRoot, 'configtx.yaml'), configtx);
console.log('[INFO] Written: configtx.yaml');

// Do NOT overwrite the canonical config with the normalized shape —
// normalizeConfig() produces a different key layout (.orgs not .organizations)
// which breaks config-reader.sh and the frontend.
// console.log('[INFO] Skipping normalized config write-back to preserve canonical schema');

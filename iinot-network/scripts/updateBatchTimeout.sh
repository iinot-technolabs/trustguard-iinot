#!/bin/bash
# Updates BatchTimeout on a running iinot-safety-channel
# Usage: ./scripts/updateBatchTimeout.sh 500ms

set -e
cd "$(dirname "$0")/.."

NEW_TIMEOUT=${1:-500ms}
CHANNEL=iinot-safety-channel
ORDERER=localhost:7050
ORDERER_CA=${PWD}/organizations/ordererOrganizations/iinot-safety.com/orderers/orderer.iinot-safety.com/tls/tlscacerts/tls-localhost-9054-ca-iinot-orderer.pem

export PATH=/root/fabric/bin:$PATH
export FABRIC_CFG_PATH=${PWD}

# Set peer env for IINoTIndustryMSP
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID=IINoTIndustryMSP
export CORE_PEER_TLS_ROOTCERT_FILE=${PWD}/organizations/peerOrganizations/iinot-industry.com/peers/peer0.iinot-industry.com/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=${PWD}/organizations/peerOrganizations/iinot-industry.com/users/Admin@iinot-industry.com/msp
export CORE_PEER_ADDRESS=localhost:7051

echo "[INFO] Fetching current channel config..."
peer channel fetch config config_block.pb \
    -o ${ORDERER} --ordererTLSHostnameOverride orderer.iinot-safety.com \
    -c ${CHANNEL} --tls --cafile ${ORDERER_CA}

echo "[INFO] Decoding config block..."
configtxlator proto_decode --input config_block.pb \
    --type common.Block | jq .data.data[0].payload.data.config \
    > config.json

echo "[INFO] Updating BatchTimeout to ${NEW_TIMEOUT}..."
jq --arg timeout "${NEW_TIMEOUT}" \
    '.channel_group.groups.Orderer.values.BatchTimeout.value.timeout = $timeout' \
    config.json > modified_config.json

echo "[INFO] Encoding configs..."
configtxlator proto_encode --input config.json \
    --type common.Config --output config.pb

configtxlator proto_encode --input modified_config.json \
    --type common.Config --output modified_config.pb

echo "[INFO] Computing config delta..."
configtxlator compute_update \
    --channel_id ${CHANNEL} \
    --original config.pb \
    --updated modified_config.pb \
    --output config_update.pb

echo "[INFO] Wrapping update in envelope..."
echo '{"payload":{"header":{"channel_header":{"channel_id":"'${CHANNEL}'","type":2}},"data":{"config_update":{}}}}' \
    | jq ".payload.data.config_update = $(configtxlator proto_decode \
        --input config_update.pb --type common.ConfigUpdate)" \
    > config_update_envelope.json

configtxlator proto_encode --input config_update_envelope.json \
    --type common.Envelope --output config_update_envelope.pb

echo "[INFO] Signing update as IINoTIndustryMSP..."
peer channel signconfigtx -f config_update_envelope.pb

echo "[INFO] Signing update as IINoTRegulatorMSP..."
export CORE_PEER_LOCALMSPID=IINoTRegulatorMSP
export CORE_PEER_TLS_ROOTCERT_FILE=${PWD}/organizations/peerOrganizations/iinot-regulator.com/peers/peer0.iinot-regulator.com/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=${PWD}/organizations/peerOrganizations/iinot-regulator.com/users/Admin@iinot-regulator.com/msp
export CORE_PEER_ADDRESS=localhost:9051
peer channel signconfigtx -f config_update_envelope.pb

echo "[INFO] Submitting update as IINoTOrdererMSP Admin..."
export CORE_PEER_LOCALMSPID=IINoTOrdererMSP
export CORE_PEER_MSPCONFIGPATH=${PWD}/organizations/ordererOrganizations/iinot-safety.com/users/Admin@iinot-safety.com/msp

peer channel update -f config_update_envelope.pb \
    -c ${CHANNEL} \
    -o ${ORDERER} --ordererTLSHostnameOverride orderer.iinot-safety.com \
    --tls --cafile ${ORDERER_CA}

echo "[SUCCESS] BatchTimeout updated to ${NEW_TIMEOUT} on ${CHANNEL}"

# Cleanup
rm -f config_block.pb config.json modified_config.json \
       config.pb modified_config.pb config_update.pb \
       config_update_envelope.json config_update_envelope.pb

#!/bin/bash
# network.sh — TrustGuard IIoT Network Orchestration
# Reads all org/channel/chaincode config from config/network-config.json
#
# Usage:
#   ./scripts/network.sh up       — bring up CAs + peers + orderer
#   ./scripts/network.sh down     — tear everything down
#   ./scripts/network.sh channel  — create channel
#   ./scripts/network.sh deploy   — deploy chaincode
#   ./scripts/network.sh all      — up + channel + deploy (full bootstrap)

set -e
cd "$(dirname "$0")/.."  # always run from iinot-network root

export PATH=/root/fabric/bin:$PATH
export FABRIC_CFG_PATH=${PWD}

. scripts/utils.sh

# ── Load config ───────────────────────────────────────────────
. scripts/config-reader.sh

# ── Start Certificate Authority containers ────────────────────
function startCAs() {
    infoln "Starting CA containers..."

    # Build list of CA service names from config
    CA_SERVICES=()
    # Orderer CA
    CA_SERVICES+=("ca.${ORDERER_DOMAIN}")
    # Peer org CAs
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        CA_SERVICES+=("ca.${ORG_DOMAINS[$i]}")
    done

    docker compose -f docker/docker-compose.yaml up -d "${CA_SERVICES[@]}"
    infoln "Waiting for CAs to initialise..."
    sleep 5
}

# ── Generate cryptographic identities ────────────────────────
function generateIdentities() {
    infoln "Generating cryptographic identities via Fabric CA..."
    . scripts/registerEnroll.sh

    # Call per-org enroll function for each peer org
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        enrollPeerOrg "$i"
    done

    # Orderer org
    enrollOrdererOrg

    successln "All identities generated."
}

# ── Start peer and orderer containers ─────────────────────────
function startNetwork() {
    infoln "Starting peer and orderer containers..."

    PEER_SERVICES=()
    PEER_SERVICES+=("orderer.${ORDERER_DOMAIN}")
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        PEER_SERVICES+=("peer0.${ORG_DOMAINS[$i]}")
    done
    PEER_SERVICES+=("cli")

    docker compose -f docker/docker-compose.yaml up -d "${PEER_SERVICES[@]}"
    infoln "Waiting for peers to start..."
    sleep 3
    successln "Network is up."
    docker ps --format "table {{.Names}}\t{{.Status}}"
}

# ── Create channel and join all peers ─────────────────────────
function createChannel() {
    infoln "Generating genesis block with configtxgen..."
    export FABRIC_CFG_PATH=${PWD}

    if [ ! -f "${PWD}/core.yaml" ]; then
        cp "/root/fabric/config/core.yaml" "${PWD}/core.yaml"
        infoln "Copied core.yaml to network root"
    fi

    configtxgen \
        -profile IINoTSafetyGenesis \
        -outputBlock ./channel-artifacts/${CHANNEL_NAME}.block \
        -channelID ${CHANNEL_NAME}

    infoln "Joining orderer to channel..."
    export ORDERER_CA="${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/orderer.${ORDERER_DOMAIN}/tls/ca.crt"
    export ORDERER_ADMIN_TLS_SIGN_CERT="${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/orderer.${ORDERER_DOMAIN}/tls/server.crt"
    export ORDERER_ADMIN_TLS_PRIVATE_KEY="${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/orderer.${ORDERER_DOMAIN}/tls/server.key"

    osnadmin channel join \
        --channelID ${CHANNEL_NAME} \
        --config-block ./channel-artifacts/${CHANNEL_NAME}.block \
        -o localhost:${ORDERER_ADMIN_PORT} \
        --ca-file "${ORDERER_CA}" \
        --client-cert "${ORDERER_ADMIN_TLS_SIGN_CERT}" \
        --client-key "${ORDERER_ADMIN_TLS_PRIVATE_KEY}"

    # Join each peer org
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        infoln "Joining peer0.${ORG_DOMAINS[$i]} to channel..."
        export CORE_PEER_TLS_ENABLED=true
        export CORE_PEER_LOCALMSPID="${ORG_MSPIDS[$i]}"
        export CORE_PEER_TLS_ROOTCERT_FILE="${PWD}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/peers/peer0.${ORG_DOMAINS[$i]}/tls/ca.crt"
        export CORE_PEER_MSPCONFIGPATH="${PWD}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/users/Admin@${ORG_DOMAINS[$i]}/msp"
        export CORE_PEER_ADDRESS="localhost:${ORG_PEER_PORTS[$i]}"

        peer channel join -b ./channel-artifacts/${CHANNEL_NAME}.block
    done

    successln "Channel '${CHANNEL_NAME}' created and all peers joined."
}

# ── Deploy chaincode ──────────────────────────────────────────
function deployChaincode() {
    infoln "Packaging chaincode '${CC_NAME}'..."
    peer lifecycle chaincode package ${CC_NAME}.tar.gz \
        --path ${CC_PATH} \
        --lang ${CC_LANG} \
        --label ${CC_NAME}_1.0

    # Install on all peer orgs
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        export CORE_PEER_TLS_ENABLED=true
        export CORE_PEER_LOCALMSPID="${ORG_MSPIDS[$i]}"
        export CORE_PEER_TLS_ROOTCERT_FILE="${PWD}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/peers/peer0.${ORG_DOMAINS[$i]}/tls/ca.crt"
        export CORE_PEER_MSPCONFIGPATH="${PWD}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/users/Admin@${ORG_DOMAINS[$i]}/msp"
        export CORE_PEER_ADDRESS="localhost:${ORG_PEER_PORTS[$i]}"

        infoln "Installing chaincode on peer0.${ORG_DOMAINS[$i]}..."
        peer lifecycle chaincode install ${CC_NAME}.tar.gz
    done

    # Get package ID (query from first org)
    export CORE_PEER_LOCALMSPID="${ORG_MSPIDS[0]}"
    export CORE_PEER_ADDRESS="localhost:${ORG_PEER_PORTS[0]}"
    export CORE_PEER_TLS_ROOTCERT_FILE="${PWD}/organizations/peerOrganizations/${ORG_DOMAINS[0]}/peers/peer0.${ORG_DOMAINS[0]}/tls/ca.crt"
    export CORE_PEER_MSPCONFIGPATH="${PWD}/organizations/peerOrganizations/${ORG_DOMAINS[0]}/users/Admin@${ORG_DOMAINS[0]}/msp"

    CC_PACKAGE_ID=$(peer lifecycle chaincode queryinstalled \
        --output json | jq -r '.installed_chaincodes[0].package_id')
    infoln "Package ID: ${CC_PACKAGE_ID}"

    export ORDERER_CA="${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/orderer.${ORDERER_DOMAIN}/tls/ca.crt"

    # Approve for each org
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        export CORE_PEER_LOCALMSPID="${ORG_MSPIDS[$i]}"
        export CORE_PEER_ADDRESS="localhost:${ORG_PEER_PORTS[$i]}"
        export CORE_PEER_TLS_ROOTCERT_FILE="${PWD}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/peers/peer0.${ORG_DOMAINS[$i]}/tls/ca.crt"
        export CORE_PEER_MSPCONFIGPATH="${PWD}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/users/Admin@${ORG_DOMAINS[$i]}/msp"

        infoln "Approving chaincode for ${ORG_MSPIDS[$i]}..."
        peer lifecycle chaincode approveformyorg \
            -o localhost:${ORDERER_PORT} \
            --ordererTLSHostnameOverride orderer.${ORDERER_DOMAIN} \
            --channelID ${CHANNEL_NAME} \
            --name ${CC_NAME} \
            --version 1.0 \
            --package-id ${CC_PACKAGE_ID} \
            --sequence 1 \
            --tls --cafile "${ORDERER_CA}"
    done

    # Commit — build peer address + cert flag list dynamically
    export CORE_PEER_LOCALMSPID="${ORG_MSPIDS[0]}"
    export CORE_PEER_ADDRESS="localhost:${ORG_PEER_PORTS[0]}"
    export CORE_PEER_TLS_ROOTCERT_FILE="${PWD}/organizations/peerOrganizations/${ORG_DOMAINS[0]}/peers/peer0.${ORG_DOMAINS[0]}/tls/ca.crt"
    export CORE_PEER_MSPCONFIGPATH="${PWD}/organizations/peerOrganizations/${ORG_DOMAINS[0]}/users/Admin@${ORG_DOMAINS[0]}/msp"

    PEER_ADDR_FLAGS=()
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        PEER_ADDR_FLAGS+=(--peerAddresses "localhost:${ORG_PEER_PORTS[$i]}")
        PEER_ADDR_FLAGS+=(--tlsRootCertFiles "${PWD}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/peers/peer0.${ORG_DOMAINS[$i]}/tls/ca.crt")
    done

    infoln "Committing chaincode definition to channel..."
    peer lifecycle chaincode commit \
        -o localhost:${ORDERER_PORT} \
        --ordererTLSHostnameOverride orderer.${ORDERER_DOMAIN} \
        --channelID ${CHANNEL_NAME} \
        --name ${CC_NAME} \
        --version 1.0 \
        --sequence 1 \
        --tls --cafile "${ORDERER_CA}" \
        "${PEER_ADDR_FLAGS[@]}"

    successln "Chaincode '${CC_NAME}' deployed to '${CHANNEL_NAME}'."
}

# ── Tear down network ─────────────────────────────────────────
function networkDown() {
    infoln "Tearing down network: ${NETWORK_NAME}..."
    docker compose -f docker/docker-compose.yaml down --volumes --remove-orphans
    docker ps -a --filter "name=dev-peer" --format "{{.ID}}" | xargs -r docker rm -f
    docker images --filter "reference=dev-peer*" --format "{{.ID}}" | xargs -r docker rmi -f

    sudo rm -rf organizations/peerOrganizations
    sudo rm -rf organizations/ordererOrganizations

    # Remove per-org CA data
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        sudo rm -rf "organizations/fabric-ca/${ORG_CA_SLUGS[$i]}"
    done
    sudo rm -rf "organizations/fabric-ca/${ORDERER_CA_SLUG}"

    rm -rf channel-artifacts/*.block
    rm -f ${CC_NAME}.tar.gz
    successln "Network torn down. All crypto material removed."
}

# ── Main entrypoint ───────────────────────────────────────────
case "$1" in
    up)
        startCAs
        generateIdentities
        startNetwork
        ;;
    channel)
        createChannel
        ;;
    deploy)
        deployChaincode
        ;;
    down)
        networkDown
        ;;
    all)
        startCAs
        generateIdentities
        startNetwork
        createChannel
        deployChaincode
        successln "Deployment complete. Network is ready."
        ;;
    *)
        echo "Usage: ./scripts/network.sh [up|channel|deploy|down|all]"
        exit 1
        ;;
esac

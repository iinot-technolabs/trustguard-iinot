#!/bin/bash
# network.sh — TrustGuard IIoT network orchestration (fresh installs).
#
# Every name, port and version comes from config/network-config.json (written by the
# Network Designer) via generateConfigs.js → config/network.derived.json.
#
# Usage: ./scripts/network.sh <mode>
#   generate    validate the network config and (re)generate compose, configtx, app.env, secrets
#   up          generate + start CAs, register/enrol identities, start orderer and peers
#   channel     create the channel and join the orderer and every peer
#   deploy      package, install, approve (with the endorsement policy) and commit the chaincode
#   identities  enrol the app users (gateway, supervisor, auditor, oracle, claims-reviewer) into the wallet
#   all         generate + up + channel + deploy + identities
#   status      containers, channel membership and the committed chaincode definition
#   down        stop everything and delete this network's crypto material, ledgers and wallet entries
#
# Environment: TG_HOME (default: repo root), FABRIC_BIN (default: $TG_HOME/bin), NODE_BIN (default: node)

set -eo pipefail
cd "$(dirname "$0")/.."                      # iinot-network/
NETWORK_ROOT="${PWD}"
TG_HOME="${TG_HOME:-$(cd .. && pwd)}"
FABRIC_BIN="${FABRIC_BIN:-${TG_HOME}/bin}"
NODE_BIN="${NODE_BIN:-node}"
export PATH="${FABRIC_BIN}:${PATH}"
export FABRIC_CFG_PATH="${NETWORK_ROOT}"     # configtx.yaml + core.yaml live here

. scripts/utils.sh

GENERATOR="${TG_HOME}/safety-dashboard/backend/lib/generateConfigs.js"
CONFIG_FILE="${NETWORK_ROOT}/config/network-config.json"

# ── helpers ───────────────────────────────────────────────────
retry() {   # retry <attempts> <delay-seconds> <command...>
    local n=$1 d=$2 i; shift 2
    for i in $(seq 1 "${n}"); do
        "$@" && return 0
        [ "${i}" -lt "${n}" ] && { warnln "  attempt ${i}/${n} failed; retrying in ${d}s"; sleep "${d}"; }
    done
    return 1
}

setPeerEnv() {   # setPeerEnv <org index>
    local i=$1
    export CORE_PEER_TLS_ENABLED=true
    export CORE_PEER_LOCALMSPID="${ORG_MSPIDS[$i]}"
    export CORE_PEER_TLS_ROOTCERT_FILE="${NETWORK_ROOT}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/peers/${ORG_PEER_HOSTS[$i]}/tls/ca.crt"
    export CORE_PEER_MSPCONFIGPATH="${NETWORK_ROOT}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/users/Admin@${ORG_DOMAINS[$i]}/msp"
    export CORE_PEER_ADDRESS="localhost:${ORG_PEER_PORTS[$i]}"   # peer TLS certs carry localhost as a SAN
}

ordererTlsCa() {
    echo "${NETWORK_ROOT}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/${ORDERER_HOST}/tls/ca.crt"
}

loadConfig() { . scripts/config-reader.sh; }

compose() {
    docker compose -p "${DOCKER_NETWORK}" --env-file "${COMPOSE_ENV}" -f docker/docker-compose.yaml "$@"
}

# ── runtime (Docker by default) ───────────────────────────────
# Rehearsals can set TG_RUNTIME_SHIM to a file that redefines these three functions
# to run the same binaries as native processes. Production never sets it.
runtimeStartCAs() {
    local svcs=("ca.${ORDERER_DOMAIN}") i
    for i in $(seq 0 $((ORG_COUNT - 1))); do svcs+=("ca.${ORG_DOMAINS[$i]}"); done
    compose up -d "${svcs[@]}"
}
runtimeStartNodes() {
    local svcs=("${ORDERER_HOST}") i
    for i in $(seq 0 $((ORG_COUNT - 1))); do svcs+=("${ORG_PEER_HOSTS[$i]}"); done
    compose up -d "${svcs[@]}"
}
runtimeDown() {
    compose down --volumes --remove-orphans || true
    local i
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        docker ps -aq --filter "name=dev-${ORG_PEER_HOSTS[$i]}-" | xargs -r docker rm -f
        docker images -q --filter "reference=dev-${ORG_PEER_HOSTS[$i]}-*" | xargs -r docker rmi -f
    done
}
if [ -n "${TG_RUNTIME_SHIM}" ]; then
    # shellcheck source=/dev/null
    . "${TG_RUNTIME_SHIM}"
fi

# ── modes ─────────────────────────────────────────────────────
generate() {
    if [ ! -f "${CONFIG_FILE}" ]; then
        errorln "${CONFIG_FILE} not found. Save the network in the Network Designer first,"
        errorln "or copy an example:  cp ../examples/iinot-demo.network-config.json config/network-config.json"
        exit 1
    fi
    "${NODE_BIN}" "${GENERATOR}" "${CONFIG_FILE}" "${NETWORK_ROOT}"
}

requireFresh() {   # checked before anything is generated, so a running network's files stay untouched
    if [ -d organizations/peerOrganizations ] || [ -d organizations/ordererOrganizations ]; then
        errorln "A network already exists here. This package does fresh installs only: run './scripts/network.sh down' first."
        exit 1
    fi
}

networkUp() {
    loadConfig
    infoln "Starting CAs..."
    runtimeStartCAs
    . scripts/registerEnroll.sh
    local i
    for i in $(seq 0 $((ORG_COUNT - 1))); do enrollPeerOrg "${i}"; done
    enrollOrdererOrg
    infoln "Starting orderer and peers..."
    runtimeStartNodes
    successln "Network is up."
}

createChannel() {
    loadConfig
    mkdir -p channel-artifacts

    local OADMIN="${NETWORK_ROOT}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/${ORDERER_HOST}/tls"
    local OSN=(-o "localhost:${ORDERER_ADMIN_PORT}" --ca-file "${OADMIN}/ca.crt" --client-cert "${OADMIN}/server.crt" --client-key "${OADMIN}/server.key")
    if osnadmin channel list --channelID "${CHANNEL_NAME}" "${OSN[@]}" 2>/dev/null | grep -q '"name": *"'"${CHANNEL_NAME}"'"'; then
        infoln "${ORDERER_HOST} is already a member of '${CHANNEL_NAME}'"
    else
        # A channel that exists keeps its genesis block: only create one when the orderer has none.
        infoln "Creating genesis block for '${CHANNEL_NAME}' (profile ${GENESIS_PROFILE})..."
        configtxgen -profile "${GENESIS_PROFILE}" -outputBlock "./channel-artifacts/${CHANNEL_NAME}.block" -channelID "${CHANNEL_NAME}"
        infoln "Joining ${ORDERER_HOST} to the channel..."
        retry 10 3 osnadmin channel join --channelID "${CHANNEL_NAME}" --config-block "./channel-artifacts/${CHANNEL_NAME}.block" "${OSN[@]}"
    fi

    local i
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        setPeerEnv "${i}"
        if peer channel list 2>/dev/null | grep -qx "${CHANNEL_NAME}"; then
            infoln "${ORG_PEER_HOSTS[$i]} has already joined"
            continue
        fi
        infoln "Joining ${ORG_PEER_HOSTS[$i]}..."
        retry 10 3 peer channel join -b "./channel-artifacts/${CHANNEL_NAME}.block"
    done
    successln "Channel '${CHANNEL_NAME}' created; ${ORG_COUNT} peers joined."
}

packageId() {   # package ID of CC_LABEL on the current peer, empty if not installed
    peer lifecycle chaincode queryinstalled --output json 2>/dev/null \
        | jq -r --arg l "${CC_LABEL}" '.installed_chaincodes[]? | select(.label == $l) | .package_id' | head -1
}

deployChaincode() {
    loadConfig
    local ORDERER_CA; ORDERER_CA="$(ordererTlsCa)"
    local PKG="${NETWORK_ROOT}/channel-artifacts/${CC_LABEL}.tar.gz"
    local OFLAGS=(-o "localhost:${ORDERER_PORT}" --ordererTLSHostnameOverride "${ORDERER_HOST}" --tls --cafile "${ORDERER_CA}")
    local DEF=(--channelID "${CHANNEL_NAME}" --name "${CC_NAME}" --version "${CC_VERSION}" --sequence "${CC_SEQUENCE}" --signature-policy "${CC_POLICY}")

    infoln "Packaging ${CC_LABEL} from ${CC_PATH}"
    [ -f "${CC_PATH}/package.json" ] || { errorln "No chaincode at ${CC_PATH}"; exit 1; }
    peer lifecycle chaincode package "${PKG}" --path "${CC_PATH}" --lang "${CC_LANG}" --label "${CC_LABEL}"

    local i PKG_ID=""
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        setPeerEnv "${i}"
        if [ -n "$(packageId)" ]; then
            infoln "${CC_LABEL} already installed on ${ORG_PEER_HOSTS[$i]}"
        else
            infoln "Installing ${CC_LABEL} on ${ORG_PEER_HOSTS[$i]} (first build can take a few minutes)..."
            retry 3 10 peer lifecycle chaincode install "${PKG}"
        fi
        local id; id="$(packageId)"
        [ -n "${id}" ] || { errorln "Package ${CC_LABEL} not found on ${ORG_PEER_HOSTS[$i]} after install"; exit 1; }
        [ -z "${PKG_ID}" ] && PKG_ID="${id}"
        [ "${id}" = "${PKG_ID}" ] || { errorln "Package ID differs on ${ORG_PEER_HOSTS[$i]} (${id} vs ${PKG_ID})"; exit 1; }
    done
    infoln "Package ID: ${PKG_ID}"

    if committedSequence; then
        infoln "Sequence ${CC_SEQUENCE} of ${CC_NAME} is already committed; verifying only."
        verifyCommitted
        return
    fi

    for i in $(seq 0 $((ORG_COUNT - 1))); do
        setPeerEnv "${i}"
        if [ "$(approvedBy "${ORG_MSPIDS[$i]}")" = "true" ]; then
            infoln "${ORG_MSPIDS[$i]} has already approved this definition"
            continue
        fi
        infoln "Approving for ${ORG_MSPIDS[$i]} (policy ${CC_POLICY})..."
        retry 3 5 peer lifecycle chaincode approveformyorg "${OFLAGS[@]}" "${DEF[@]}" --package-id "${PKG_ID}"
    done

    setPeerEnv 0
    infoln "Commit readiness:"
    peer lifecycle chaincode checkcommitreadiness "${DEF[@]}" --output json | jq -c '.approvals'

    local PEERFLAGS=()
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        PEERFLAGS+=(--peerAddresses "localhost:${ORG_PEER_PORTS[$i]}"
                    --tlsRootCertFiles "${NETWORK_ROOT}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/peers/${ORG_PEER_HOSTS[$i]}/tls/ca.crt")
    done
    infoln "Committing ${CC_NAME} ${CC_VERSION} (sequence ${CC_SEQUENCE})..."
    retry 3 5 peer lifecycle chaincode commit "${OFLAGS[@]}" "${DEF[@]}" "${PEERFLAGS[@]}"

    verifyCommitted
    successln "Chaincode ${CC_NAME} ${CC_VERSION} committed on '${CHANNEL_NAME}' with ${CC_POLICY}."
}

approvedBy() {   # true/false: has <mspid> approved the current definition (asked from the current peer)
    peer lifecycle chaincode checkcommitreadiness --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" \
        --version "${CC_VERSION}" --sequence "${CC_SEQUENCE}" --signature-policy "${CC_POLICY}" --output json 2>/dev/null \
        | jq -r --arg m "$1" '.approvals[$m] // false'
}

committedSequence() {   # success if CC_SEQUENCE (or later) is already committed
    setPeerEnv 0
    local s
    s="$(peer lifecycle chaincode querycommitted --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" --output json 2>/dev/null | jq -r '.sequence // 0')"
    [ -n "${s}" ] && [ "${s}" -ge "${CC_SEQUENCE}" ]
}

verifyCommitted() {
    setPeerEnv 0
    local q
    q="$(retry 5 2 peer lifecycle chaincode querycommitted --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" --output json)"
    local v s
    v="$(echo "${q}" | jq -r .version)"; s="$(echo "${q}" | jq -r .sequence)"
    echo "${q}" | jq -c '{version, sequence, approvals}'
    [ "${v}" = "${CC_VERSION}" ] && [ "${s}" = "${CC_SEQUENCE}" ] || { errorln "Committed ${v}/${s}, expected ${CC_VERSION}/${CC_SEQUENCE}"; return 1; }
    # validation_parameter is the serialized policy; check every endorsing MSP is in it
    local vp; vp="$(echo "${q}" | jq -r .validation_parameter | base64 -d 2>/dev/null | tr -c '[:print:]' ' ')"
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        if [ "${ORG_ENDORSES[$i]}" = "true" ] && ! grep -q "${ORG_MSPIDS[$i]}" <<<"${vp}"; then
            errorln "Committed policy does not include ${ORG_MSPIDS[$i]}"; return 1
        fi
        if [ "${ORG_ENDORSES[$i]}" != "true" ] && grep -q "${ORG_MSPIDS[$i]}" <<<"${vp}"; then
            errorln "Committed policy includes non-endorsing org ${ORG_MSPIDS[$i]}"; return 1
        fi
    done
    infoln "Committed definition matches: ${CC_VERSION}, sequence ${CC_SEQUENCE}, endorsers from config."
}

enrollIdentities() {
    loadConfig
    . scripts/registerEnroll.sh
    mkdir -p "${WALLET_DIR}"; chmod 700 "${WALLET_DIR}"
    local i entry n=0
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        for entry in ${ORG_USERS[$i]}; do
            enrollAppUser "${i}" "${entry%%:*}" "${entry#*:}"
            n=$((n + 1))
        done
    done
    successln "${n} app identities in ${WALLET_DIR}"
}

networkStatus() {
    loadConfig
    if [ -z "${TG_RUNTIME_SHIM}" ]; then
        compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}' || true
    fi
    local i
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        setPeerEnv "${i}"
        echo "${ORG_PEER_HOSTS[$i]}: $(peer channel list 2>/dev/null | tail -n +2 | tr '\n' ' ')"
    done
    verifyCommitted || true
}

networkDown() {
    if [ ! -f config/network.derived.json ]; then
        warnln "No derived config; nothing to tear down."
        return 0
    fi
    loadConfig
    if [ -t 0 ] && [ "${1}" != "-y" ]; then
        read -r -p "Delete network '${NETWORK_NAME}' (ledgers, crypto material, wallet entries)? [y/N] " a
        [ "${a}" = "y" ] || [ "${a}" = "Y" ] || { infoln "Cancelled."; exit 0; }
    fi
    infoln "Tearing down ${NETWORK_NAME}..."
    runtimeDown
    rm -rf organizations/peerOrganizations organizations/ordererOrganizations
    rm -rf "organizations/fabric-ca/${ORDERER_CA_SLUG}"
    local i entry
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        rm -rf "organizations/fabric-ca/${ORG_CA_SLUGS[$i]}"
        for entry in ${ORG_USERS[$i]}; do rm -rf "${WALLET_DIR:?}/${entry%%:*}"; done
    done
    rm -rf channel-artifacts
    successln "Network torn down. Secrets in config/secrets/ are kept; delete that folder to rotate them."
}

case "$1" in
    generate)   generate ;;
    up)         requireFresh; generate; networkUp ;;
    channel)    createChannel ;;
    deploy)     deployChaincode ;;
    identities) enrollIdentities ;;
    status)     networkStatus ;;
    down)       networkDown "$2" ;;
    all)
        requireFresh
        generate
        networkUp
        createChannel
        deployChaincode
        enrollIdentities
        successln "Deployment complete. Network is ready."
        ;;
    *)
        echo "Usage: ./scripts/network.sh [generate|up|channel|deploy|identities|all|status|down [-y]]"
        exit 1
        ;;
esac

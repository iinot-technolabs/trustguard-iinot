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
#   rules       store the Rules Designer rules on the channel (chaincode 1.4 SetRules; defaults if none saved)
#   identities  enrol the app users (gateway, supervisor, auditor, oracle, claims-reviewer) into the wallet
#   all         generate + up + channel + deploy + rules + identities
#   status      containers, channel membership and the committed chaincode definition
#   down        stop everything and delete this network's crypto material, ledgers and wallet entries
#
# Two hosts (config/host.json, TG-031; see docs/TWO_HOST.md). Each host runs only its own organisations;
# private keys are created on that host and never leave it. Only public material moves between hosts:
#   export-org [file]   write this host's public MSP bundle (CA and TLS CA certificates, NodeOU config)
#   import-org <file>   add another host's public bundle (refuses private keys and this host's own orgs)
#   hosts               write the other hosts' node names into /etc/hosts (also done by 'up')
# Then up / channel / deploy / rules / identities work on this host's part only: 'channel' on the host
# without the orderer joins from the copied channel block; 'deploy' approves for this host's orgs and
# the orderer's host commits once every organisation has approved.
#
# Environment: TG_HOME (default: repo root), FABRIC_BIN (default: $TG_HOME/bin), NODE_BIN (default: node)
#
# The CA enrolment sequence and the NodeOU config.yaml layout follow the pattern of
# hyperledger/fabric-samples test-network (organizations/fabric-ca/registerEnroll.sh, network.sh),
# Apache License 2.0, https://github.com/hyperledger/fabric-samples. This file is a rewrite for
# TrustGuard IIoT (config-driven names, ports and secrets); no fabric-samples file is copied verbatim.

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

# Orderer client flags: localhost when the orderer runs here, its name (resolved via /etc/hosts) when not.
ordererFlags() {
    local addr="localhost:${ORDERER_PORT}"
    [ "${ORDERER_LOCAL}" = "true" ] || addr="${ORDERER_HOST}:${ORDERER_PORT}"
    echo "-o ${addr} --ordererTLSHostnameOverride ${ORDERER_HOST} --tls --cafile $(ordererTlsCa)"
}

# --peerAddresses/--tlsRootCertFiles for one org: localhost for this host's peers, the peer name otherwise
peerFlagsFor() {   # peerFlagsFor <org index>  → appends to the PEERFLAGS array
    local i=$1 addr="localhost:${ORG_PEER_PORTS[$1]}"
    isLocalOrg "${i}" || addr="${ORG_PEER_HOSTS[$i]}:${ORG_PEER_PORTS[$i]}"
    PEERFLAGS+=(--peerAddresses "${addr}"
                --tlsRootCertFiles "${NETWORK_ROOT}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/peers/${ORG_PEER_HOSTS[$i]}/tls/ca.crt")
}

requireLocalOrg() {
    [ "${FIRST_LOCAL}" -ge 0 ] || { errorln "No organisation runs on this host (config/host.json)."; exit 1; }
}

loadConfig() { . scripts/config-reader.sh; }

compose() {
    docker compose -p "${DOCKER_NETWORK}" --env-file "${COMPOSE_ENV}" -f docker/docker-compose.yaml "$@"
}

# ── runtime (Docker by default) ───────────────────────────────
# Rehearsals can set TG_RUNTIME_SHIM to a file that redefines these three functions
# to run the same binaries as native processes. Production never sets it.
runtimeStartCAs() {
    local svcs=() i
    [ "${ORDERER_LOCAL}" = "true" ] && svcs+=("ca.${ORDERER_DOMAIN}")
    for i in $(seq 0 $((ORG_COUNT - 1))); do isLocalOrg "${i}" && svcs+=("ca.${ORG_DOMAINS[$i]}"); done
    compose up -d "${svcs[@]}"
}
runtimeStartNodes() {
    local svcs=() i
    [ "${ORDERER_LOCAL}" = "true" ] && svcs+=("${ORDERER_HOST}")
    for i in $(seq 0 $((ORG_COUNT - 1))); do isLocalOrg "${i}" && svcs+=("${ORG_PEER_HOSTS[$i]}"); done
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
runtimeRestartPeer() {   # restart one peer container and wait until it answers again
    docker restart "$1" >/dev/null
    local i; for i in $(seq 1 20); do peer channel list >/dev/null 2>&1 && return 0; sleep 2; done
    return 1
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
    for i in $(seq 0 $((ORG_COUNT - 1))); do isLocalOrg "${i}" && enrollPeerOrg "${i}"; done
    [ "${ORDERER_LOCAL}" = "true" ] && enrollOrdererOrg
    if [ "${MULTI_HOST}" = "true" ]; then
        hostEntries
        mkdir -p channel-artifacts exports   # the other host's channel block and chaincode package are copied in here
    fi
    infoln "Starting this host's nodes..."
    runtimeStartNodes
    successln "Network is up."
    if [ "${MULTI_HOST}" = "true" ]; then
        infoln "Next: './scripts/network.sh export-org', copy the bundle to the other host and import it there"
        infoln "with './scripts/network.sh import-org <file>'; import the other host's bundle here the same way."
    fi
}

# ── two hosts (TG-031) ────────────────────────────────────────
HOSTS_TAG="# trustguard-two-host"
hostEntries() {   # the other hosts' node names → their addresses in /etc/hosts (tagged lines, replaced each time)
    loadConfig
    [ "${MULTI_HOST}" = "true" ] || { infoln "Single-host network: nothing to add to /etc/hosts."; return 0; }
    local lines=() i
    [ "${ORDERER_LOCAL}" = "true" ] || lines+=("${ORDERER_HOST_ADDR} ${ORDERER_HOST} ${HOSTS_TAG}")
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        isLocalOrg "${i}" || lines+=("${ORG_HOST_ADDRS[$i]} ${ORG_PEER_HOSTS[$i]} ${HOSTS_TAG}")
    done
    if [ ! -w /etc/hosts ]; then
        warnln "Cannot write /etc/hosts; add these lines as root:"; printf '  %s\n' "${lines[@]}"; return 0
    fi
    local tmp; tmp="$(mktemp)"
    grep -v "${HOSTS_TAG}\$" /etc/hosts > "${tmp}" || true
    printf '%s\n' "${lines[@]}" >> "${tmp}"
    cat "${tmp}" > /etc/hosts; rm -f "${tmp}"
    infoln "/etc/hosts: $(printf '%s; ' "${lines[@]%% ${HOSTS_TAG}}")"
}

# Public material only: CA certificate, TLS CA certificate and NodeOU config of each MSP, and the TLS CA
# certificate of each node. Anything that looks like a private key stops the export or import.
_noPrivateKeys() {   # _noPrivateKeys <dir>
    local bad
    bad="$( (find "$1" \( -path '*keystore*' -o -name '*_sk' -o -name '*.key' -o -name 'key.pem' \) -print;
             grep -rl -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$1" 2>/dev/null) | sort -u)"
    [ -z "${bad}" ] || { errorln "Private key material found; nothing was exported or imported:"; echo "${bad}" | sed 's#^#  #' >&2; return 1; }
}

exportOrg() {   # exportOrg [file]
    loadConfig
    local stage; stage="$(mktemp -d)"
    local i d names=()
    _copyPublic() {   # <src org dir> <dst org dir> <node tls dir rel> 
        local src=$1 dst=$2 node=$3
        mkdir -p "${dst}/msp/cacerts" "${dst}/msp/tlscacerts" "${dst}/${node}/tls"
        cp "${src}/msp/cacerts/"*    "${dst}/msp/cacerts/"
        cp "${src}/msp/tlscacerts/"* "${dst}/msp/tlscacerts/"
        cp "${src}/msp/config.yaml"  "${dst}/msp/config.yaml"
        cp "${src}/${node}/tls/ca.crt" "${dst}/${node}/tls/ca.crt"
    }
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        isLocalOrg "${i}" || continue
        d="organizations/peerOrganizations/${ORG_DOMAINS[$i]}"
        [ -f "${d}/msp/config.yaml" ] || { errorln "${ORG_MSPIDS[$i]} has no MSP yet: run './scripts/network.sh up' first."; rm -rf "${stage}"; exit 1; }
        _copyPublic "${d}" "${stage}/${d}" "peers/${ORG_PEER_HOSTS[$i]}"
        names+=("${ORG_MSPIDS[$i]}")
    done
    if [ "${ORDERER_LOCAL}" = "true" ]; then
        d="organizations/ordererOrganizations/${ORDERER_DOMAIN}"
        [ -f "${d}/msp/config.yaml" ] || { errorln "The orderer has no MSP yet: run './scripts/network.sh up' first."; rm -rf "${stage}"; exit 1; }
        _copyPublic "${d}" "${stage}/${d}" "orderers/${ORDERER_HOST}"
        names+=("${ORDERER_MSPID}")
    fi
    _noPrivateKeys "${stage}" || { rm -rf "${stage}"; exit 1; }
    local out="${1:-${NETWORK_ROOT}/exports/public-$(IFS=_; echo "${names[*]}").tgz}"
    mkdir -p "$(dirname "${out}")"
    tar -czf "${out}" -C "${stage}" organizations
    rm -rf "${stage}"
    successln "Public bundle for ${names[*]}: ${out}"
    tar -tzf "${out}" | grep -v '/$' | sed 's#^#  #'
    infoln "sha256 $(sha256sum "${out}" | cut -d' ' -f1). Copy it to the other host and run './scripts/network.sh import-org <file>' there."
}

importOrg() {   # importOrg <file>
    loadConfig
    local f=$1
    [ -n "${f}" ] || { errorln "Usage: ./scripts/network.sh import-org <bundle.tgz>"; exit 1; }
    [ -f "${f}" ] || { errorln "File not found: ${f} (copy the other host's exports/public-*.tgz here first)"; exit 1; }
    local stage; stage="$(mktemp -d)"
    tar -xzf "${f}" -C "${stage}" --no-same-owner
    if find "${stage}" -mindepth 1 -maxdepth 1 ! -name organizations | grep -q .; then
        errorln "Unexpected content in ${f} (only organizations/ is allowed)."; rm -rf "${stage}"; exit 1
    fi
    _noPrivateKeys "${stage}" || { rm -rf "${stage}"; exit 1; }
    local d dom i found imported=()
    for d in "${stage}"/organizations/peerOrganizations/*; do
        [ -d "${d}" ] || continue
        dom="$(basename "${d}")"; found=-1
        for i in $(seq 0 $((ORG_COUNT - 1))); do [ "${ORG_DOMAINS[$i]}" = "${dom}" ] && found=${i}; done
        [ "${found}" -ge 0 ] || { errorln "${dom} is not an organisation of this network."; rm -rf "${stage}"; exit 1; }
        isLocalOrg "${found}" && { errorln "${ORG_MSPIDS[$found]} runs on this host; its bundle must not replace the local MSP."; rm -rf "${stage}"; exit 1; }
        imported+=("${ORG_MSPIDS[$found]}")
    done
    for d in "${stage}"/organizations/ordererOrganizations/*; do
        [ -d "${d}" ] || continue
        [ "$(basename "${d}")" = "${ORDERER_DOMAIN}" ] || { errorln "$(basename "${d}") is not this network's orderer organisation."; rm -rf "${stage}"; exit 1; }
        [ "${ORDERER_LOCAL}" = "true" ] && { errorln "The orderer runs on this host; its bundle must not replace the local MSP."; rm -rf "${stage}"; exit 1; }
        imported+=("${ORDERER_MSPID}")
    done
    [ ${#imported[@]} -gt 0 ] || { errorln "No organisation found in ${f}."; rm -rf "${stage}"; exit 1; }
    local c
    for c in $(cd "${stage}" && find organizations -path '*/msp/cacerts/*' -type f | sort); do
        infoln "  CA $(openssl x509 -in "${stage}/${c}" -noout -subject 2>/dev/null | sed 's/^subject= *//') · SHA-256 $(openssl x509 -in "${stage}/${c}" -noout -fingerprint -sha256 | cut -d= -f2 | cut -c1-23)…"
    done
    mkdir -p organizations
    cp -r "${stage}/organizations/." organizations/
    rm -rf "${stage}"
    successln "Imported the public MSP of ${imported[*]} from ${f} (sha256 $(sha256sum "${f}" | cut -c1-16)…)"
}

# Every organisation that runs elsewhere must have its public MSP here before the channel is built.
requireRemoteMsps() {
    local i d missing=()
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        isLocalOrg "${i}" && continue
        d="organizations/peerOrganizations/${ORG_DOMAINS[$i]}"
        { ls "${d}/msp/cacerts/"* && [ -f "${d}/peers/${ORG_PEER_HOSTS[$i]}/tls/ca.crt" ]; } >/dev/null 2>&1 || missing+=("${ORG_MSPIDS[$i]}")
    done
    if [ "${ORDERER_LOCAL}" != "true" ] && [ ! -f "$(ordererTlsCa)" ]; then missing+=("${ORDERER_MSPID}"); fi
    [ ${#missing[@]} -eq 0 ] || { errorln "Import the public bundle of ${missing[*]} first: ./scripts/network.sh import-org <file>"; exit 1; }
}

createChannel() {
    loadConfig
    mkdir -p channel-artifacts
    [ "${MULTI_HOST}" = "true" ] && requireRemoteMsps

    if [ "${ORDERER_LOCAL}" != "true" ]; then
        # The orderer runs on another host: join this host's peers from the channel block made there.
        local blk="./channel-artifacts/${CHANNEL_NAME}.block"
        [ -f "${blk}" ] || { errorln "Copy ${CHANNEL_NAME}.block from the orderer's host (iinot-network/channel-artifacts/) to ${NETWORK_ROOT}/channel-artifacts/ first."; exit 1; }
        joinLocalPeers
        successln "Channel '${CHANNEL_NAME}': this host's peers joined."
        return
    fi

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

    joinLocalPeers
    if [ "${MULTI_HOST}" = "true" ]; then
        successln "Channel '${CHANNEL_NAME}' created; this host's peers joined."
        infoln "Next: copy channel-artifacts/${CHANNEL_NAME}.block to the other host and run './scripts/network.sh channel' there."
    else
        successln "Channel '${CHANNEL_NAME}' created; ${ORG_COUNT} peers joined."
    fi
}

joinLocalPeers() {
    local i
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        isLocalOrg "${i}" || continue
        setPeerEnv "${i}"
        if peer channel list 2>/dev/null | grep -qx "${CHANNEL_NAME}"; then
            infoln "${ORG_PEER_HOSTS[$i]} has already joined"
            continue
        fi
        infoln "Joining ${ORG_PEER_HOSTS[$i]}..."
        retry 10 3 peer channel join -b "./channel-artifacts/${CHANNEL_NAME}.block"
    done
}

packageId() {   # package ID of CC_LABEL on the current peer, empty if not installed
    peer lifecycle chaincode queryinstalled --output json 2>/dev/null \
        | jq -r --arg l "${CC_LABEL}" '.installed_chaincodes[]? | select(.label == $l) | .package_id' | head -1
}

deployChaincode() {
    loadConfig
    requireLocalOrg
    local PKG="${NETWORK_ROOT}/channel-artifacts/${CC_LABEL}.tar.gz"
    local OFLAGS; read -r -a OFLAGS <<<"$(ordererFlags)"
    local DEF=(--channelID "${CHANNEL_NAME}" --name "${CC_NAME}" --version "${CC_VERSION}" --sequence "${CC_SEQUENCE}" --signature-policy "${CC_POLICY}")

    if [ -f "${PKG}" ]; then
        # Reused, so the package ID stays the same (every package build differs) — also the copy from the orderer's host.
        infoln "Using the existing package ${PKG}"
    elif [ "${ORDERER_LOCAL}" != "true" ]; then
        errorln "Copy ${CC_LABEL}.tar.gz from the orderer's host (iinot-network/channel-artifacts/) to ${NETWORK_ROOT}/channel-artifacts/ first:"
        errorln "every host must install the same package."
        exit 1
    else
        infoln "Packaging ${CC_LABEL} from ${CC_PATH}"
        [ -f "${CC_PATH}/package.json" ] || { errorln "No chaincode at ${CC_PATH}"; exit 1; }
        peer lifecycle chaincode package "${PKG}" --path "${CC_PATH}" --lang "${CC_LANG}" --label "${CC_LABEL}"
    fi

    local i PKG_ID=""
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        isLocalOrg "${i}" || continue
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
        launchChaincode
        return
    fi

    for i in $(seq 0 $((ORG_COUNT - 1))); do
        isLocalOrg "${i}" || continue
        setPeerEnv "${i}"
        if [ "$(approvedBy "${ORG_MSPIDS[$i]}")" = "true" ]; then
            infoln "${ORG_MSPIDS[$i]} has already approved this definition"
            continue
        fi
        infoln "Approving for ${ORG_MSPIDS[$i]} (policy ${CC_POLICY})..."
        retry 3 5 peer lifecycle chaincode approveformyorg "${OFLAGS[@]}" "${DEF[@]}" --package-id "${PKG_ID}"
    done

    setPeerEnv "${FIRST_LOCAL}"
    infoln "Commit readiness:"
    local ready; ready="$(peer lifecycle chaincode checkcommitreadiness "${DEF[@]}" --output json)"
    jq -c '.approvals' <<<"${ready}"

    if [ "${MULTI_HOST}" = "true" ]; then
        local waiting; waiting="$(jq -r '.approvals | to_entries[] | select(.value != true) | .key' <<<"${ready}" | tr '\n' ' ')"
        if [ "${ORDERER_LOCAL}" != "true" ]; then
            successln "Approved for this host's organisations. Now run './scripts/network.sh deploy' on the orderer's host to commit;"
            successln "afterwards run it here once more to start the chaincode on this host's peers."
            return 0
        fi
        if [ -n "${waiting// /}" ]; then
            warnln "Waiting for approval by: ${waiting}"
            warnln "Copy channel-artifacts/${CC_LABEL}.tar.gz to the other host, run './scripts/network.sh deploy' there, then run it here again."
            return 3
        fi
    fi

    local PEERFLAGS=()
    for i in $(seq 0 $((ORG_COUNT - 1))); do peerFlagsFor "${i}"; done
    infoln "Committing ${CC_NAME} ${CC_VERSION} (sequence ${CC_SEQUENCE})..."
    retry 3 5 peer lifecycle chaincode commit "${OFLAGS[@]}" "${DEF[@]}" "${PEERFLAGS[@]}"

    verifyCommitted
    launchChaincode
    successln "Chaincode ${CC_NAME} ${CC_VERSION} committed on '${CHANNEL_NAME}' with ${CC_POLICY}."
}

approvedBy() {   # true/false: has <mspid> approved the current definition (asked from the current peer)
    peer lifecycle chaincode checkcommitreadiness --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" \
        --version "${CC_VERSION}" --sequence "${CC_SEQUENCE}" --signature-policy "${CC_POLICY}" --output json 2>/dev/null \
        | jq -r --arg m "$1" '.approvals[$m] // false'
}

committedSequence() {   # success if CC_SEQUENCE (or later) is already committed
    setPeerEnv "${FIRST_LOCAL}"
    local s
    s="$(peer lifecycle chaincode querycommitted --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" --output json 2>/dev/null | jq -r '.sequence // 0')"
    [ -n "${s}" ] && [ "${s}" -ge "${CC_SEQUENCE}" ]
}

# Start the chaincode on every peer now, so a peer that cannot run it fails the deploy
# instead of the first real transaction. Uses the contract's built-in metadata query
# (no role needed). Seen on Docker's containerd image store: a peer reported the image
# built at install but it was missing at launch; restarting the peer rebuilds it.
launchChaincode() {
    local i out attempt
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        isLocalOrg "${i}" || continue
        setPeerEnv "${i}"
        for attempt in 1 2 3; do
            if out=$(peer chaincode query -C "${CHANNEL_NAME}" -n "${CC_NAME}" \
                     -c '{"Args":["org.hyperledger.fabric:GetMetadata"]}' 2>&1); then
                infoln "Chaincode running on ${ORG_PEER_HOSTS[$i]}"
                break
            fi
            local why; why=$(echo "${out}" | grep -oE 'No such image' | head -1)
            [ -n "${why}" ] || why=$(echo "${out}" | grep -oE 'could not launch chaincode|error[^:]*' | head -1)
            warnln "Chaincode did not start on ${ORG_PEER_HOSTS[$i]} (attempt ${attempt}): ${why}"
            if [ "${attempt}" -eq 3 ]; then
                errorln "Chaincode cannot run on ${ORG_PEER_HOSTS[$i]}. Peer log: docker logs ${ORG_PEER_HOSTS[$i]} 2>&1 | tail -50"
                return 1
            fi
            infoln "Restarting ${ORG_PEER_HOSTS[$i]} so it rebuilds the chaincode image…"
            runtimeRestartPeer "${ORG_PEER_HOSTS[$i]}" || true
        done
    done
}

verifyCommitted() {
    setPeerEnv "${FIRST_LOCAL}"
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

# Store the Rules Designer rules on the channel (chaincode 1.4 SetRules, TG-028). Signed by the first
# endorsing organisation's admin and endorsed like any write, so a rule change needs every endorser.
# Rules come from config/network-config.json "rules" (defaults if none are saved yet).
applyRules() {
    loadConfig
    local payload
    payload="$("${NODE_BIN}" "${TG_HOME}/safety-dashboard/backend/scripts/rulesJson.js" "${CONFIG_FILE}")" || { errorln "Rules are not valid; nothing was changed."; return 1; }
    local OFLAGS; read -r -a OFLAGS <<<"$(ordererFlags)"
    local i first=-1 PEERFLAGS=()
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        [ "${ORG_ENDORSES[$i]}" = "true" ] || continue
        isLocalOrg "${i}" && [ "${first}" -lt 0 ] && first=${i}
        peerFlagsFor "${i}"
    done
    [ "${first}" -ge 0 ] || { errorln "No endorsing organisation runs on this host: set the rules from a host that runs one."; return 1; }
    setPeerEnv "${first}"
    local args; args="$(jq -nc --arg r "${payload}" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{function:"SetRules",Args:[$r,$t]}')"
    infoln "Setting the network rules on '${CHANNEL_NAME}' as the ${ORG_MSPIDS[$first]} admin (endorsed by every endorsing org)..."
    local out
    if ! out=$(peer chaincode invoke "${OFLAGS[@]}" -C "${CHANNEL_NAME}" -n "${CC_NAME}" "${PEERFLAGS[@]}" -c "${args}" --waitForEvent 2>&1); then
        if grep -q "SetRules" <<<"${out}" && grep -qiE "not found|does not exist" <<<"${out}"; then
            errorln "The chaincode on this channel has no SetRules: it is older than safetycc 1.4. Redeploy with 1.4."
        else
            errorln "SetRules failed: $(grep -oE 'message:[^]]*|Error: .*' <<<"${out}" | tail -1)"
        fi
        return 1
    fi
    local now
    now="$(peer chaincode query -C "${CHANNEL_NAME}" -n "${CC_NAME}" -c '{"Args":["GetRules"]}')" || return 1
    jq -c '.rules | {version, eventTypes: [.eventTypes[] | "\(.name)=\(.riskScore)"], restricted: .access,
           escalationMinutes: ((.escalation // {levels: []}).levels | map(.afterMinutes)), targets,
           reports: ((.reportTypes // []) | map("\(.code) \(.deadlineHours)h")), admins: .adminMsps}' <<<"${now}"
    successln "Network rules v$(jq -r .rules.version <<<"${now}") are in force on '${CHANNEL_NAME}'."
}

# After a (re)deploy the app services still hold connections and certificates of the previous network:
# restart the ones that are running so they connect to the new one at once. The dashboard backend is
# left alone: it runs this deploy, and it drops connections made before the redeploy by itself.
restartAppServices() {
    command -v systemctl >/dev/null 2>&1 || return 0
    local s restarted=()
    for s in trustguard-gateway trustguard-oracle trustguard-escalation; do
        if systemctl is-active --quiet "$s" 2>/dev/null; then
            systemctl restart "$s" && restarted+=("$s") || warnln "could not restart $s"
        fi
    done
    [ ${#restarted[@]} -eq 0 ] || infoln "Restarted for the new network: ${restarted[*]}"
}

enrollIdentities() {
    loadConfig
    . scripts/registerEnroll.sh
    mkdir -p "${WALLET_DIR}"; chmod 700 "${WALLET_DIR}"
    local i entry n=0
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        isLocalOrg "${i}" || continue   # another host's users are enrolled there, with its own CA
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
        if ! isLocalOrg "${i}"; then echo "${ORG_PEER_HOSTS[$i]}: on ${ORG_HOST_ADDRS[$i]}"; continue; fi
        setPeerEnv "${i}"
        echo "${ORG_PEER_HOSTS[$i]}: $(peer channel list 2>/dev/null | tail -n +2 | tr '\n' ' ')$(peer channel getinfo -c "${CHANNEL_NAME}" 2>/dev/null | sed -n 's/.*"height":\([0-9]*\).*/· height \1/p')"
    done
    verifyCommitted || true
}

networkDown() {
    if [ ! -f config/network.derived.json ]; then
        # Leftovers from older scripts (crypto folders but no derived config): remove the folders.
        local old=()
        local d; for d in organizations/peerOrganizations organizations/ordererOrganizations organizations/fabric-ca channel-artifacts; do
            [ -e "$d" ] && old+=("$d")
        done
        if [ ${#old[@]} -eq 0 ]; then warnln "Nothing to tear down."; return 0; fi
        warnln "No derived config, but files from an earlier deployment remain: ${old[*]}"
        if [ -t 0 ] && [ "${1}" != "-y" ]; then
            read -r -p "Delete them? [y/N] " a
            [ "${a}" = "y" ] || [ "${a}" = "Y" ] || { infoln "Cancelled."; exit 0; }
        fi
        rm -rf "${old[@]}"
        successln "Removed: ${old[*]}"
        local vols; vols=$(docker volume ls -q 2>/dev/null | grep -E '(^|_)(peer0|orderer)\.' || true)
        [ -n "${vols}" ] && warnln "Docker volumes from an earlier deployment may remain (remove with docker volume rm):"$'\n'"${vols}"
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
    rules)      applyRules ;;
    status)     networkStatus ;;
    down)       networkDown "$2" ;;
    export-org) exportOrg "$2" ;;
    import-org) importOrg "$2" ;;
    hosts)      hostEntries ;;
    all)
        requireFresh
        if [ -f config/host.json ]; then
            errorln "config/host.json is present: this is a two-host network. Run the steps one by one (docs/TWO_HOST.md)."
            exit 1
        fi
        generate
        networkUp
        createChannel
        deployChaincode
        applyRules
        enrollIdentities
        restartAppServices
        successln "Deployment complete. Network is ready."
        ;;
    *)
        echo "Usage: ./scripts/network.sh [generate|up|channel|deploy|rules|identities|all|status|down [-y]|export-org [file]|import-org <file>|hosts]"
        exit 1
        ;;
esac

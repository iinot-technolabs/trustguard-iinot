#!/bin/bash
# config-reader.sh — Phase 4 config shim
# Sources network-config.json and exports all shell variables
# used by network.sh and registerEnroll.sh.
#
# Requires: jq
# Usage (from network.sh): . scripts/config-reader.sh
#
# Exported variables:
#   CHANNEL_NAME          — channel name
#   CC_NAME               — chaincode name
#   CC_PATH               — chaincode path (absolute)
#   CC_LANG               — chaincode language (default: node)
#   NETWORK_NAME          — human name for logging
#   ORDERER_DOMAIN        — e.g. iinot-safety.com
#   ORDERER_MSPID         — e.g. IINoTOrdererMSP
#   ORDERER_CA_PORT       — e.g. 9054
#   ORDERER_PORT          — e.g. 7050
#   ORDERER_ADMIN_PORT    — e.g. 7053
#   ORG_COUNT             — number of peer orgs
#   ORG_NAMES[]           — array of org short names (slugs), e.g. ("industry" "regulator")
#   ORG_DOMAINS[]         — array of org domains,      e.g. ("iinot-industry.com" "iinot-regulator.com")
#   ORG_MSPIDS[]          — array of MSP IDs,          e.g. ("IINoTIndustryMSP" "IINoTRegulatorMSP")
#   ORG_CA_NAMES[]        — array of CA names,         e.g. ("ca-iinot-industry" "ca-iinot-regulator")
#   ORG_CA_PORTS[]        — array of CA ports,         e.g. (7054 8054)
#   ORG_PEER_PORTS[]      — array of peer ports,       e.g. (7051 9051)
#   ORG_CHAINCODE_PORTS[] — array of chaincode ports,  e.g. (7052 9052)
#   ORG_OPS_PORTS[]       — array of operations ports, e.g. (17051 19051)
#   ORG_USERS[][]         — per-org user list (stored as ORG_USERS_<slug>)

CONFIG_FILE="${PWD}/config/network-config.json"

if [ ! -f "${CONFIG_FILE}" ]; then
    echo "[ERROR] network-config.json not found at ${CONFIG_FILE}"
    echo "[ERROR] Run Network Designer in the dashboard first, then click Deploy."
    exit 1
fi

if ! command -v jq &>/dev/null; then
    echo "[ERROR] jq is required but not installed. Run: apt-get install -y jq"
    exit 1
fi

# ── Top-level fields ──────────────────────────────────────────
export NETWORK_NAME=$(jq -r '.network.name // "IINoT Network"' "${CONFIG_FILE}")
export CHANNEL_NAME=$(jq -r '.network.channel // "iinot-safety-channel"' "${CONFIG_FILE}")
export CC_NAME=$(jq -r '.chaincode.name // "safetycc"' "${CONFIG_FILE}")
export CC_LANG=$(jq -r '.chaincode.lang // "node"' "${CONFIG_FILE}")

# Chaincode path: absolute if starts with /, else relative to $HOME/fabric/
_CC_PATH_RAW=$(jq -r '.chaincode.path // "safety-chaincode"' "${CONFIG_FILE}")
if [[ "${_CC_PATH_RAW}" == /* ]]; then
    export CC_PATH="${_CC_PATH_RAW}"
else
    export CC_PATH="${HOME}/trustguard-iinot/${_CC_PATH_RAW}"
fi

# ── Orderer org ───────────────────────────────────────────────
export ORDERER_DOMAIN=$(jq -r '.orderer.domain // "iinot-safety.com"' "${CONFIG_FILE}")
export ORDERER_MSPID=$(jq -r '.orderer.mspId // "IINoTOrdererMSP"' "${CONFIG_FILE}")
export ORDERER_CA_PORT=$(jq -r '.orderer.caPort // 9054' "${CONFIG_FILE}")
export ORDERER_PORT=$(jq -r '.orderer.port // 7050' "${CONFIG_FILE}")
export ORDERER_ADMIN_PORT=$(jq -r '.orderer.adminPort // 7053' "${CONFIG_FILE}")
export ORDERER_CA_NAME=$(jq -r '.orderer.caName // "ca-iinot-orderer"' "${CONFIG_FILE}")
export ORDERER_CA_SLUG=$(jq -r '.orderer.caSlug // "iinot-orderer"' "${CONFIG_FILE}")

# ── Peer orgs — build parallel arrays ─────────────────────────
export ORG_COUNT=$(jq '.organizations | length' "${CONFIG_FILE}")

# Bash arrays (bash 4+, available on all Linux targets)
ORG_NAMES=()
ORG_DOMAINS=()
ORG_MSPIDS=()
ORG_CA_NAMES=()
ORG_CA_SLUGS=()
ORG_CA_PORTS=()
ORG_PEER_PORTS=()
ORG_CHAINCODE_PORTS=()
ORG_OPS_PORTS=()

for i in $(seq 0 $((ORG_COUNT - 1))); do
    ORG_NAMES+=("$(jq -r ".organizations[$i].name" "${CONFIG_FILE}")")
    ORG_DOMAINS+=("$(jq -r ".organizations[$i].domain" "${CONFIG_FILE}")")
    ORG_MSPIDS+=("$(jq -r ".organizations[$i].id" "${CONFIG_FILE}")")
    ORG_CA_NAMES+=("$(jq -r ".organizations[$i].caName" "${CONFIG_FILE}")")
    ORG_CA_SLUGS+=("$(jq -r ".organizations[$i].caFolderName" "${CONFIG_FILE}")")
    ORG_CA_PORTS+=("$(jq -r ".organizations[$i].caPort" "${CONFIG_FILE}")")
    ORG_PEER_PORTS+=("$(jq -r ".organizations[$i].peerPort" "${CONFIG_FILE}")")
    ORG_CHAINCODE_PORTS+=("$(jq -r ".organizations[$i].chaincodePort" "${CONFIG_FILE}")")
    ORG_OPS_PORTS+=("$(jq -r ".organizations[$i].operationsPort" "${CONFIG_FILE}")")

    # Store per-org users as a colon-separated env var so it survives export
    # Format: "username:role username2:role2"
    _USERS=$(jq -r ".organizations[$i].roles[]? | \"\(.name):\(.attrs)\"" "${CONFIG_FILE}" | tr '\n' ' ')
    export "ORG_USERS_${ORG_MSPIDS[$i]}"="${_USERS}"
done

export ORG_NAMES ORG_DOMAINS ORG_MSPIDS ORG_CA_NAMES ORG_CA_SLUGS
export ORG_CA_PORTS ORG_PEER_PORTS ORG_CHAINCODE_PORTS ORG_OPS_PORTS

echo "[INFO] Config loaded: ${NETWORK_NAME} | channel=${CHANNEL_NAME} | orgs=${ORG_COUNT} | cc=${CC_NAME}"

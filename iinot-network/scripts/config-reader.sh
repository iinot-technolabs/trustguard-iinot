#!/bin/bash
# config-reader.sh — loads the derived network model into shell variables.
#
# Source from iinot-network/ (network.sh does this):   . scripts/config-reader.sh
#
# Reads config/network.derived.json, which generateConfigs.js writes from the
# Network Designer's config/network-config.json. No names, ports or paths are
# hard-coded here: every value below comes from that file.
#
# Scalars:  NETWORK_NAME CHANNEL_NAME GENESIS_PROFILE DOCKER_NETWORK BIND_ADDRESS
#           CC_NAME CC_VERSION CC_SEQUENCE CC_LABEL CC_PATH CC_LANG CC_POLICY
#           ORDERER_MSPID ORDERER_DOMAIN ORDERER_HOST ORDERER_PORT ORDERER_ADMIN_PORT
#           ORDERER_CA_NAME ORDERER_CA_SLUG ORDERER_CA_PORT
#           WALLET_DIR SECRETS_FILE COMPOSE_ENV ORG_COUNT
# Arrays (index = org):  ORG_LABELS ORG_TYPES ORG_MSPIDS ORG_DOMAINS ORG_PEER_HOSTS
#           ORG_PEER_PORTS ORG_CHAINCODE_PORTS ORG_OPS_PORTS ORG_CA_NAMES ORG_CA_SLUGS
#           ORG_CA_PORTS ORG_ENDORSES ORG_USERS ("name:role name:role")

DERIVED_FILE="${PWD}/config/network.derived.json"

if ! command -v jq &>/dev/null; then
    echo "[ERROR] jq is required: apt-get install -y jq" >&2
    return 1 2>/dev/null || exit 1
fi
if [ ! -f "${DERIVED_FILE}" ]; then
    echo "[ERROR] ${DERIVED_FILE} not found." >&2
    echo "[ERROR] Save the network in the Network Designer, or run: ./scripts/network.sh generate" >&2
    return 1 2>/dev/null || exit 1
fi

_j() { jq -r "$1" "${DERIVED_FILE}"; }

NETWORK_NAME="$(_j .network.name)"
CHANNEL_NAME="$(_j .network.channel)"
GENESIS_PROFILE="$(_j .network.genesisProfile)"
DOCKER_NETWORK="$(_j .network.dockerNetwork)"
BIND_ADDRESS="$(_j .network.bindAddress)"

CC_NAME="$(_j .chaincode.name)"
CC_VERSION="$(_j .chaincode.version)"
CC_SEQUENCE="$(_j .chaincode.sequence)"
CC_LABEL="$(_j .chaincode.label)"
CC_PATH="$(_j .chaincode.path)"
CC_LANG="$(_j .chaincode.lang)"
CC_POLICY="$(_j .chaincode.policy)"

ORDERER_MSPID="$(_j .orderer.mspId)"
ORDERER_DOMAIN="$(_j .orderer.domain)"
ORDERER_HOST="$(_j .orderer.host)"
ORDERER_PORT="$(_j .orderer.port)"
ORDERER_ADMIN_PORT="$(_j .orderer.adminPort)"
ORDERER_CA_NAME="$(_j .orderer.caName)"
ORDERER_CA_SLUG="$(_j .orderer.caSlug)"
ORDERER_CA_PORT="$(_j .orderer.caPort)"

WALLET_DIR="$(_j .paths.wallet)"
SECRETS_FILE="${PWD}/config/secrets/secrets.json"
COMPOSE_ENV="${PWD}/config/secrets/compose.env"

ORG_COUNT="$(_j '.orgs | length')"
ORG_LABELS=(); ORG_TYPES=(); ORG_MSPIDS=(); ORG_DOMAINS=(); ORG_PEER_HOSTS=()
ORG_PEER_PORTS=(); ORG_CHAINCODE_PORTS=(); ORG_OPS_PORTS=()
ORG_CA_NAMES=(); ORG_CA_SLUGS=(); ORG_CA_PORTS=(); ORG_ENDORSES=(); ORG_USERS=()

while IFS=$'\t' read -r label type msp domain host pport ccport ops caname caslug caport endorses users; do
    ORG_LABELS+=("${label}");   ORG_TYPES+=("${type}");      ORG_MSPIDS+=("${msp}")
    ORG_DOMAINS+=("${domain}"); ORG_PEER_HOSTS+=("${host}")
    ORG_PEER_PORTS+=("${pport}"); ORG_CHAINCODE_PORTS+=("${ccport}"); ORG_OPS_PORTS+=("${ops}")
    ORG_CA_NAMES+=("${caname}"); ORG_CA_SLUGS+=("${caslug}"); ORG_CA_PORTS+=("${caport}")
    ORG_ENDORSES+=("${endorses}"); ORG_USERS+=("${users}")
done < <(jq -r '.orgs[] | [.label, .type, .mspId, .domain, .peerHost, .peerPort, .chaincodePort,
                           .opsPort, .caName, .caSlug, .caPort, (.endorses|tostring),
                           ([.users[] | "\(.name):\(.role)"] | join(" "))] | @tsv' "${DERIVED_FILE}")

# Read one secret by jq path, e.g.  secret '.ca["iinot-industry"]'
secret() {
    local v
    v="$(jq -r "$1 // empty" "${SECRETS_FILE}" 2>/dev/null)"
    if [ -z "${v}" ]; then
        echo "[ERROR] missing secret $1 in ${SECRETS_FILE}; run ./scripts/network.sh generate" >&2
        return 1
    fi
    printf '%s' "${v}"
}

echo "[INFO] Config loaded: ${NETWORK_NAME} | channel=${CHANNEL_NAME} | orgs=${ORG_COUNT} (${ORG_MSPIDS[*]}) | ${CC_LABEL} seq ${CC_SEQUENCE} | policy ${CC_POLICY}"

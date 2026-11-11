#!/bin/bash
# two-host-evidence.sh — evidence for the two-host proof (TG-031). Read-only unless --sos or --refused.
#
#   ./scripts/two-host-evidence.sh             on each host: what runs here, private keys by organisation,
#                                              CA certificate fingerprints, block height and latest block hash
#   ./scripts/two-host-evidence.sh --sos       also log one test SOS and show which organisations endorsed it
#   ./scripts/two-host-evidence.sh --refused   with the other host's peer stopped: a test SOS must be refused
#
# --sos and --refused need the gateway identity, so run them on the employer's host.
# Prints no keys or secrets: only counts, file locations, certificate subjects and fingerprints.
set -eo pipefail
cd "$(dirname "$0")/.."
NETWORK_ROOT="${PWD}"
TG_HOME="${TG_HOME:-$(cd .. && pwd)}"
FABRIC_BIN="${FABRIC_BIN:-${TG_HOME}/bin}"
export PATH="${FABRIC_BIN}:${PATH}"
export FABRIC_CFG_PATH="${NETWORK_ROOT}"
. scripts/utils.sh
. scripts/config-reader.sh >/dev/null

echo "== TrustGuard two-host evidence · $(hostname) · $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
echo "Network ${NETWORK_NAME} · channel ${CHANNEL_NAME} · policy ${CC_POLICY}"
here=(); [ "${ORDERER_LOCAL}" = "true" ] && here+=("orderer (${ORDERER_MSPID})")
for i in $(seq 0 $((ORG_COUNT - 1))); do isLocalOrg "${i}" && here+=("${ORG_MSPIDS[$i]}"); done
echo "This host runs: ${here[*]}"
for i in $(seq 0 $((ORG_COUNT - 1))); do isLocalOrg "${i}" || echo "Runs elsewhere: ${ORG_MSPIDS[$i]} on ${ORG_HOST_ADDRS[$i]}"; done
[ "${ORDERER_LOCAL}" = "true" ] || echo "Runs elsewhere: orderer on ${ORDERER_HOST_ADDR}"

echo
echo "-- Private keys on this host, by organisation (package folder and wallet) --"
keyfiles="$(grep -rl -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' organizations "${WALLET_DIR}" 2>/dev/null | grep -v '/fabric-ca/' || true)"
for i in $(seq 0 $((ORG_COUNT - 1))); do
    n=$(grep -c "/peerOrganizations/${ORG_DOMAINS[$i]}/" <<<"${keyfiles}" || true)
    w=0
    for entry in ${ORG_USERS[$i]}; do [ -f "${WALLET_DIR}/${entry%%:*}/key.pem" ] && w=$((w + 1)); done
    printf '  %-28s %3d key files in organizations/, %d wallet identities\n' "${ORG_MSPIDS[$i]}" "${n}" "${w}"
done
n=$(grep -c "/ordererOrganizations/" <<<"${keyfiles}" || true)
printf '  %-28s %3d key files in organizations/\n' "${ORDERER_MSPID}" "${n}"
cas=$(find organizations/fabric-ca -name 'IssuerSecretKey' -o -path '*/msp/keystore/*' 2>/dev/null | sed -E 's#organizations/fabric-ca/([^/]*)/.*#\1#' | sort -u | tr '\n' ' ')
echo "  CA servers holding their own signing keys here: ${cas:-none}"
for i in $(seq 0 $((ORG_COUNT - 1))); do
    isLocalOrg "${i}" && continue
    hits="$(find / -xdev \( -path /proc -o -path /sys \) -prune -o -path "*${ORG_DOMAINS[$i]}*" \( -name '*_sk' -o -name 'key.pem' -o -name 'server.key' -o -path '*keystore*' \) -type f -print 2>/dev/null | head -5)"
    if [ -z "${hits}" ]; then echo "  Whole-disk search for ${ORG_MSPIDS[$i]} key files: none found"
    else echo "  Whole-disk search for ${ORG_MSPIDS[$i]} key files: FOUND"; echo "${hits}" | sed 's#^#    #'; fi
done

echo
echo "-- CA certificates (identical on every host) --"
for i in $(seq 0 $((ORG_COUNT - 1))); do
    c="$(ls organizations/peerOrganizations/${ORG_DOMAINS[$i]}/msp/cacerts/* 2>/dev/null | head -1)"
    [ -n "${c}" ] && printf '  %-28s SHA-256 %s\n' "${ORG_MSPIDS[$i]}" "$(openssl x509 -in "${c}" -noout -fingerprint -sha256 | cut -d= -f2)"
done

echo
echo "-- Ledger on this host's peers --"
for i in $(seq 0 $((ORG_COUNT - 1))); do
    isLocalOrg "${i}" || continue
    export CORE_PEER_TLS_ENABLED=true CORE_PEER_LOCALMSPID="${ORG_MSPIDS[$i]}"
    export CORE_PEER_TLS_ROOTCERT_FILE="${NETWORK_ROOT}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/peers/${ORG_PEER_HOSTS[$i]}/tls/ca.crt"
    export CORE_PEER_MSPCONFIGPATH="${NETWORK_ROOT}/organizations/peerOrganizations/${ORG_DOMAINS[$i]}/users/Admin@${ORG_DOMAINS[$i]}/msp"
    export CORE_PEER_ADDRESS="localhost:${ORG_PEER_PORTS[$i]}"
    info="$(peer channel getinfo -c "${CHANNEL_NAME}" 2>/dev/null | sed -n 's/^Blockchain info: //p')"
    if [ -z "${info}" ]; then echo "  ${ORG_PEER_HOSTS[$i]}: not answering"; continue; fi
    echo "  ${ORG_PEER_HOSTS[$i]}: height $(jq -r .height <<<"${info}") · latest block hash $(jq -r .currentBlockHash <<<"${info}")"
done

case "$1" in
    --sos|--refused)
        echo
        echo "-- Transaction test (${1#--}) --"
        cd "${TG_HOME}/safety-simulation"
        TG_HOME="${TG_HOME}" node twoHostEvidence.js "${1#--}"
        ;;
    "") ;;
    *) echo "Unknown option $1 (use --sos or --refused)"; exit 1 ;;
esac

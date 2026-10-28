#!/bin/bash
# registerEnroll.sh — Fabric CA registration and enrolment, driven entirely by
# config/network.derived.json (via config-reader.sh) and config/secrets/secrets.json.
#
# Sourced by network.sh. Functions:
#   enrollPeerOrg <index>    CA admin, peer0 (MSP + TLS), org Admin, and register app users
#   enrollOrdererOrg         orderer CA admin, orderer node (MSP + TLS), orderer Admin
#   enrollAppUser <index> <name> <role>   enrol one app user into the wallet
#
# Every secret comes from secrets.json (random, generated once). None is echoed:
# commands that carry a secret run without `set -x`.

_caClient() {
    # fabric-ca-client with FABRIC_CA_CLIENT_HOME already exported by the caller
    fabric-ca-client "$@" >/dev/null 2>"${FABRIC_CA_CLIENT_HOME}/.last-ca-error" || {
        local rc=$?
        errorln "fabric-ca-client $1 failed (exit ${rc}):"
        sed -e 's#://[^:@/]*:[^@]*@#://***:***@#g' "${FABRIC_CA_CLIENT_HOME}/.last-ca-error" | tail -5 >&2
        return ${rc}
    }
}

# Write the NodeOU config.yaml for an MSP whose CA cert file is named $2
_writeNodeOUs() {
    local MSPDIR=$1 CERTFILE=$2
    cat > "${MSPDIR}/config.yaml" <<EOF
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/${CERTFILE}
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/${CERTFILE}
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/${CERTFILE}
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/${CERTFILE}
    OrganizationalUnitIdentifier: orderer
EOF
}

# Wait until a CA answers on its TLS port (fresh CAs need a few seconds)
_waitForCA() {
    local PORT=$1 CERT=$2 i
    for i in $(seq 1 30); do
        [ -f "${CERT}" ] && curl -s --cacert "${CERT}" "https://localhost:${PORT}/cainfo" >/dev/null 2>&1 && return 0
        sleep 1
    done
    errorln "CA on port ${PORT} did not become ready (cert ${CERT})"
    return 1
}

_register() {   # <caname> <tlscert> <name> <secret> <type> [attrs]
    local CANAME=$1 TLS=$2 NAME=$3 SECRET=$4 TYPE=$5 ATTRS=$6
    if fabric-ca-client identity list --id "${NAME}" --caname "${CANAME}" --tls.certfiles "${TLS}" >/dev/null 2>&1; then
        infoln "  ${NAME} already registered"
        return 0
    fi
    local args=(register --caname "${CANAME}" --id.name "${NAME}" --id.secret "${SECRET}" --id.type "${TYPE}" --tls.certfiles "${TLS}")
    [ -n "${ATTRS}" ] && args+=(--id.attrs "${ATTRS}")
    _caClient "${args[@]}"
}

function enrollPeerOrg() {
    local IDX=$1
    local MSPID="${ORG_MSPIDS[$IDX]}" DOMAIN="${ORG_DOMAINS[$IDX]}" HOST="${ORG_PEER_HOSTS[$IDX]}"
    local CA_NAME="${ORG_CA_NAMES[$IDX]}" CA_SLUG="${ORG_CA_SLUGS[$IDX]}" CA_PORT="${ORG_CA_PORTS[$IDX]}"
    local ORGDIR="${PWD}/organizations/peerOrganizations/${DOMAIN}"
    local TLS="${PWD}/organizations/fabric-ca/${CA_SLUG}/ca-cert.pem"
    local CA_PW PEER_PW ADMIN_PW
    CA_PW="$(secret ".ca[\"${CA_SLUG}\"]")"      || return 1
    PEER_PW="$(secret ".peer[\"${MSPID}\"]")"    || return 1
    ADMIN_PW="$(secret ".orgAdmin[\"${MSPID}\"]")" || return 1

    infoln "Org ${ORG_LABELS[$IDX]} (${MSPID}, ${DOMAIN}) — CA ${CA_NAME} on ${CA_PORT}"
    mkdir -p "${ORGDIR}"
    export FABRIC_CA_CLIENT_HOME="${ORGDIR}"
    _waitForCA "${CA_PORT}" "${TLS}" || return 1

    _caClient enroll -u "https://admin:${CA_PW}@localhost:${CA_PORT}" --caname "${CA_NAME}" --tls.certfiles "${TLS}" || return 1
    _writeNodeOUs "${ORGDIR}/msp" "$(basename "$(ls "${ORGDIR}/msp/cacerts/"*.pem | head -1)")"

    infoln "  registering peer0, org admin and app users"
    _register "${CA_NAME}" "${TLS}" peer0 "${PEER_PW}" peer || return 1
    _register "${CA_NAME}" "${TLS}" orgadmin "${ADMIN_PW}" admin || return 1
    local entry name role
    for entry in ${ORG_USERS[$IDX]}; do
        name="${entry%%:*}"; role="${entry#*:}"
        _register "${CA_NAME}" "${TLS}" "${name}" "$(secret ".users[\"${name}\"]")" client "role=${role}:ecert" || return 1
        infoln "  ${name} (role=${role})"
    done

    infoln "  enrolling peer0 MSP and TLS"
    local PEERDIR="${ORGDIR}/peers/${HOST}"
    _caClient enroll -u "https://peer0:${PEER_PW}@localhost:${CA_PORT}" --caname "${CA_NAME}" \
        -M "${PEERDIR}/msp" --csr.hosts "${HOST}" --tls.certfiles "${TLS}" || return 1
    cp "${ORGDIR}/msp/config.yaml" "${PEERDIR}/msp/config.yaml"
    _caClient enroll -u "https://peer0:${PEER_PW}@localhost:${CA_PORT}" --caname "${CA_NAME}" \
        -M "${PEERDIR}/tls" --enrollment.profile tls --csr.hosts "${HOST}" --csr.hosts localhost \
        --tls.certfiles "${TLS}" || return 1

    cp "${PEERDIR}/tls/tlscacerts/"* "${PEERDIR}/tls/ca.crt"
    cp "${PEERDIR}/tls/signcerts/"*  "${PEERDIR}/tls/server.crt"
    cp "${PEERDIR}/tls/keystore/"*   "${PEERDIR}/tls/server.key"
    mkdir -p "${ORGDIR}/msp/tlscacerts" "${ORGDIR}/tlsca" "${ORGDIR}/ca"
    cp "${PEERDIR}/tls/tlscacerts/"* "${ORGDIR}/msp/tlscacerts/ca.crt"
    cp "${PEERDIR}/tls/tlscacerts/"* "${ORGDIR}/tlsca/tlsca.${DOMAIN}-cert.pem"
    cp "${PEERDIR}/msp/cacerts/"*    "${ORGDIR}/ca/ca.${DOMAIN}-cert.pem"

    infoln "  enrolling org Admin"
    _caClient enroll -u "https://orgadmin:${ADMIN_PW}@localhost:${CA_PORT}" --caname "${CA_NAME}" \
        -M "${ORGDIR}/users/Admin@${DOMAIN}/msp" --tls.certfiles "${TLS}" || return 1
    cp "${ORGDIR}/msp/config.yaml" "${ORGDIR}/users/Admin@${DOMAIN}/msp/config.yaml"

    successln "Org ${MSPID} identities enrolled."
}

function enrollOrdererOrg() {
    local ORGDIR="${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}"
    local TLS="${PWD}/organizations/fabric-ca/${ORDERER_CA_SLUG}/ca-cert.pem"
    local CA_PW NODE_PW ADMIN_PW
    CA_PW="$(secret ".ca[\"${ORDERER_CA_SLUG}\"]")" || return 1
    NODE_PW="$(secret '.orderer.node')"            || return 1
    ADMIN_PW="$(secret '.orderer.admin')"          || return 1

    infoln "Orderer org ${ORDERER_MSPID} (${ORDERER_DOMAIN}) — CA ${ORDERER_CA_NAME} on ${ORDERER_CA_PORT}"
    mkdir -p "${ORGDIR}"
    export FABRIC_CA_CLIENT_HOME="${ORGDIR}"
    _waitForCA "${ORDERER_CA_PORT}" "${TLS}" || return 1

    _caClient enroll -u "https://admin:${CA_PW}@localhost:${ORDERER_CA_PORT}" --caname "${ORDERER_CA_NAME}" --tls.certfiles "${TLS}" || return 1
    _writeNodeOUs "${ORGDIR}/msp" "$(basename "$(ls "${ORGDIR}/msp/cacerts/"*.pem | head -1)")"

    _register "${ORDERER_CA_NAME}" "${TLS}" orderer "${NODE_PW}" orderer || return 1
    _register "${ORDERER_CA_NAME}" "${TLS}" ordereradmin "${ADMIN_PW}" admin || return 1

    local NODEDIR="${ORGDIR}/orderers/${ORDERER_HOST}"
    _caClient enroll -u "https://orderer:${NODE_PW}@localhost:${ORDERER_CA_PORT}" --caname "${ORDERER_CA_NAME}" \
        -M "${NODEDIR}/msp" --csr.hosts "${ORDERER_HOST}" --tls.certfiles "${TLS}" || return 1
    cp "${ORGDIR}/msp/config.yaml" "${NODEDIR}/msp/config.yaml"
    _caClient enroll -u "https://orderer:${NODE_PW}@localhost:${ORDERER_CA_PORT}" --caname "${ORDERER_CA_NAME}" \
        -M "${NODEDIR}/tls" --enrollment.profile tls --csr.hosts "${ORDERER_HOST}" --csr.hosts localhost \
        --tls.certfiles "${TLS}" || return 1
    cp "${NODEDIR}/tls/tlscacerts/"* "${NODEDIR}/tls/ca.crt"
    cp "${NODEDIR}/tls/signcerts/"*  "${NODEDIR}/tls/server.crt"
    cp "${NODEDIR}/tls/keystore/"*   "${NODEDIR}/tls/server.key"
    mkdir -p "${ORGDIR}/msp/tlscacerts"
    cp "${NODEDIR}/tls/tlscacerts/"* "${ORGDIR}/msp/tlscacerts/tlsca.${ORDERER_DOMAIN}-cert.pem"

    _caClient enroll -u "https://ordereradmin:${ADMIN_PW}@localhost:${ORDERER_CA_PORT}" --caname "${ORDERER_CA_NAME}" \
        -M "${ORGDIR}/users/Admin@${ORDERER_DOMAIN}/msp" --tls.certfiles "${TLS}" || return 1
    cp "${ORGDIR}/msp/config.yaml" "${ORGDIR}/users/Admin@${ORDERER_DOMAIN}/msp/config.yaml"

    successln "Orderer org ${ORDERER_MSPID} identities enrolled."
}

# Enrol one registered app user into WALLET_DIR/<name>/ (cert.pem, key.pem, identity.json).
function enrollAppUser() {
    local IDX=$1 NAME=$2 ROLE=$3
    local MSPID="${ORG_MSPIDS[$IDX]}" DOMAIN="${ORG_DOMAINS[$IDX]}"
    local CA_NAME="${ORG_CA_NAMES[$IDX]}" CA_SLUG="${ORG_CA_SLUGS[$IDX]}" CA_PORT="${ORG_CA_PORTS[$IDX]}"
    local TLS="${PWD}/organizations/fabric-ca/${CA_SLUG}/ca-cert.pem"
    local USERDIR="${PWD}/organizations/peerOrganizations/${DOMAIN}/users/${NAME}@${DOMAIN}"
    local PW
    PW="$(secret ".users[\"${NAME}\"]")" || return 1

    export FABRIC_CA_CLIENT_HOME="${PWD}/organizations/peerOrganizations/${DOMAIN}"
    rm -rf "${USERDIR}/msp"
    _caClient enroll -u "https://${NAME}:${PW}@localhost:${CA_PORT}" --caname "${CA_NAME}" \
        -M "${USERDIR}/msp" --enrollment.attrs "role" --tls.certfiles "${TLS}" || return 1
    cp "${PWD}/organizations/peerOrganizations/${DOMAIN}/msp/config.yaml" "${USERDIR}/msp/config.yaml"

    local W="${WALLET_DIR}/${NAME}"
    mkdir -p "${W}"
    chmod 700 "${WALLET_DIR}" "${W}"
    cp "${USERDIR}/msp/signcerts/"* "${W}/cert.pem"
    install -m 600 "${USERDIR}/msp/keystore/"* "${W}/key.pem"
    printf '{"name":"%s","mspId":"%s","role":"%s","org":"%s"}\n' "${NAME}" "${MSPID}" "${ROLE}" "${DOMAIN}" > "${W}/identity.json"
    infoln "  wallet: ${NAME} (${MSPID}, role=${ROLE})"
}

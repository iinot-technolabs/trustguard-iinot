#!/bin/bash
#
# registerEnroll.sh — TrustGuard IIoT Identity Generation
# Driven entirely by config/network-config.json via config-reader.sh
#
# Provides two functions called by network.sh:
#   enrollPeerOrg <index>   — enroll one peer org by its index in ORG_* arrays
#   enrollOrdererOrg        — enroll the orderer org

set -e

. scripts/utils.sh
# config-reader.sh is already sourced by network.sh — arrays are in scope

# ─────────────────────────────────────────────────────────────
# Generic peer org enroll — called once per org
# Usage: enrollPeerOrg <org_index>
# ─────────────────────────────────────────────────────────────
function enrollPeerOrg() {
    local IDX=$1
    local ORG_NAME="${ORG_NAMES[$IDX]}"
    local ORG_DOMAIN="${ORG_DOMAINS[$IDX]}"
    local ORG_MSPID="${ORG_MSPIDS[$IDX]}"
    local CA_NAME="${ORG_CA_NAMES[$IDX]}"
    local CA_SLUG="${ORG_CA_SLUGS[$IDX]}"
    local CA_PORT="${ORG_CA_PORTS[$IDX]}"
    local PEER_PORT="${ORG_PEER_PORTS[$IDX]}"

    infoln "Enrolling the CA admin for org: ${ORG_NAME} (${ORG_DOMAIN})"
    mkdir -p organizations/peerOrganizations/${ORG_DOMAIN}

    export FABRIC_CA_CLIENT_HOME=${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}

    # CA cert filename is based on port and CA name
    local CA_CERT_FILENAME="localhost-${CA_PORT}-${CA_NAME}.pem"

    set -x
    fabric-ca-client enroll \
        -u https://admin:adminpw@localhost:${CA_PORT} \
        --caname ${CA_NAME} \
        --tls.certfiles "${PWD}/organizations/fabric-ca/${CA_SLUG}/ca-cert.pem"
    { set +x; } 2>/dev/null

    # Write config.yaml mapping OUs to roles
    cat > "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/msp/config.yaml" <<EOF
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/${CA_CERT_FILENAME}
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/${CA_CERT_FILENAME}
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/${CA_CERT_FILENAME}
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/${CA_CERT_FILENAME}
    OrganizationalUnitIdentifier: orderer
EOF

    # Register peer
    infoln "Registering peer0.${ORG_DOMAIN}"
    set -x
    fabric-ca-client register \
        --caname ${CA_NAME} \
        --id.name peer0 \
        --id.secret peer0pw \
        --id.type peer \
        --tls.certfiles "${PWD}/organizations/fabric-ca/${CA_SLUG}/ca-cert.pem"
    { set +x; } 2>/dev/null

    # Register org admin
    local ADMIN_NAME="${ORG_NAME}Admin"
    local ADMIN_PW="${ORG_NAME}Adminpw"
    infoln "Registering org admin: ${ADMIN_NAME}"
    set -x
    fabric-ca-client register \
        --caname ${CA_NAME} \
        --id.name ${ADMIN_NAME} \
        --id.secret ${ADMIN_PW} \
        --id.type admin \
        --tls.certfiles "${PWD}/organizations/fabric-ca/${CA_SLUG}/ca-cert.pem"
    { set +x; } 2>/dev/null

    # Register application-level users defined in config
    # ORG_USERS_<name> is a space-separated list of "username:role" pairs
    local USERS_VAR="ORG_USERS_${ORG_NAME}"
    local USERS_STR="${!USERS_VAR}"
    if [ -n "${USERS_STR}" ]; then
        for USER_ENTRY in ${USERS_STR}; do
            local USER_NAME="${USER_ENTRY%%:*}"
            local USER_ROLE="${USER_ENTRY##*:}"
            infoln "Registering ${USER_NAME} (role=${USER_ROLE})"
            set -x
            fabric-ca-client register \
                --caname ${CA_NAME} \
                --id.name ${USER_NAME} \
                --id.secret ${USER_NAME}pw \
                --id.type client \
                --id.attrs "role=${USER_ROLE}:ecert" \
                --tls.certfiles "${PWD}/organizations/fabric-ca/${CA_SLUG}/ca-cert.pem"
            { set +x; } 2>/dev/null
        done
    fi

    # Enroll peer MSP
    infoln "Enrolling peer0.${ORG_DOMAIN} MSP"
    set -x
    fabric-ca-client enroll \
        -u https://peer0:peer0pw@localhost:${CA_PORT} \
        --caname ${CA_NAME} \
        -M "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/peers/peer0.${ORG_DOMAIN}/msp" \
        --csr.hosts peer0.${ORG_DOMAIN} \
        --tls.certfiles "${PWD}/organizations/fabric-ca/${CA_SLUG}/ca-cert.pem"
    { set +x; } 2>/dev/null

    cp "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/msp/config.yaml" \
       "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/peers/peer0.${ORG_DOMAIN}/msp/config.yaml"

    # Enroll peer TLS
    infoln "Enrolling peer0.${ORG_DOMAIN} TLS"
    set -x
    fabric-ca-client enroll \
        -u https://peer0:peer0pw@localhost:${CA_PORT} \
        --caname ${CA_NAME} \
        -M "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/peers/peer0.${ORG_DOMAIN}/tls" \
        --enrollment.profile tls \
        --csr.hosts peer0.${ORG_DOMAIN} \
        --csr.hosts localhost \
        --tls.certfiles "${PWD}/organizations/fabric-ca/${CA_SLUG}/ca-cert.pem"
    { set +x; } 2>/dev/null

    # Copy TLS certs to standard locations
    local PEER_TLS="${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/peers/peer0.${ORG_DOMAIN}/tls"
    cp "${PEER_TLS}/tlscacerts/"*   "${PEER_TLS}/ca.crt"
    cp "${PEER_TLS}/signcerts/"*    "${PEER_TLS}/server.crt"
    cp "${PEER_TLS}/keystore/"*     "${PEER_TLS}/server.key"

    mkdir -p "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/msp/tlscacerts"
    cp "${PEER_TLS}/tlscacerts/"* \
       "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/msp/tlscacerts/ca.crt"

    mkdir -p "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/tlsca"
    cp "${PEER_TLS}/tlscacerts/"* \
       "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/tlsca/tlsca.${ORG_DOMAIN}-cert.pem"

    mkdir -p "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/ca"
    cp "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/peers/peer0.${ORG_DOMAIN}/msp/cacerts/"* \
       "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/ca/ca.${ORG_DOMAIN}-cert.pem"

    # Enroll org admin
    infoln "Enrolling org admin for ${ORG_NAME}"
    set -x
    fabric-ca-client enroll \
        -u https://${ADMIN_NAME}:${ADMIN_PW}@localhost:${CA_PORT} \
        --caname ${CA_NAME} \
        -M "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/users/Admin@${ORG_DOMAIN}/msp" \
        --tls.certfiles "${PWD}/organizations/fabric-ca/${CA_SLUG}/ca-cert.pem"
    { set +x; } 2>/dev/null

    cp "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/msp/config.yaml" \
       "${PWD}/organizations/peerOrganizations/${ORG_DOMAIN}/users/Admin@${ORG_DOMAIN}/msp/config.yaml"

    successln "Org ${ORG_NAME} (${ORG_DOMAIN}) identities enrolled."
}

# ─────────────────────────────────────────────────────────────
# Orderer org enroll
# ─────────────────────────────────────────────────────────────
function enrollOrdererOrg() {
    infoln "Enrolling the CA admin for Orderer org (${ORDERER_DOMAIN})"
    mkdir -p organizations/ordererOrganizations/${ORDERER_DOMAIN}

    export FABRIC_CA_CLIENT_HOME=${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}

    local CA_CERT_FILENAME="localhost-${ORDERER_CA_PORT}-${ORDERER_CA_NAME}.pem"

    set -x
    fabric-ca-client enroll \
        -u https://admin:adminpw@localhost:${ORDERER_CA_PORT} \
        --caname ${ORDERER_CA_NAME} \
        --tls.certfiles "${PWD}/organizations/fabric-ca/${ORDERER_CA_SLUG}/ca-cert.pem"
    { set +x; } 2>/dev/null

    cat > "${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/msp/config.yaml" <<EOF
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/${CA_CERT_FILENAME}
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/${CA_CERT_FILENAME}
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/${CA_CERT_FILENAME}
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/${CA_CERT_FILENAME}
    OrganizationalUnitIdentifier: orderer
EOF

    infoln "Registering orderer identity"
    set -x
    fabric-ca-client register \
        --caname ${ORDERER_CA_NAME} \
        --id.name orderer \
        --id.secret ordererpw \
        --id.type orderer \
        --tls.certfiles "${PWD}/organizations/fabric-ca/${ORDERER_CA_SLUG}/ca-cert.pem"
    { set +x; } 2>/dev/null

    infoln "Registering orderer admin"
    set -x
    fabric-ca-client register \
        --caname ${ORDERER_CA_NAME} \
        --id.name ordererAdmin \
        --id.secret ordererAdminpw \
        --id.type admin \
        --tls.certfiles "${PWD}/organizations/fabric-ca/${ORDERER_CA_SLUG}/ca-cert.pem"
    { set +x; } 2>/dev/null

    infoln "Enrolling orderer MSP"
    set -x
    fabric-ca-client enroll \
        -u https://orderer:ordererpw@localhost:${ORDERER_CA_PORT} \
        --caname ${ORDERER_CA_NAME} \
        -M "${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/orderer.${ORDERER_DOMAIN}/msp" \
        --csr.hosts orderer.${ORDERER_DOMAIN} \
        --tls.certfiles "${PWD}/organizations/fabric-ca/${ORDERER_CA_SLUG}/ca-cert.pem"
    { set +x; } 2>/dev/null

    cp "${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/msp/config.yaml" \
       "${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/orderer.${ORDERER_DOMAIN}/msp/config.yaml"

    infoln "Enrolling orderer TLS"
    set -x
    fabric-ca-client enroll \
        -u https://orderer:ordererpw@localhost:${ORDERER_CA_PORT} \
        --caname ${ORDERER_CA_NAME} \
        -M "${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/orderer.${ORDERER_DOMAIN}/tls" \
        --enrollment.profile tls \
        --csr.hosts orderer.${ORDERER_DOMAIN} \
        --csr.hosts localhost \
        --tls.certfiles "${PWD}/organizations/fabric-ca/${ORDERER_CA_SLUG}/ca-cert.pem"
    { set +x; } 2>/dev/null

    local ORDERER_TLS="${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/orderer.${ORDERER_DOMAIN}/tls"
    cp "${ORDERER_TLS}/tlscacerts/"* "${ORDERER_TLS}/ca.crt"
    cp "${ORDERER_TLS}/signcerts/"*  "${ORDERER_TLS}/server.crt"
    cp "${ORDERER_TLS}/keystore/"*   "${ORDERER_TLS}/server.key"

    mkdir -p "${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/msp/tlscacerts"
    cp "${ORDERER_TLS}/tlscacerts/"* \
       "${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/msp/tlscacerts/tlsca.${ORDERER_DOMAIN}-cert.pem"

    infoln "Enrolling orderer admin MSP"
    set -x
    fabric-ca-client enroll \
        -u https://ordererAdmin:ordererAdminpw@localhost:${ORDERER_CA_PORT} \
        --caname ${ORDERER_CA_NAME} \
        -M "${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/users/Admin@${ORDERER_DOMAIN}/msp" \
        --tls.certfiles "${PWD}/organizations/fabric-ca/${ORDERER_CA_SLUG}/ca-cert.pem"
    { set +x; } 2>/dev/null

    cp "${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/msp/config.yaml" \
       "${PWD}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/users/Admin@${ORDERER_DOMAIN}/msp/config.yaml"

    successln "Orderer org (${ORDERER_DOMAIN}) identities enrolled."
}

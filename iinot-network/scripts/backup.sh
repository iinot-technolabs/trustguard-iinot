#!/bin/bash
# backup.sh — consistent backup of a TrustGuard installation (DI-04).
#
#   bash iinot-network/scripts/backup.sh            # writes backups/tg-backup-<channel>-<date>.tar.gz (+ .sha256)
#   TG_BACKUP_DIR=/mnt/backup bash …/backup.sh       # somewhere else (copy it off the server afterwards)
#
# What is saved:
#   ledgers         Docker volumes of the orderer and every peer (blocks, state, installed chaincode)
#   crypto + CAs    iinot-network/organizations/ (MSPs, TLS, CA databases and keys)
#   network config  iinot-network/config/ (designer config, derived model, app.env, secrets/), configtx.yaml,
#                   docker/docker-compose.yaml, channel-artifacts/
#   apps            wallet/, .env, config/client/, dashboard users.json and data/ (Form 18 particulars),
#                   safety-simulation/offchain.db (raw payloads, oracle readings, escalation state)
#
# The services and Fabric containers are stopped for the copy (about a minute) so the ledgers and the
# SQLite files are consistent, then started again — also if the backup fails.
# The archive holds private keys and secrets: it is written 0600; keep it encrypted and off this server.
set -eo pipefail
cd "$(dirname "$0")/.."                      # iinot-network/
NETWORK_ROOT="${PWD}"
TG_HOME="${TG_HOME:-$(cd .. && pwd)}"
. scripts/utils.sh
[ "$(id -u)" = 0 ] || { errorln "Run as root."; exit 1; }
. scripts/config-reader.sh

OUT_DIR="${TG_BACKUP_DIR:-${TG_HOME}/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="tg-backup-${CHANNEL_NAME}-${STAMP}"
STAGE="$(mktemp -d)"; chmod 700 "${STAGE}"
mkdir -p "${OUT_DIR}"; chmod 700 "${OUT_DIR}"

compose() { docker compose -p "${DOCKER_NETWORK}" --env-file "${COMPOSE_ENV}" -f docker/docker-compose.yaml "$@"; }
SERVICES=(trustguard-gateway trustguard-oracle trustguard-escalation trustguard-backend)
WAS_ACTIVE=()
restart_all() {
    infoln "Starting the Fabric containers and services again…"
    compose start >/dev/null 2>&1 || compose up -d >/dev/null 2>&1 || warnln "compose start failed: check with  ./scripts/network.sh status"
    local s; for s in "${WAS_ACTIVE[@]}"; do systemctl start "$s" || warnln "could not start $s"; done
    rm -rf "${STAGE}"
}

for s in "${SERVICES[@]}"; do systemctl is-active --quiet "$s" 2>/dev/null && WAS_ACTIVE+=("$s"); done
infoln "Network '${NETWORK_NAME}' (channel ${CHANNEL_NAME}). Stopping services: ${WAS_ACTIVE[*]:-none}"
for s in "${WAS_ACTIVE[@]}"; do systemctl stop "$s"; done
trap restart_all EXIT
compose stop >/dev/null

# Ledger volumes of this compose project
mkdir -p "${STAGE}/volumes"
VOLS=$(docker volume ls -q --filter "label=com.docker.compose.project=${DOCKER_NETWORK}")
[ -n "${VOLS}" ] || { errorln "No Docker volumes for project ${DOCKER_NETWORK}: is the network deployed?"; exit 1; }
echo "[" > "${STAGE}/volumes.json"; first=1
for v in ${VOLS}; do
    mp="$(docker volume inspect -f '{{.Mountpoint}}' "$v")"
    tar -C "${mp}" -cf "${STAGE}/volumes/${v}.tar" .
    [ $first = 1 ] || echo "," >> "${STAGE}/volumes.json"; first=0
    docker volume inspect -f '{"name":{{json .Name}},"labels":{{json .Labels}}}' "$v" >> "${STAGE}/volumes.json"
    infoln "  volume ${v}: $(du -sh "${STAGE}/volumes/${v}.tar" | cut -f1)"
done
echo "]" >> "${STAGE}/volumes.json"

# Files (paths relative to TG_HOME; missing ones are skipped)
FILES=()
for f in iinot-network/organizations iinot-network/config iinot-network/channel-artifacts iinot-network/configtx.yaml \
         iinot-network/docker/docker-compose.yaml wallet .env config/client safety-dashboard/backend/users.json \
         safety-dashboard/backend/data safety-simulation/escalation/.env \
         safety-simulation/offchain.db safety-simulation/offchain.db-wal safety-simulation/offchain.db-shm; do
    [ -e "${TG_HOME}/${f}" ] && FILES+=("$f")
done
tar -C "${TG_HOME}" -cpf "${STAGE}/files.tar" "${FILES[@]}"

cat > "${STAGE}/meta.json" <<EOF
{ "created": "$(date -u +%FT%TZ)", "host": "$(hostname)", "tgHome": "${TG_HOME}",
  "commit": "$(git -C "${TG_HOME}" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "network": $(jq -c '{name: .network.name, channel: .network.channel, dockerNetwork: .network.dockerNetwork, chaincode: .chaincode.label}' config/network.derived.json),
  "files": $(printf '%s\n' "${FILES[@]}" | jq -R . | jq -sc .) }
EOF

ARCHIVE="${OUT_DIR}/${NAME}.tar.gz"
( umask 077; tar -C "${STAGE}" -czf "${ARCHIVE}" meta.json volumes.json volumes files.tar )
chmod 600 "${ARCHIVE}"
( cd "${OUT_DIR}" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256" )
successln "Backup written: ${ARCHIVE} ($(du -h "${ARCHIVE}" | cut -f1)); checksum in ${NAME}.tar.gz.sha256"
infoln "It contains private keys and secrets: copy it off this server to encrypted storage."

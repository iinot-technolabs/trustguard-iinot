#!/bin/bash
# restore.sh — restore a backup made by backup.sh onto this server (DI-04).
#
#   bash iinot-network/scripts/restore.sh backups/tg-backup-<channel>-<date>.tar.gz
#
# Use it after a failure, or to move an installation to a new server: install the package there first
# (git clone + install.sh, same TG_HOME path, no network deployed), then copy the archive and run this.
#
# It replaces this server's network state with the backup: ledgers, crypto, CA databases, network
# config and secrets, wallet, dashboard users and data, off-chain database. The current network (if
# any) is stopped first; its ledger volumes are replaced. It asks before doing that.
set -eo pipefail
ARCHIVE="$(readlink -f "${1:?usage: restore.sh <backup.tar.gz> [-y]}")"
YES="${2:-}"
cd "$(dirname "$0")/.."                      # iinot-network/
NETWORK_ROOT="${PWD}"
TG_HOME="${TG_HOME:-$(cd .. && pwd)}"
. scripts/utils.sh
[ "$(id -u)" = 0 ] || { errorln "Run as root."; exit 1; }
[ -f "${ARCHIVE}" ] || { errorln "No such file: ${ARCHIVE}"; exit 1; }

if [ -f "${ARCHIVE}.sha256" ]; then
    ( cd "$(dirname "${ARCHIVE}")" && sha256sum -c --quiet "$(basename "${ARCHIVE}").sha256" ) \
        || { errorln "Checksum does not match: the archive is damaged or was changed."; exit 1; }
    infoln "Checksum OK"
else
    warnln "No .sha256 file next to the archive; integrity not checked."
fi

STAGE="$(mktemp -d)"; chmod 700 "${STAGE}"; trap 'rm -rf "${STAGE}"' EXIT
tar -C "${STAGE}" -xzf "${ARCHIVE}"
for f in meta.json volumes.json files.tar; do [ -e "${STAGE}/$f" ] || { errorln "Not a TrustGuard backup (missing $f)."; exit 1; }; done
P="$(jq -r .network.dockerNetwork "${STAGE}/meta.json")"
infoln "Backup of '$(jq -r .network.name "${STAGE}/meta.json")' (channel $(jq -r .network.channel "${STAGE}/meta.json"), $(jq -r .network.chaincode "${STAGE}/meta.json")), made $(jq -r .created "${STAGE}/meta.json") on $(jq -r .host "${STAGE}/meta.json"), package $(jq -r .commit "${STAGE}/meta.json")"
[ "$(jq -r .tgHome "${STAGE}/meta.json")" = "${TG_HOME}" ] || warnln "Backup was taken with TG_HOME=$(jq -r .tgHome "${STAGE}/meta.json"); this install is ${TG_HOME}. Paths in the network config must match."

if [ "${YES}" != "-y" ]; then
    [ -t 0 ] || { errorln "Not interactive: add -y to confirm."; exit 1; }
    read -r -p "Replace this server's network state with this backup? [y/N] " a
    [ "${a}" = "y" ] || [ "${a}" = "Y" ] || { infoln "Cancelled."; exit 0; }
fi

SERVICES=(trustguard-gateway trustguard-oracle trustguard-escalation trustguard-backend)
WAS_ACTIVE=()
for s in "${SERVICES[@]}"; do systemctl is-active --quiet "$s" 2>/dev/null && WAS_ACTIVE+=("$s"); done
for s in "${WAS_ACTIVE[@]}"; do systemctl stop "$s"; done

# Stop whatever runs now (current compose file, if any), keeping nothing of its ledgers
if [ -f config/network.derived.json ] && [ -f docker/docker-compose.yaml ]; then
    . scripts/config-reader.sh
    docker compose -p "${DOCKER_NETWORK}" --env-file "${COMPOSE_ENV}" -f docker/docker-compose.yaml down >/dev/null 2>&1 || true
fi
ids=$(docker ps -aq --filter "label=com.docker.compose.project=${P}"); [ -z "${ids}" ] || docker rm -f ${ids} >/dev/null

# Files: move the current ones aside (kept until the restore succeeds), then unpack
ASIDE="${TG_HOME}/.restore-aside-$(date +%Y%m%d-%H%M%S)"; mkdir -p "${ASIDE}"; chmod 700 "${ASIDE}"
for f in $(jq -r '.files[]' "${STAGE}/meta.json"); do
    if [ -e "${TG_HOME}/${f}" ]; then mkdir -p "${ASIDE}/$(dirname "$f")"; mv "${TG_HOME}/${f}" "${ASIDE}/${f}"; fi
done
tar -C "${TG_HOME}" -xpf "${STAGE}/files.tar"
infoln "Files restored (previous copies in ${ASIDE})"

# Ledger volumes: recreate with the compose labels, then fill
while IFS= read -r row; do
    v="$(jq -r .name <<<"${row}")"
    docker volume rm -f "${v}" >/dev/null 2>&1 || true
    labels=(); while IFS= read -r l; do labels+=(--label "$l"); done < <(jq -r '.labels // {} | to_entries[] | "\(.key)=\(.value)"' <<<"${row}")
    docker volume create "${labels[@]}" "${v}" >/dev/null
    mp="$(docker volume inspect -f '{{.Mountpoint}}' "${v}")"
    tar -C "${mp}" -xpf "${STAGE}/volumes/${v}.tar"
    infoln "  volume ${v} restored"
done < <(jq -c '.[]' "${STAGE}/volumes.json")

# Start the restored network and services
. scripts/config-reader.sh
docker compose -p "${DOCKER_NETWORK}" --env-file "${COMPOSE_ENV}" -f docker/docker-compose.yaml up -d >/dev/null
infoln "Fabric containers started; waiting for the peers…"
sleep 10
for s in "${WAS_ACTIVE[@]}"; do systemctl start "$s" || warnln "could not start $s"; done
systemctl is-active --quiet trustguard-backend || systemctl start trustguard-backend 2>/dev/null || true

successln "Restore complete. Check:  ./scripts/network.sh status   and   node ../safety-simulation/simulateEvent.js"
infoln "When both pass, delete the previous copies:  rm -rf ${ASIDE}"

#!/usr/bin/env bash
# =============================================================================
# TrustGuard IIoT — installer (fresh Ubuntu 22.04/24.04 server, run as root)
#
#   git clone https://github.com/iinot-technolabs/trustguard-iinot.git /root/trustguard-iinot
#   cd /root/trustguard-iinot && bash install.sh                 # install / update
#   bash install.sh --firewall                                   # also apply the UFW firewall (22, 80)
#   bash install.sh --firewall --public-ports "22 80 3003"       # … with your own public ports
#   bash install.sh --enable-services                            # after Deploy: start gateway, oracle, escalation
#
# What it does (safe to re-run):
#   1. Prerequisites: Docker + Compose v2, Node.js 20+, jq, build tools, nginx
#   2. Fabric binaries (same versions as the images) into ./bin
#   3. .env with TG_HOME, FABRIC_BIN and a random AUTH_SECRET (kept on re-runs)
#   4. npm ci: backend, simulation; builds the dashboard
#   5. systemd: trustguard-backend (127.0.0.1:3001); gateway/oracle/escalation units installed
#      but only enabled with --enable-services (they need a deployed network)
#   6. nginx on port 80: dashboard + /api proxy (same origin, SSE-safe)
#   7. Per-client settings in config/client/ (copied from the shipped examples, never overwritten)
#   8. First admin login for the dashboard (asks for a password if there is no admin yet)
#
# It never touches another TrustGuard install, /root/fabric, or a running Fabric network.
# =============================================================================
set -euo pipefail

TG_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${TG_HOME}/install.log"
ENV_FILE="${TG_HOME}/.env"
FABRIC_VERSION="2.5.15"
CA_VERSION="1.5.17"
BACKEND_PORT=3001
FIREWALL=0; ENABLE_SERVICES=0; PUBLIC_PORTS="22 80"

while [ $# -gt 0 ]; do
  case "$1" in
    --firewall)        FIREWALL=1 ;;
    --public-ports)    PUBLIC_PORTS="$2"; shift ;;
    --enable-services) ENABLE_SERVICES=1 ;;
    -h|--help)         sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown option $1 (see --help)"; exit 2 ;;
  esac
  shift
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()  { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
section() { echo -e "\n${BOLD}━━━ $* ━━━${NC}"; }

[[ $EUID -eq 0 ]] || die "Run as root: sudo bash install.sh"
case "${TG_HOME}" in /root/fabric|/root/fabric/*) die "Refusing to install inside /root/fabric." ;; esac
exec > >(tee -a "${LOG_FILE}") 2>&1
chmod 600 "${LOG_FILE}"

# ── --enable-services only ───────────────────────────────────────────────────
if [ "${ENABLE_SERVICES}" = 1 ]; then
  section "Enable gateway, oracle and escalation"
  [ -f "${TG_HOME}/iinot-network/config/network.derived.json" ] || die "No deployed network yet: deploy from the dashboard first."
  [ -d "${TG_HOME}/wallet" ] || die "No wallet yet: run Enroll identities on the Admin page."
  grep -q '^CHIRPSTACK_APP_ID=.\+' "${TG_HOME}/config/client/gateway.env" 2>/dev/null || \
    warn "config/client/gateway.env has no CHIRPSTACK_APP_ID: the gateway will exit until you set it."
  for s in trustguard-gateway trustguard-oracle trustguard-escalation; do
    systemctl enable --now "$s" && ok "$s enabled"
  done
  systemctl --no-pager --lines=0 status trustguard-gateway trustguard-oracle trustguard-escalation | grep -E "●|Active:" || true
  exit 0
fi

section "TrustGuard IIoT installer — ${TG_HOME}"

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
section "1. Prerequisites"
export DEBIAN_FRONTEND=noninteractive
need_apt=()
command -v jq    >/dev/null || need_apt+=(jq)
command -v curl  >/dev/null || need_apt+=(curl)
command -v nginx >/dev/null || need_apt+=(nginx)
dpkg -s build-essential >/dev/null 2>&1 || need_apt+=(build-essential)
if [ ${#need_apt[@]} -gt 0 ]; then apt-get update -qq && apt-get install -y -qq "${need_apt[@]}"; fi
if ! command -v docker >/dev/null; then
  info "Installing Docker…"; curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null
docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin || die "Docker Compose v2 is required."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "${NODE_MAJOR}" -lt 20 ]; then
  info "Installing Node.js 20…"; curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y -qq nodejs
fi
NODE_BIN="$(command -v node)"
ok "Docker $(docker version --format '{{.Server.Version}}'), Compose $(docker compose version --short), Node $(node -v), jq, nginx"

# ── 2. Fabric binaries ───────────────────────────────────────────────────────
section "2. Fabric ${FABRIC_VERSION} / CA ${CA_VERSION} binaries"
FABRIC_BIN="${TG_HOME}/bin"
have_ver=$("${FABRIC_BIN}/peer" version 2>/dev/null | awk '/Version:/{print $2; exit}' || true)
if [ "${have_ver}" = "v${FABRIC_VERSION}" ] && [ -x "${FABRIC_BIN}/fabric-ca-client" ]; then
  ok "Fabric binaries already present (${have_ver})"
else
  tmp=$(mktemp -d)
  curl -fsSL -o "${tmp}/f.tgz"  "https://github.com/hyperledger/fabric/releases/download/v${FABRIC_VERSION}/hyperledger-fabric-linux-amd64-${FABRIC_VERSION}.tar.gz"
  curl -fsSL -o "${tmp}/ca.tgz" "https://github.com/hyperledger/fabric-ca/releases/download/v${CA_VERSION}/hyperledger-fabric-ca-linux-amd64-${CA_VERSION}.tar.gz"
  tar -xzf "${tmp}/f.tgz" -C "${tmp}" bin && tar -xzf "${tmp}/ca.tgz" -C "${tmp}" bin
  rm -rf "${FABRIC_BIN}"; mv "${tmp}/bin" "${FABRIC_BIN}"; rm -rf "${tmp}"
  ok "Installed into ./bin ($("${FABRIC_BIN}/peer" version | awk '/Version:/{print $2; exit}'))"
fi
info "Pre-pulling Fabric images (first deploy is faster)…"
for img in fabric-peer:${FABRIC_VERSION} fabric-orderer:${FABRIC_VERSION} fabric-ca:${CA_VERSION} fabric-nodeenv:2.5 fabric-ccenv:2.5; do
  docker pull -q "hyperledger/${img}" >/dev/null && echo "        hyperledger/${img}" || warn "could not pull hyperledger/${img} (Deploy will retry)"
done

# ── 3. .env ──────────────────────────────────────────────────────────────────
section "3. Server settings (.env)"
touch "${ENV_FILE}"; chmod 600 "${ENV_FILE}"
setenv() {  # setenv KEY VALUE  — add or replace one line
  if grep -q "^$1=" "${ENV_FILE}"; then sed -i "s|^$1=.*|$1=$2|" "${ENV_FILE}"; else echo "$1=$2" >> "${ENV_FILE}"; fi
}
grep -q '^# TrustGuard IIoT' "${ENV_FILE}" || sed -i '1i # TrustGuard IIoT server settings (written by install.sh). Network names live in iinot-network/config/.' "${ENV_FILE}"
setenv TG_HOME "${TG_HOME}"
setenv FABRIC_BIN "${FABRIC_BIN}"
setenv NODE_ENV production
setenv PORT "${BACKEND_PORT}"
grep -q '^AUTH_SECRET=.\{32,\}' "${ENV_FILE}" || setenv AUTH_SECRET "$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=')"
# Retired settings from older installs: the admin password is now a dashboard user, names come from the network config.
sed -i -E '/^(ADMIN_PASSWORD|ADMIN_TOKEN_SECRET|CHANNEL_NAME|CHAINCODE_NAME|PEER_ENDPOINT|PEER_HOST_OVERRIDE|IINOT_NETWORK_HOME|WALLET_DIR)=/d' "${ENV_FILE}"
rm -f "${TG_HOME}/safety-dashboard/backend/.env.retired"
if [ -f "${TG_HOME}/safety-dashboard/backend/.env" ] && grep -q '^ADMIN_PASSWORD=' "${TG_HOME}/safety-dashboard/backend/.env"; then
  mv "${TG_HOME}/safety-dashboard/backend/.env" "${TG_HOME}/safety-dashboard/backend/.env.retired"
  chmod 600 "${TG_HOME}/safety-dashboard/backend/.env.retired"
  warn "Moved the old backend/.env (ADMIN_PASSWORD login) to .env.retired; it is no longer used."
fi
ok ".env ready (AUTH_SECRET present, 0600)"

# ── 4. Node packages + dashboard build ──────────────────────────────────────
section "4. Node packages and dashboard build"
(cd "${TG_HOME}/safety-dashboard/backend"  && npm ci --omit=dev --no-audit --no-fund --loglevel=error) && ok "backend"
(cd "${TG_HOME}/safety-simulation"         && npm ci --omit=dev --no-audit --no-fund --loglevel=error) && ok "simulation services"
(cd "${TG_HOME}/safety-dashboard/frontend" && npm ci --no-audit --no-fund --loglevel=error && npx vite build --logLevel warn) && ok "dashboard built"

# ── 5. Per-client settings ───────────────────────────────────────────────────
section "5. Per-client settings (config/client/)"
CC="${TG_HOME}/config/client"; mkdir -p "${CC}"; chmod 750 "${CC}"
copy_once() { [ -f "${CC}/$2" ] || { cp "$1" "${CC}/$2"; info "created config/client/$2 from the example"; }; }
copy_once "${TG_HOME}/safety-simulation/oracle/sites.json"        sites.json
copy_once "${TG_HOME}/safety-simulation/escalation/policy.json"   policy.json
copy_once "${TG_HOME}/safety-simulation/risk/model-v1.json"       model-v1.json
[ -f "${CC}/gateway.env" ] || cat > "${CC}/gateway.env" <<'EOF'
# Gateway settings for this client (systemd EnvironmentFile for trustguard-gateway)
GATEWAY_MODE=chirpstack
CHIRPSTACK_HOST=localhost
CHIRPSTACK_PORT=1883
# ChirpStack → Applications → your application → ID
CHIRPSTACK_APP_ID=
CHIRPSTACK_USERNAME=
CHIRPSTACK_PASSWORD=
EOF
[ -f "${CC}/escalation.env" ] || cp "${TG_HOME}/safety-simulation/escalation/.env.example" "${CC}/escalation.env"
[ -f "${CC}/oracle.env" ] || echo "# ORACLE_INTERVAL_MIN=15" > "${CC}/oracle.env"
chmod 600 "${CC}"/*.env
SERVER_IP="$(hostname -I | awk '{print $1}')"
if grep -q '"dashboardUrl": "http://localhost/"' "${CC}/policy.json"; then
  sed -i "s#\"dashboardUrl\": \"http://localhost/\"#\"dashboardUrl\": \"http://${SERVER_IP}/\"#" "${CC}/policy.json"
fi
ok "config/client/: sites.json, policy.json, model-v1.json, gateway.env, oracle.env, escalation.env (edit for this client)"

# ── 6. systemd ───────────────────────────────────────────────────────────────
section "6. Services"
cat > /etc/systemd/system/trustguard-backend.service <<EOF
[Unit]
Description=TrustGuard IIoT dashboard API
After=network-online.target docker.service
Wants=network-online.target

[Service]
WorkingDirectory=${TG_HOME}/safety-dashboard/backend
EnvironmentFile=${ENV_FILE}
Environment=BIND_HOST=127.0.0.1
ExecStart=${NODE_BIN} server.js
Restart=on-failure
RestartSec=5
SyslogIdentifier=trustguard-backend

[Install]
WantedBy=multi-user.target
EOF
for s in trustguard-gateway trustguard-oracle trustguard-escalation; do
  sed -e "s#@TG_HOME@#${TG_HOME}#g" -e "s#@NODE@#${NODE_BIN}#g" \
      "${TG_HOME}/safety-simulation/deploy/${s}.service.in" > "/etc/systemd/system/${s}.service"
done
systemctl daemon-reload
systemctl enable trustguard-backend >/dev/null 2>&1
systemctl restart trustguard-backend
sleep 2
systemctl is-active --quiet trustguard-backend && ok "trustguard-backend running on 127.0.0.1:${BACKEND_PORT}" \
  || warn "trustguard-backend did not start: journalctl -u trustguard-backend -n 30"
for s in trustguard-gateway trustguard-oracle trustguard-escalation; do
  systemctl is-enabled --quiet "$s" 2>/dev/null && systemctl restart "$s" && info "$s restarted" || info "$s installed (enable after Deploy: bash install.sh --enable-services)"
done

# ── 7. nginx ─────────────────────────────────────────────────────────────────
section "7. nginx (port 80)"
DIST="${TG_HOME}/safety-dashboard/frontend/dist"
cat > /etc/nginx/sites-available/trustguard <<EOF
server {
    listen 80 default_server;
    server_name _;
    root ${DIST};
    index index.html;
    client_max_body_size 2m;
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;
    add_header Referrer-Policy same-origin;

    location / { try_files \$uri \$uri/ /index.html; }

    location /api/ {
        proxy_pass         http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Forwarded-For \$remote_addr;
        proxy_set_header   Connection '';
        proxy_buffering    off;            # Deploy log stream (SSE)
        proxy_read_timeout 3600s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/trustguard /etc/nginx/sites-enabled/trustguard
rm -f /etc/nginx/sites-enabled/default
# nginx (www-data) must be able to read the built dashboard, and nothing else under the install folder.
p="${DIST}"; while [ "$p" != "/" ]; do chmod o+x "$p"; p="$(dirname "$p")"; done
chmod -R o+rX "${DIST}"
nginx -t -q && systemctl reload nginx && ok "dashboard on http://${SERVER_IP}/"

# ── 8. Firewall (optional) ───────────────────────────────────────────────────
if [ "${FIREWALL}" = 1 ]; then
  section "8. Firewall (UFW): public ports ${PUBLIC_PORTS}"
  command -v ufw >/dev/null || apt-get install -y -qq ufw
  ufw allow OpenSSH >/dev/null
  for p in ${PUBLIC_PORTS}; do ufw allow "${p}/tcp" >/dev/null; done
  ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
  ufw status | sed 's/^/        /'
  info "Fabric ports are published on 127.0.0.1 by default (network.bindAddress), so Docker cannot expose them."
else
  section "8. Firewall"
  info "Skipped. To allow only SSH and the dashboard:  bash install.sh --firewall"
fi

# ── 9. First admin ───────────────────────────────────────────────────────────
section "9. Dashboard admin"
cd "${TG_HOME}/safety-dashboard/backend"
if TG_HOME="${TG_HOME}" "${NODE_BIN}" scripts/manageUsers.js list 2>/dev/null | grep -qE '^\S+ +admin +active'; then
  ok "An admin user exists."
elif [ -t 0 ]; then
  read -r -p "Username for the first dashboard admin [admin]: " ADMIN_USER
  TG_HOME="${TG_HOME}" "${NODE_BIN}" scripts/manageUsers.js add "${ADMIN_USER:-admin}" admin
else
  warn "No admin user yet. Create one:  cd ${TG_HOME}/safety-dashboard/backend && node scripts/manageUsers.js add admin admin"
fi

section "Done"
cat <<EOF
  Dashboard:  http://${SERVER_IP}/   (log in as the admin)
  Next:       Network Designer → Validate & Save → Deploy  (enrols the identities too)
              then add people:  cd ${TG_HOME}/safety-dashboard/backend && node scripts/manageUsers.js add <name> supervisor|auditor|claims-reviewer
              set CHIRPSTACK_APP_ID in config/client/gateway.env, then:  bash install.sh --enable-services
  Smoke test: cd ${TG_HOME}/safety-simulation && node simulateEvent.js
  Logs:       journalctl -fu trustguard-backend      Install log: ${LOG_FILE}
EOF

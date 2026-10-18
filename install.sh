#!/usr/bin/env bash
# =============================================================================
# TrustGuard IIoT — One-Command Installer
# Usage:
#   git clone https://github.com/iinot-technolabs/trustguard-iinot.git
#   cd trustguard-iinot && sudo bash install.sh
#
# What this does:
#   1. Checks / installs: Docker, Docker Compose v2, Node.js 18+, jq, curl
#   2. Downloads Hyperledger Fabric binaries into ./bin/
#   3. Writes a minimal .env (server paths only — network config via the UI)
#   4. npm install + Vite build (frontend)
#   5. npm install (backend)
#   6. Registers trustguard-backend as a systemd service
#   7. Configures nginx to serve the dashboard on port 80
#   8. Prints the dashboard URL — all network configuration is done in the browser
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${SCRIPT_DIR}/install.log"
ENV_FILE="${SCRIPT_DIR}/.env"
FABRIC_VERSION="2.5.9"
CA_VERSION="1.5.12"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
section() { echo -e "\n${BOLD}━━━ $* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

die() { error "$*"; exit 1; }

# Redirect all output to log as well
exec > >(tee -a "$LOG_FILE") 2>&1

# ── Root check ────────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Please run as root:  sudo bash install.sh"

# ─────────────────────────────────────────────────────────────────────────────
section "TrustGuard IIoT Installer"
echo -e "  Fabric ${FABRIC_VERSION} · Node 20+ · Docker Compose v2"
echo -e "  Log: ${LOG_FILE}\n"

# ─────────────────────────────────────────────────────────────────────────────
section "Step 1 — System Prerequisites"
# ─────────────────────────────────────────────────────────────────────────────

check_cmd() {
  if command -v "$1" &>/dev/null; then
    ok "$1 found: $(command -v "$1")"
    return 0
  fi
  return 1
}

install_docker() {
  info "Installing Docker Engine..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  ok "Docker installed: $(docker --version)"
}

install_node() {
  info "Installing Node.js 20 via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  ok "Node.js installed: $(node --version)"
}

install_jq() {
  info "Installing jq..."
  apt-get install -y jq
  ok "jq installed: $(jq --version)"
}

# Docker
if check_cmd docker; then
  VER=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "0")
  MAJOR="${VER%%.*}"
  [[ "$MAJOR" -ge 20 ]] || warn "Docker ${VER} is old; recommend 24+. Continuing."
else
  install_docker
fi

# Docker Compose v2 (plugin)
if docker compose version &>/dev/null; then
  ok "Docker Compose v2 found: $(docker compose version --short)"
else
  info "Installing Docker Compose plugin..."
  apt-get install -y docker-compose-plugin || \
    die "Could not install docker-compose-plugin. Install manually: https://docs.docker.com/compose/install/"
fi

# Node.js
if check_cmd node; then
  NODE_MAJOR=$(node -e "console.log(process.version.split('.')[0].replace('v',''))")
  [[ "$NODE_MAJOR" -ge 20 ]] || { warn "Node.js $(node --version) < 20; upgrading..."; install_node; }
else
  install_node
fi

# jq
check_cmd jq || install_jq

# curl (should always be present but check)
check_cmd curl || apt-get install -y curl

# build-essential (needed by native addons like better-sqlite3)
if ! dpkg -s build-essential &>/dev/null 2>&1; then
  info "Installing build-essential (required for native Node addons)..."
  apt-get install -y build-essential
  ok "build-essential installed."
else
  ok "build-essential already installed."
fi

ok "All system prerequisites satisfied."

# ─────────────────────────────────────────────────────────────────────────────
section "Step 2 — Hyperledger Fabric Binaries"
# ─────────────────────────────────────────────────────────────────────────────

FABRIC_BIN="${SCRIPT_DIR}/bin"
if [[ -x "${FABRIC_BIN}/peer" && -x "${FABRIC_BIN}/fabric-ca-client" ]]; then
  ok "Fabric binaries already present in ./bin/ — skipping download."
else
  info "Downloading Fabric ${FABRIC_VERSION} + CA ${CA_VERSION} binaries..."
  mkdir -p "${FABRIC_BIN}"

  # Use the official bootstrap script but redirect bins to our ./bin/
  TMPDIR=$(mktemp -d)
  curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh \
    -o "${TMPDIR}/install-fabric.sh"

  # Run from a temp dir so samples don't land in our repo
  pushd "${TMPDIR}" >/dev/null
  bash install-fabric.sh --fabric-version "${FABRIC_VERSION}" \
                          --ca-version      "${CA_VERSION}" \
                          binary
  popd >/dev/null

  # install-fabric.sh puts bins into $(pwd)/bin — move to our SCRIPT_DIR/bin
  if [[ -d "${TMPDIR}/bin" ]]; then
    cp -a "${TMPDIR}/bin/." "${FABRIC_BIN}/"
    ok "Fabric binaries installed to ./bin/"
  else
    die "Fabric binary download failed — check network and try again."
  fi
  rm -rf "${TMPDIR}"
fi

# Verify key binaries
for b in peer orderer fabric-ca-client fabric-ca-server configtxgen; do
  [[ -x "${FABRIC_BIN}/${b}" ]] || die "Missing Fabric binary: ${b}"
done
ok "All required Fabric binaries verified."

# ─────────────────────────────────────────────────────────────────────────────
section "Step 3 — Minimal .env (server paths)"
# ─────────────────────────────────────────────────────────────────────────────
# Network configuration (org names, domains, ports, channel, chaincode) is done
# entirely through the web dashboard — no CLI wizard needed.
# This step only writes the server-level paths that the backend process needs
# to find the Fabric binaries and network scripts at runtime.

BACKEND_PORT="${BACKEND_PORT:-3001}"
SERVER_HOST="${SERVER_HOST:-$(curl -s ifconfig.me 2>/dev/null || echo '127.0.0.1')}"

if [[ -f "${ENV_FILE}" ]]; then
  ok ".env already exists — keeping it."
else
  cat > "${ENV_FILE}" <<EOF
# TrustGuard IIoT — Server Environment
# Generated by install.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Network config (org names, channels, ports) is managed via the dashboard UI.

# Server
SERVER_HOST=${SERVER_HOST}
BACKEND_PORT=${BACKEND_PORT}
NODE_ENV=production

# Paths — resolved relative to this repo root
TRUSTGUARD_ROOT=${SCRIPT_DIR}
FABRIC_BIN=${SCRIPT_DIR}/bin
NETWORK_ROOT=${SCRIPT_DIR}/iinot-network
CHAINCODE_PATH=${SCRIPT_DIR}/safety-chaincode
CONFIG_FILE=${SCRIPT_DIR}/iinot-network/config/network-config.json
EOF
  ok ".env written with server paths."
fi

# Patch any remaining hardcoded /root/fabric/... paths in scripts
bash "${SCRIPT_DIR}/scripts/fix-hardcoded-paths.sh"

# ─────────────────────────────────────────────────────────────────────────────
section "Step 4 — npm Install + Frontend Build"
# ─────────────────────────────────────────────────────────────────────────────

# Backend
info "Installing backend dependencies..."
pushd "${SCRIPT_DIR}/safety-dashboard/backend" >/dev/null
npm install --omit=dev
ok "Backend npm install done."
popd >/dev/null

# Frontend
info "Installing frontend dependencies..."
pushd "${SCRIPT_DIR}/safety-dashboard/frontend" >/dev/null
npm install

info "Building frontend (Vite)..."
npm run build
ok "Frontend build complete → safety-dashboard/frontend/dist/"
popd >/dev/null

# ─────────────────────────────────────────────────────────────────────────────
section "Step 5 — Systemd Service"
# ─────────────────────────────────────────────────────────────────────────────

SERVICE_FILE="/etc/systemd/system/trustguard-backend.service"
NODE_BIN="$(command -v node)"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=TrustGuard IIoT Backend API
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=${SCRIPT_DIR}/safety-dashboard/backend
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=trustguard-backend

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable trustguard-backend
systemctl restart trustguard-backend

sleep 2
if systemctl is-active --quiet trustguard-backend; then
  ok "trustguard-backend service is running."
else
  warn "Service may not have started yet. Check: journalctl -u trustguard-backend -n 30"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Step 6 — nginx (serve dashboard on port 80)"
# ─────────────────────────────────────────────────────────────────────────────

if command -v nginx &>/dev/null || apt-get install -y nginx 2>/dev/null; then
  NGINX_CONF="/etc/nginx/sites-available/trustguard"
  cat > "${NGINX_CONF}" <<NGINX
server {
    listen 80;
    server_name ${SERVER_HOST} _;

    root ${SCRIPT_DIR}/safety-dashboard/frontend/dist;
    index index.html;

    # React SPA — all unknown paths serve index.html
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Proxy all /api/ calls to the Express backend
    # proxy_buffering off is required for SSE (Deploy log stream)
    location /api/ {
        proxy_pass         http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection '';
        proxy_set_header   Host \$host;
        proxy_buffering    off;
        proxy_cache        off;
        chunked_transfer_encoding on;
    }
}
NGINX

  ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/trustguard
  rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
  nginx -t && systemctl reload nginx
  ok "nginx configured — dashboard served on port 80."
else
  warn "nginx not available. The dashboard frontend won't be served automatically."
  warn "You can serve it manually: npx serve safety-dashboard/frontend/dist -l 80"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Installation Complete"
# ─────────────────────────────────────────────────────────────────────────────

HOST="${SERVER_HOST}"

echo ""
echo -e "${GREEN}${BOLD}  ✓  TrustGuard IIoT is installed!${NC}"
echo ""
echo -e "  Open this URL in your browser to continue:"
echo ""
echo -e "      ${BOLD}http://${HOST}/${NC}"
echo ""
echo -e "  From the dashboard:"
echo -e "   1. Go to ${BOLD}Configure Network${NC}"
echo -e "      → Enter your organisation names, domains, ports, and channel name"
echo -e "      → Set up access roles in the ${BOLD}Rules Designer${NC}"
echo -e "      → Click ${BOLD}Save Configuration${NC}"
echo ""
echo -e "   2. Go to ${BOLD}Deploy${NC}"
echo -e "      → Click ${BOLD}Deploy Network${NC}"
echo -e "      → Watch the live log — the full Fabric network will come up in ~3 min"
echo ""
echo -e "  ─────────────────────────────────────────────────────────"
echo -e "  Useful commands:"
echo -e "   journalctl -fu trustguard-backend              # live backend logs"
echo -e "   bash scripts/preflight-check.sh               # verify before first deploy"
echo -e "   bash iinot-network/scripts/network.sh down    # tear down containers"
echo -e "  ─────────────────────────────────────────────────────────"
echo ""
echo -e "  Install log saved to: ${LOG_FILE}"
echo ""

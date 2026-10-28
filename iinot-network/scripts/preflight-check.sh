#!/usr/bin/env bash
# =============================================================================
# preflight-check.sh
# Run before deploying to verify the environment is ready.
# Exit code 0 = all checks passed; 1 = failures found.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # install root (.env, bin/)
ENV_FILE="${SCRIPT_DIR}/.env"
[[ -f "${ENV_FILE}" ]] && source "${ENV_FILE}" || { echo "No .env found. Run install.sh first."; exit 1; }

PASS=0; FAIL=0

chk_ok()   { echo -e "  \033[32m✓\033[0m  $*"; (( PASS++ )) || true; }
chk_fail() { echo -e "  \033[31m✗\033[0m  $*"; (( FAIL++ )) || true; }
chk_warn() { echo -e "  \033[33m⚠\033[0m  $*"; }

echo ""
echo "━━━ TrustGuard IIoT — Pre-flight Checks ━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Binaries ─────────────────────────────────────────────────────────────────
echo ""
echo "  Binaries"
for b in peer orderer configtxgen fabric-ca-client fabric-ca-server; do
  [[ -x "${FABRIC_BIN:-${SCRIPT_DIR}/bin}/${b}" ]] \
    && chk_ok "${b}" \
    || chk_fail "${b} not found in ${FABRIC_BIN:-./bin}"
done
command -v docker   &>/dev/null && chk_ok "docker"    || chk_fail "docker not installed"
command -v node     &>/dev/null && chk_ok "node $(node --version)" || chk_fail "node not installed"
command -v jq       &>/dev/null && chk_ok "jq"        || chk_fail "jq not installed"

# ── Docker ────────────────────────────────────────────────────────────────────
echo ""
echo "  Docker"
docker info &>/dev/null \
  && chk_ok "Docker daemon running" \
  || chk_fail "Docker daemon not running — run: systemctl start docker"
docker compose version &>/dev/null \
  && chk_ok "Docker Compose v2" \
  || chk_fail "Docker Compose v2 plugin missing"

# ── Config ────────────────────────────────────────────────────────────────────
echo ""
echo "  Configuration"
CONFIG="${CONFIG_FILE:-${SCRIPT_DIR}/iinot-network/config/network-config.json}"
if [[ -f "${CONFIG}" ]]; then
  chk_ok "network-config.json found"
  # Check it has the new schema
  ORG_CNT=$(jq '.organizations | length' "${CONFIG}" 2>/dev/null || echo 0)
  [[ "$ORG_CNT" -ge 1 ]] \
    && chk_ok "organizations: ${ORG_CNT} org(s) defined" \
    || chk_fail "organizations array is empty — run the wizard or configure via dashboard"
  jq -e '.network.name' "${CONFIG}" &>/dev/null \
    && chk_ok ".network.name: $(jq -r '.network.name' "${CONFIG}")" \
    || chk_fail ".network.name missing in config"
  jq -e '.network.channel' "${CONFIG}" &>/dev/null \
    && chk_ok ".network.channel: $(jq -r '.network.channel' "${CONFIG}")" \
    || chk_fail ".network.channel missing in config"
else
  chk_fail "network-config.json not found at ${CONFIG}"
fi

# ── Ports ─────────────────────────────────────────────────────────────────────
echo ""
echo "  Port availability"
PORTS=( "${ORDERER_PORT:-7050}" "${BACKEND_PORT:-3001}" 80 )
# Add org ports from config if available
if [[ -f "${CONFIG}" ]]; then
  while IFS= read -r PORT; do PORTS+=("$PORT"); done \
    < <(jq -r '.organizations[].peerPort, .organizations[].caPort' "${CONFIG}" 2>/dev/null || true)
fi

for PORT in "${PORTS[@]}"; do
  if ss -tuln 2>/dev/null | grep -q ":${PORT} " || \
     netstat -tuln 2>/dev/null | grep -q ":${PORT} "; then
    chk_warn "Port ${PORT} already in use — stop any conflicting service before deploying"
  else
    chk_ok "Port ${PORT} free"
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Passed: ${PASS}   Failed: ${FAIL}"
echo ""
[[ "$FAIL" -eq 0 ]] && echo "  ✓ Ready to deploy!" || echo "  ✗ Fix the failures above before deploying."
echo ""
[[ "$FAIL" -eq 0 ]]

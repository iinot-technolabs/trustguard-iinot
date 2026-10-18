#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK_SH="${SCRIPT_DIR}/iinot-network/scripts/network.sh"
DEPLOY_JS="${SCRIPT_DIR}/safety-dashboard/backend/routes/deploy.js"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC}  $*"; }
skip() { echo -e "${YELLOW}[--]${NC}  $*"; }

echo ""
echo "━━━ Patching hardcoded paths ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if grep -q 'PATH=/root/fabric/bin' "${NETWORK_SH}" 2>/dev/null; then
  sed -i 's|PATH=/root/fabric/bin:|PATH=${FABRIC_BIN:-/root/fabric/bin}:|g' "${NETWORK_SH}"
  ok "network.sh: PATH uses \${FABRIC_BIN}"
else
  skip "network.sh: FABRIC_BIN already parameterised"
fi

if grep -q 'CC_PATH=.*fabric/safety-chaincode' "${NETWORK_SH}" 2>/dev/null; then
  perl -i -pe 's|CC_PATH="\$\{HOME\}/fabric/safety-chaincode"|CC_PATH="${CHAINCODE_PATH:-${HOME}/fabric/safety-chaincode}"|g' "${NETWORK_SH}"
  ok "network.sh: CC_PATH uses \${CHAINCODE_PATH}"
else
  skip "network.sh: CC_PATH already parameterised"
fi

if grep -q "const NETWORK_ROOT.*=.*'/root/fabric/iinot-network'" "${DEPLOY_JS}" 2>/dev/null; then
  perl -i -pe "s|const NETWORK_ROOT\s*=\s*'/root/fabric/iinot-network';|const NETWORK_ROOT   = process.env.NETWORK_ROOT \|\| '/root/fabric/iinot-network';|g" "${DEPLOY_JS}"
  ok "deploy.js: NETWORK_ROOT reads from process.env"
else
  skip "deploy.js: NETWORK_ROOT already parameterised"
fi

echo ""
ok "Path patching complete."

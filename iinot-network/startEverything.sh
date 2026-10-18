#!/bin/bash
#
# startEverything.sh — IINoT Lone Worker Safety: full stack restart
#
# Usage:
#   ./startEverything.sh          — start everything
#   ./startEverything.sh stop     — stop backend/frontend background processes
#   ./startEverything.sh status   — check what's currently running

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; }
success() { echo -e "${BLUE}[OK]${NC} $1"; }

IINOT_NETWORK_DIR="${HOME}/fabric/iinot-network"
DASHBOARD_BACKEND_DIR="${HOME}/fabric/safety-dashboard/backend"
DASHBOARD_FRONTEND_DIR="${HOME}/fabric/safety-dashboard/frontend"
SIMULATION_DIR="${HOME}/fabric/safety-simulation"
LOG_DIR="${HOME}/fabric/logs"
PID_DIR="${HOME}/fabric/.pids"

mkdir -p "${LOG_DIR}" "${PID_DIR}"

function startFabricNetwork() {
    info "Starting IINoT Fabric network containers..."
    docker start ca.iinot-industry.com ca.iinot-regulator.com ca.iinot-safety.com \
        orderer.iinot-safety.com peer0.iinot-industry.com peer0.iinot-regulator.com \
        2>/dev/null || warn "Some containers may not exist yet — run network.sh all if this is a fresh setup"

    info "Waiting for containers to settle..."
    sleep 5
    echo ""
    docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "iinot|orderer|peer0" || true
    echo ""

    local running_count
    running_count=$(docker ps --format "{{.Names}}" | grep -cE "ca.iinot|orderer.iinot|peer0.iinot")

    if [ "${running_count}" -ge 6 ]; then
        success "All 6 core network containers are up"
    else
        error "Only ${running_count}/6 core containers running — check Docker Desktop is open and try again"
        exit 1
    fi
}

function healthCheckChaincode() {
    info "Verifying chaincode responds (this also wakes the chaincode container)..."
    cd "${SIMULATION_DIR}"

    if [ ! -f "wallet/supervisor1/cert.pem" ]; then
        warn "supervisor1 not enrolled in wallet — skipping chaincode health check"
        return
    fi

    if node -e "
        const fs = require('fs');
        const path = require('path');
        const crypto = require('crypto');
        const grpc = require('@grpc/grpc-js');
        const { connect, signers } = require('@hyperledger/fabric-gateway');
        const NETWORK_HOME = path.join(process.env.HOME, 'fabric', 'iinot-network');
        const WALLET_DIR = path.join('${SIMULATION_DIR}', 'wallet');
        const TLS_CERT = path.join(NETWORK_HOME, 'organizations', 'peerOrganizations',
            'iinot-industry.com', 'peers', 'peer0.iinot-industry.com', 'tls', 'ca.crt');
        (async () => {
            const credentials = fs.readFileSync(path.join(WALLET_DIR, 'supervisor1', 'cert.pem'));
            const privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(WALLET_DIR, 'supervisor1', 'key.pem')));
            const tlsRootCert = fs.readFileSync(TLS_CERT);
            const grpcClient = new grpc.Client('localhost:7051', grpc.credentials.createSsl(tlsRootCert),
                { 'grpc.ssl_target_name_override': 'peer0.iinot-industry.com' });
            const gateway = connect({ client: grpcClient, identity: { mspId: 'IINoTIndustryMSP', credentials },
                signer: signers.newPrivateKeySigner(privateKey) });
            try {
                const contract = gateway.getNetwork('iinot-safety-channel').getContract('safetycc');
                await contract.evaluateTransaction('GetAllIncidents');
                process.exit(0);
            } catch (e) {
                process.exit(1);
            } finally {
                gateway.close();
                grpcClient.close();
            }
        })();
    " 2>/dev/null; then
        success "Chaincode is responding correctly"
    else
        warn "Chaincode health check failed — it may still be starting up"
        warn "If the dashboard doesn't load incidents, wait 10s and refresh"
    fi
}

function startDashboardBackend() {
    info "Starting dashboard backend (Express API)..."
    if [ -f "${PID_DIR}/backend.pid" ] && kill -0 "$(cat "${PID_DIR}/backend.pid")" 2>/dev/null; then
        warn "Backend already running (PID $(cat "${PID_DIR}/backend.pid")) — skipping"
        return
    fi
    cd "${DASHBOARD_BACKEND_DIR}"
    nohup npm run dev > "${LOG_DIR}/backend.log" 2>&1 &
    echo $! > "${PID_DIR}/backend.pid"
    sleep 3
    if curl -s http://localhost:3001/health > /dev/null 2>&1; then
        success "Backend running on http://localhost:3001 (PID $(cat "${PID_DIR}/backend.pid"))"
    else
        error "Backend did not respond — check ${LOG_DIR}/backend.log"
    fi
}

function startDashboardFrontend() {
    info "Starting dashboard frontend (Vite)..."
    if [ -f "${PID_DIR}/frontend.pid" ] && kill -0 "$(cat "${PID_DIR}/frontend.pid")" 2>/dev/null; then
        warn "Frontend already running (PID $(cat "${PID_DIR}/frontend.pid")) — skipping"
        return
    fi
    cd "${DASHBOARD_FRONTEND_DIR}"
    nohup node node_modules/.bin/vite --host 0.0.0.0 --port 5173 > "${LOG_DIR}/frontend.log" 2>&1 &
    echo $! > "${PID_DIR}/frontend.pid"
    sleep 3
    success "Frontend starting on http://localhost:5173 (PID $(cat "${PID_DIR}/frontend.pid"))"
}

function stopAll() {
    info "Stopping dashboard backend and frontend..."
    for name in backend frontend; do
        if [ -f "${PID_DIR}/${name}.pid" ]; then
            pid=$(cat "${PID_DIR}/${name}.pid")
            if kill -0 "${pid}" 2>/dev/null; then
                kill "${pid}"
                success "Stopped ${name} (PID ${pid})"
            else
                warn "${name} was not running"
            fi
            rm -f "${PID_DIR}/${name}.pid"
        fi
    done
    info "Fabric network containers left running"
}

function showStatus() {
    echo ""
    info "Fabric network containers:"
    docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "iinot|orderer|peer0|NAMES" || echo "  None running"
    echo ""
    info "Dashboard processes:"
    for name in backend frontend; do
        if [ -f "${PID_DIR}/${name}.pid" ] && kill -0 "$(cat "${PID_DIR}/${name}.pid")" 2>/dev/null; then
            success "${name}: running (PID $(cat "${PID_DIR}/${name}.pid"))"
        else
            warn "${name}: not running"
        fi
    done
    echo ""
    info "Logs: ${LOG_DIR}/backend.log, ${LOG_DIR}/frontend.log"
    echo ""
}

case "$1" in
    stop)
        stopAll
        ;;
    status)
        showStatus
        ;;
    "")
        echo ""
        echo "════════════════════════════════════════════════════"
        echo "  IINoT Lone Worker Safety — Full Stack Startup"
        echo "════════════════════════════════════════════════════"
        echo ""
        startFabricNetwork
        healthCheckChaincode
        startDashboardBackend
        startDashboardFrontend
        echo ""
        echo "════════════════════════════════════════════════════"
        success "Everything is up!"
        echo ""
        echo "  Dashboard : http://localhost:5173"
        echo "  API       : http://localhost:3001/health"
        echo ""
        echo "  To stop dashboard processes : ./startEverything.sh stop"
        echo "  To check status             : ./startEverything.sh status"
        echo "  To view backend logs        : tail -f ${LOG_DIR}/backend.log"
        echo "  To view frontend logs       : tail -f ${LOG_DIR}/frontend.log"
        echo "════════════════════════════════════════════════════"
        echo ""
        ;;
    *)
        echo "Usage: $0 [stop|status]"
        exit 1
        ;;
esac

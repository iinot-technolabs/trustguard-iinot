#!/bin/bash
# acceptance-checks.sh — acceptance checks T2, T3, T4 (+ the local half of T9)
# for a deployed TrustGuard network. Every name, port and path comes from the
# deployed network model (iinot-network/config/network.derived.json).
#
#   bash iinot-network/scripts/acceptance-checks.sh            # T2, T3, T4 and local listeners
#   bash iinot-network/scripts/acceptance-checks.sh t2|t3|t4|listen
#
# Read-only except T3, which submits two test transactions (ids T3-…): one that the
# endorsement policy must reject and one that must succeed.
# Prints no secret: T4 reports only counts of secret values found, never the values.
# Output is also written to ./tg-checks-<date>.log for the report.
set -u
TG_HOME="${TG_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
N="${TG_HOME}/iinot-network"
export PATH="${FABRIC_BIN:-${TG_HOME}/bin}:${PATH}" FABRIC_CFG_PATH="${N}"
LOG="${TG_CHECKS_LOG_DIR:-${PWD}}/tg-checks-$(date +%Y%m%d-%H%M%S).log"
exec > >(sed -u 's/\x1b\[[0-9;]*m//g' | tee -a "${LOG}") 2>&1

PASS=0; FAIL=0
pass() { echo "  PASS  $*"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $*"; FAIL=$((FAIL+1)); }
hdr()  { echo; echo "== $* =="; }

cd "${N}" || { echo "No ${N}"; exit 2; }
. scripts/config-reader.sh || exit 2
TMP="$(mktemp -d)"; chmod 700 "${TMP}"; trap 'rm -rf "${TMP}"' EXIT
OCA="${N}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/${ORDERER_HOST}/tls/ca.crt"
OFLAGS=(-o "localhost:${ORDERER_PORT}" --ordererTLSHostnameOverride "${ORDERER_HOST}" --tls --cafile "${OCA}")
peerTls() { echo "${N}/organizations/peerOrganizations/${ORG_DOMAINS[$1]}/peers/${ORG_PEER_HOSTS[$1]}/tls/ca.crt"; }
asOrg() {   # asOrg <org index> <msp dir>
    export CORE_PEER_TLS_ENABLED=true CORE_PEER_LOCALMSPID="${ORG_MSPIDS[$1]}" \
           CORE_PEER_TLS_ROOTCERT_FILE="$(peerTls "$1")" CORE_PEER_MSPCONFIGPATH="$2" \
           CORE_PEER_ADDRESS="localhost:${ORG_PEER_PORTS[$1]}"
}
adminMsp() { echo "${N}/organizations/peerOrganizations/${ORG_DOMAINS[$1]}/users/Admin@${ORG_DOMAINS[$1]}/msp"; }

echo "TrustGuard Phase 1 checks — $(hostname) — $(date -u +%FT%TZ)"
echo "Network: ${NETWORK_NAME} | channel ${CHANNEL_NAME} | ${CC_NAME} ${CC_VERSION} seq ${CC_SEQUENCE} | policy ${CC_POLICY}"
echo "Git: $(git -C "${TG_HOME}" rev-parse --abbrev-ref HEAD 2>/dev/null) $(git -C "${TG_HOME}" rev-parse --short HEAD 2>/dev/null)"

# ── T2: channel settings and committed chaincode definition ────────────────────
t2() {
    hdr "T2 Channel settings"
    asOrg 0 "$(adminMsp 0)"
    if ! peer channel fetch config "${TMP}/cfg.pb" "${OFLAGS[@]}" -c "${CHANNEL_NAME}" >"${TMP}/fetch.log" 2>&1; then
        tail -3 "${TMP}/fetch.log"; fail "could not fetch the channel config"; return
    fi
    configtxlator proto_decode --input "${TMP}/cfg.pb" --type common.Block --output "${TMP}/cfg.json"
    local G='.data.data[0].payload.data.config.channel_group'
    local bt want; bt="$(jq -r "${G}.groups.Orderer.values.BatchTimeout.value.timeout" "${TMP}/cfg.json")"
    want="$(jq -r .orderer.batchTimeout config/network.derived.json)"
    echo "  BatchTimeout on the channel: ${bt} (config: ${want})"
    echo "  BatchSize: $(jq -c "${G}.groups.Orderer.values.BatchSize.value" "${TMP}/cfg.json")"
    echo "  Channel members: $(jq -r "${G}.groups.Application.groups | keys | join(\", \")" "${TMP}/cfg.json")"
    [ "${bt}" = "${want}" ] && pass "BatchTimeout is ${want}" || fail "BatchTimeout is ${bt}, expected ${want}"

    local q; q="$(peer lifecycle chaincode querycommitted --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" --output json 2>&1)" \
        || { echo "${q}" | tail -3; fail "querycommitted failed"; return; }
    echo "  Committed: $(echo "${q}" | jq -c '{version, sequence, approvals}')"
    echo "${q}" | jq -r .validation_parameter | base64 -d > "${TMP}/vp.pb"
    if configtxlator proto_decode --input "${TMP}/vp.pb" --type protos.ApplicationPolicy --output "${TMP}/vp.json" 2>/dev/null; then
        local n k ids=""; n="$(jq '.signature_policy.rule.n_out_of.n' "${TMP}/vp.json")"
        for k in $(jq -r '.signature_policy.identities[].principal' "${TMP}/vp.json"); do
            echo "${k}" | base64 -d > "${TMP}/p.pb"
            configtxlator proto_decode --input "${TMP}/p.pb" --type common.MSPRole --output "${TMP}/p.json" 2>/dev/null \
                && ids+="$(jq -r '"\(.msp_identifier).\(.role|ascii_downcase)"' "${TMP}/p.json"), "
        done
        echo "  Endorsement policy on the ledger: ${n} of [${ids%, }] must sign"
    fi
    local i vp; vp="$(tr -c '[:print:]' ' ' < "${TMP}/vp.pb")"
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        if [ "${ORG_ENDORSES[$i]}" = "true" ]; then
            grep -q "${ORG_MSPIDS[$i]}" <<<"${vp}" && pass "policy requires ${ORG_MSPIDS[$i]}" || fail "policy is missing ${ORG_MSPIDS[$i]}"
        else
            grep -q "${ORG_MSPIDS[$i]}" <<<"${vp}" && fail "policy includes non-endorsing ${ORG_MSPIDS[$i]}" || pass "${ORG_MSPIDS[$i]} is not an endorser"
        fi
    done
}

# ── T3: the endorsement policy is enforced at commit time ─────────────────────
t3() {
    hdr "T3 Endorsement policy, negative and positive"
    local gi="" gname="" i u
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        for u in ${ORG_USERS[$i]}; do [ "${u#*:}" = gateway ] && { gi=$i; gname="${u%%:*}"; }; done
    done
    [ -n "${gi}" ] || { fail "no identity with role gateway"; return; }
    local msp="${N}/organizations/peerOrganizations/${ORG_DOMAINS[$gi]}/users/${gname}@${ORG_DOMAINS[$gi]}/msp"
    [ -d "${msp}" ] || { fail "no MSP folder for ${gname} (${msp})"; return; }
    asOrg "${gi}" "${msp}"
    echo "  Submitting as ${gname} (${ORG_MSPIDS[$gi]}, role gateway)"

    local tag; tag="$(date +%H%M%S)"
    invoke() {   # invoke <incident id> <org index>...
        local id=$1; shift
        local args=() j
        for j in "$@"; do args+=(--peerAddresses "localhost:${ORG_PEER_PORTS[$j]}" --tlsRootCertFiles "$(peerTls "$j")"); done
        local h; h="$(printf %s "${id}" | sha256sum | cut -d' ' -f1)"
        peer chaincode invoke "${OFLAGS[@]}" -C "${CHANNEL_NAME}" -n "${CC_NAME}" "${args[@]}" --waitForEvent \
            -c "{\"function\":\"LogIncident\",\"Args\":[\"${id}\",\"t3-test-beacon\",\"SOS\",\"${h}\",\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"50\"]}" 2>&1
    }
    exists() { peer chaincode query -C "${CHANNEL_NAME}" -n "${CC_NAME}" -c "{\"Args\":[\"GetIncident\",\"$1\"]}" >/dev/null 2>&1; }
    names() { local s="" j; for j in "$@"; do s+="${ORG_MSPIDS[$j]} + "; done; echo "${s% + }"; }

    local endorsers=() others=()
    for i in $(seq 0 $((ORG_COUNT - 1))); do
        [ "${ORG_ENDORSES[$i]}" = "true" ] && endorsers+=("$i") || others+=("$i")
    done
    # Negative sets: each endorser alone (when more than one is required), and the
    # gateway's org with every non-endorsing org.
    local sets=()
    if [ "${#endorsers[@]}" -gt 1 ] && [[ "${CC_POLICY}" == AND* ]]; then
        for i in "${endorsers[@]}"; do sets+=("$i"); done
    fi
    [ "${#others[@]}" -gt 0 ] && sets+=("${gi} ${others[*]}")
    [ "${#sets[@]}" -gt 0 ] || echo "  (policy is satisfied by a single org: no negative case to test)"

    local n=0 s out id
    for s in "${sets[@]}"; do
        n=$((n+1)); id="T3-BAD${n}-${tag}"
        out="$(invoke "${id}" ${s})"
        echo "  ${id} endorsed by $(names ${s}):"
        echo "${out}" | grep -E 'invalid|status|Error' | sed 's/^/      /' | tail -2
        if grep -q ENDORSEMENT_POLICY_FAILURE <<<"${out}" && ! exists "${id}"; then
            pass "rejected with ENDORSEMENT_POLICY_FAILURE and not on the ledger"
        else
            fail "not rejected by the policy"
        fi
    done

    id="T3-OK-${tag}"
    out="$(invoke "${id}" "${endorsers[@]}")"
    echo "  ${id} endorsed by $(names "${endorsers[@]}"):"
    echo "${out}" | grep -E 'committed|status|Error' | sed 's/^/      /' | tail -2
    if grep -q '(VALID)' <<<"${out}" && exists "${id}"; then pass "accepted (VALID) and readable from the ledger"
    else fail "valid endorsement set was not accepted"; fi
}

# ── T4: no secret in git, logs or configs ─────────────────────────────────────
t4() {
    hdr "T4 Secrets"
    local f
    git -C "${TG_HOME}" rev-parse --git-dir >/dev/null 2>&1 || { fail "${TG_HOME} is not a git checkout"; return; }
    for f in iinot-network/config/secrets/secrets.json iinot-network/config/secrets/compose.env .env \
             safety-dashboard/backend/users.json wallet config/client; do
        [ -e "${TG_HOME}/${f}" ] || continue
        if git -C "${TG_HOME}" ls-files --error-unmatch "${f}" >/dev/null 2>&1; then fail "${f} is tracked by git"
        elif git -C "${TG_HOME}" check-ignore -q "${f}"; then pass "${f} is ignored by git"
        else fail "${f} is neither tracked nor ignored (could be committed by mistake)"; fi
    done
    local leaked; leaked="$(git -C "${TG_HOME}" ls-files | grep -E '(^|/)(wallet/|users\.json$|\.env$|secrets|offchain\.db|.*\.pem$|.*_sk$)' || true)"
    [ -z "${leaked}" ] && pass "no key, wallet, users.json, .env, secrets or database file in git" || { fail "files in git:"; echo "${leaked}" | sed 's/^/      /'; }

    # Scan logs and configs for the actual secret values (passwords, AUTH_SECRET, private keys).
    journalctl --no-pager -q -u trustguard-backend -u trustguard-gateway -u trustguard-oracle \
        -u trustguard-escalation -u nginx > "${TMP}/journal.txt" 2>/dev/null || true
    for c in $(docker ps -a --format '{{.Names}}' 2>/dev/null); do docker logs "${c}" > "${TMP}/docker-${c}.txt" 2>&1; done
    TG_HOME="${TG_HOME}" TMP="${TMP}" python3 -I - <<'PY'
import glob, json, os, subprocess
home, tmp = os.environ["TG_HOME"], os.environ["TMP"]
vals = set()
def walk(x):
    if isinstance(x, dict): [walk(v) for v in x.values()]
    elif isinstance(x, list): [walk(v) for v in x]
    elif isinstance(x, str) and len(x) >= 8: vals.add(x)
try: walk(json.load(open(f"{home}/iinot-network/config/secrets/secrets.json")))
except Exception as e: print(f"  (no secrets.json: {e})")
for envf in (f"{home}/.env", f"{home}/iinot-network/config/secrets/compose.env"):
    try:
        for l in open(envf):
            k, _, v = l.strip().partition("=")
            if v and ("SECRET" in k or "PW" in k or "PASS" in k or "TOKEN" in k) and len(v) >= 8: vals.add(v)
    except FileNotFoundError: pass
for k in glob.glob(f"{home}/wallet/*/key.pem"):
    body = "".join(l for l in open(k) if "-----" not in l).replace("\n", "")
    if len(body) > 20: vals.add(body[:40])
print(f"  Looking for {len(vals)} secret value(s) (values are not printed)")
src = {"journal (backend, services, nginx)": f"{tmp}/journal.txt"}
for f in glob.glob(f"{tmp}/docker-*.txt"): src["docker logs " + os.path.basename(f)[7:-4]] = f
for pat in ("install.log", "*.log", "iinot-network/*.log", "iinot-network/config/network-config.json",
            "iinot-network/config/network.derived.json", "iinot-network/config/app.env",
            "iinot-network/docker/docker-compose.yaml", "config/client/*"):
    for f in glob.glob(f"{home}/{pat}"): src[os.path.relpath(f, home)] = f
for f in glob.glob("/root/*.log") + glob.glob("/var/log/nginx/*.log"): src[f] = f
tracked = subprocess.run(["git", "-C", home, "ls-files", "-z"], capture_output=True).stdout.decode().split("\0")
gitblob = ""
for t in tracked:
    p = os.path.join(home, t)
    if t and os.path.isfile(p) and os.path.getsize(p) < 5_000_000:
        try: gitblob += open(p, errors="ignore").read()
        except Exception: pass
bad = 0
def check(name, text):
    global bad
    hits = sum(1 for v in vals if v in text)
    print(f"  {'FAIL' if hits else 'PASS'}  {name}: " + (f"{hits} secret value(s) found" if hits else "clean"))
    bad += 1 if hits else 0
check("git tracked files", gitblob)
for name, f in sorted(src.items()):
    try: check(name, open(f, errors="ignore").read())
    except Exception: pass
open(f"{tmp}/t4.result", "w").write(str(bad))
PY
    local b; b="$(cat "${TMP}/t4.result" 2>/dev/null || echo 1)"
    [ "${b}" = 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
}

# ── T9 (local half): what listens on a non-loopback address ───────────────────
listen() {
    hdr "T9 Listeners on public interfaces (this host)"
    local l; l="$( (ss -Hltn 2>/dev/null || netstat -ltn 2>/dev/null | tail -n +3) | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' | sort -u)"
    echo "${l}" | sed 's/^/  /'
    local fabric="${ORDERER_PORT} ${ORDERER_ADMIN_PORT} ${ORDERER_CA_PORT}"
    local i; for i in $(seq 0 $((ORG_COUNT - 1))); do fabric+=" ${ORG_PEER_PORTS[$i]} ${ORG_CA_PORTS[$i]} ${ORG_OPS_PORTS[$i]} ${ORG_CHAINCODE_PORTS[$i]}"; done
    local p bad=0; for p in ${fabric} 3001; do grep -qE ":${p}\$" <<<"${l}" && { fail "port ${p} listens on a public address"; bad=1; }; done
    [ "${bad}" = 0 ] && pass "Fabric ports and 3001 listen on 127.0.0.1 only"
    command -v ufw >/dev/null && { echo "  UFW:"; ufw status | sed 's/^/    /'; }
}

case "${1:-all}" in
    t2) t2 ;; t3) t3 ;; t4) t4 ;; listen) listen ;;
    all) t2; t3; t4; listen ;;
    *) echo "usage: $0 [t2|t3|t4|listen|all]"; exit 2 ;;
esac
echo; echo "Result: ${PASS} passed, ${FAIL} failed — log: ${LOG}"
[ "${FAIL}" = 0 ]

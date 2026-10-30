#!/usr/bin/env bash
# =============================================================================
# apply_tg_merge_f — CA admin password out of CA logs; oracle service start fix (TG-024)
#
# Run from the root of your trustguard-iinot working copy (e.g. /root/trustguard-iinot):
#   bash apply_tg_merge_f.sh --check      read-only: shows what would change; changes nothing
#   bash apply_tg_merge_f.sh              apply (backs up every file it replaces into .tg-backup/apply_tg_merge_f/)
#   bash apply_tg_merge_f.sh --rollback   put back exactly what was there before
#
# Safety:
#   - Every file is checked by SHA-256 before it is touched. A file that is neither the
#     expected original (origin origin/master) nor the new version stops the run, and nothing is changed.
#   - Re-running is safe: files already updated are skipped. An interrupted run can be re-run.
#   - Changes files only. It does not run git, docker, Fabric or any service, and it never
#     touches /root/fabric or a running network.
# =============================================================================
set -euo pipefail

NAME="apply_tg_merge_f"
PAYLOAD_SHA="7cacf51f24ae85024f25215b2fa4b7545e1e7ff039b382ee38baf9975f6304b8"
SELF="$(readlink -f "$0")"
ROOT="$(pwd)"
BACKUP="${ROOT}/.tg-backup/${NAME}"
MODE="apply"
case "${1:-}" in
  --check)    MODE="check" ;;
  --rollback) MODE="rollback" ;;
  "")         ;;
  *) echo "usage: bash ${NAME}.sh [--check | --rollback]"; exit 2 ;;
esac

# kind|path|original sha256|new sha256      M modified  A added  D deleted  U retired leftover (moved to backup)
MANIFEST='M|safety-dashboard/backend/lib/generateConfigs.js|e3a2f4b208e1889673426aa1eb2c800281803d89fb28b5098030ac19f3c1c013|d8e396baed75e4a118edcf0db4e7a21637dbf2450c1532032854445b3794be37
M|safety-simulation/oracleService.js|dc031569ecb2cb680f3b1786ee161f1bce7675147f6db80f5f6f8dcb9ca95654|610198da2648b3f013d86ec5f5f9f25c18e106770bc74b9d875d24da02eeb01f'

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }
h()     { [ -f "$1" ] && sha256sum "$1" | cut -d' ' -f1 || echo absent; }

# ── where are we? ─────────────────────────────────────────────
if [ ! -f "${ROOT}/iinot-network/scripts/network.sh" ] || [ ! -d "${ROOT}/safety-dashboard/backend" ]; then
  red "Run this from the root of the trustguard-iinot working copy (the folder with iinot-network/ and safety-dashboard/)."
  exit 2
fi
case "${ROOT}" in /root/fabric|/root/fabric/*) red "Refusing to run inside /root/fabric (the live MVP network)."; exit 2 ;; esac
if git -C "${ROOT}" remote get-url origin 2>/dev/null | grep -qvi "trustguard-iinot"; then
  red "This git checkout's origin is not trustguard-iinot; stopping."; exit 2
fi

state_of() {   # kind path orig new → done | pending | CONFLICT
  local k=$1 p=$2 o=$3 n=$4 cur
  case "$k" in
    U) [ -e "${ROOT}/$p" ] && echo pending || echo done; return ;;
  esac
  cur="$(h "${ROOT}/$p")"
  case "$k" in
    M) if [ "$cur" = "$n" ]; then echo done; elif [ "$cur" = "$o" ]; then echo pending; else echo CONFLICT; fi ;;
    A) if [ "$cur" = "$n" ]; then echo done; elif [ "$cur" = absent ]; then echo pending; else echo CONFLICT; fi ;;
    D) if [ "$cur" = absent ]; then echo done; elif [ "$cur" = "$o" ]; then echo pending; else echo CONFLICT; fi ;;
  esac
}

survey() {
  PENDING=0; DONE=0; CONFLICTS=0
  while IFS='|' read -r k p o n; do
    [ -z "$k" ] && continue
    s="$(state_of "$k" "$p" "$o" "$n")"
    case "$s" in
      pending)  PENDING=$((PENDING+1)); if [ "$1" = verbose ]; then info "$(printf '%-8s %s  %s' "$s" "$k" "$p")"; fi ;;
      done)     DONE=$((DONE+1));       if [ "$1" = verbose ]; then info "$(printf '%-8s %s  %s' "$s" "$k" "$p")"; fi ;;
      CONFLICT) CONFLICTS=$((CONFLICTS+1)); red "  CONFLICT $k  $p  (local changes: sha256 $(h "${ROOT}/$p" | cut -c1-12)…)" ;;
    esac
  done <<< "${MANIFEST}"
  return 0
}

extract_payload() {   # → $1 directory
  local b64; b64="$(mktemp)"
  sed -n '/^__PAYLOAD__$/,$p' "${SELF}" | tail -n +2 > "${b64}"
  base64 -d "${b64}" > "${b64}.tgz"
  [ "$(sha256sum "${b64}.tgz" | cut -d' ' -f1)" = "${PAYLOAD_SHA}" ] || { red "Payload checksum mismatch: the script file is damaged."; exit 3; }
  tar -xzf "${b64}.tgz" -C "$1"
  rm -f "${b64}" "${b64}.tgz"
}

# ── check ─────────────────────────────────────────────────────
if [ "${MODE}" = check ]; then
  echo "${NAME} --check (read-only) in ${ROOT}"
  survey verbose
  echo "  ${PENDING} to change, ${DONE} already done, ${CONFLICTS} conflicts"
  [ "${CONFLICTS}" -eq 0 ] && green "Check passed." || { red "Check failed: resolve the conflicts above first (git diff / git stash)."; exit 1; }
  exit 0
fi

# ── rollback ──────────────────────────────────────────────────
if [ "${MODE}" = rollback ]; then
  [ -f "${BACKUP}/actions.log" ] || { red "Nothing to roll back (${BACKUP}/actions.log not found)."; exit 1; }
  echo "Rolling back ${NAME} in ${ROOT}"
  tac "${BACKUP}/actions.log" | while IFS='|' read -r k p o n; do
    case "$k" in
      M|D) if [ -n "$o" ] && [ "$(h "${BACKUP}/files/$p")" != "$o" ]; then red "  backup of $p does not match its recorded hash; leaving it"; continue; fi
           mkdir -p "$(dirname "${ROOT}/$p")"; cp -p "${BACKUP}/files/$p" "${ROOT}/$p"; info "restored  $p" ;;
      A)   rm -f "${ROOT}/$p"; rmdir -p "$(dirname "${ROOT}/$p")" 2>/dev/null || true; info "removed   $p" ;;
      U)   if [ -e "${BACKUP}/files/$p" ]; then mkdir -p "$(dirname "${ROOT}/$p")"; mv "${BACKUP}/files/$p" "${ROOT}/$p"; info "returned  $p"; fi ;;
    esac
  done
  mv "${BACKUP}" "${BACKUP}.rolled-back-$(date +%Y%m%d-%H%M%S)"
  green "Rollback complete."
  exit 0
fi

# ── apply ─────────────────────────────────────────────────────
echo "Applying ${NAME} in ${ROOT}"
survey quiet
if [ "${CONFLICTS}" -gt 0 ]; then red "Stopped before changing anything: ${CONFLICTS} conflicts (run --check for the list)."; exit 1; fi
if [ "${PENDING}" -eq 0 ]; then green "Nothing to do: all ${DONE} items are already applied."; exit 0; fi

STAGE="$(mktemp -d)"; trap 'rm -rf "${STAGE}"' EXIT
extract_payload "${STAGE}"
mkdir -p "${BACKUP}/files"; chmod 700 "${ROOT}/.tg-backup" "${BACKUP}"

while IFS='|' read -r k p o n; do
  [ -z "$k" ] && continue
  [ "$(state_of "$k" "$p" "$o" "$n")" = pending ] || continue
  case "$k" in
    M|D) mkdir -p "$(dirname "${BACKUP}/files/$p")"; cp -p "${ROOT}/$p" "${BACKUP}/files/$p" ;;
    U)   mkdir -p "$(dirname "${BACKUP}/files/$p")"; rm -rf "${BACKUP}/files/$p" ;;
  esac
  echo "$k|$p|$o|$n" >> "${BACKUP}/actions.log"        # recorded before the change, so rollback can undo a partial run
  case "$k" in
    M|A) [ "$(h "${STAGE}/$p")" = "$n" ] || { red "payload file $p has the wrong hash"; exit 3; }
         mkdir -p "$(dirname "${ROOT}/$p")"; cp "${STAGE}/$p" "${ROOT}/$p.tg-new"
         if [ -x "${STAGE}/$p" ]; then chmod +x "${ROOT}/$p.tg-new"; fi
         mv "${ROOT}/$p.tg-new" "${ROOT}/$p"; info "$( [ "$k" = M ] && echo updated || echo added)   $p" ;;
    D)   rm -f "${ROOT}/$p"; info "deleted   $p" ;;
    U)   mv "${ROOT}/$p" "${BACKUP}/files/$p"; info "retired   $p (kept in ${BACKUP}/files/)" ;;
  esac
done <<< "${MANIFEST}"

survey quiet
if [ "${PENDING}" -ne 0 ] || [ "${CONFLICTS}" -ne 0 ]; then red "Verification failed: ${PENDING} pending, ${CONFLICTS} conflicts after apply."; exit 4; fi
green "Applied and verified (${DONE} items). Backup: ${BACKUP}"
cat <<EOF

Next (you commit and push):
  cd ${ROOT}
  git status --short                          # review: only package files, no .env / wallet / users.json
  git branch --show-current                   # should say master
  git add -A
  git commit -m "${NAME}: CA admin password out of CA logs; oracle service start fix (TG-024)"
  git push
EOF

exit 0

__PAYLOAD__
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

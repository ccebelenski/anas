#!/usr/bin/env bash
#
# Remove ANAS from a Proxmox VE node. Idempotent — safe to run repeatedly and
# safe to run on a partially-installed node.
#
set -euo pipefail

PREFIX="${PREFIX:-/opt/anas}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"

log()  { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }

usage() {
  cat <<EOF
ANAS uninstaller

Usage: sudo ./uninstall.sh [--prefix DIR]

Options:
  --prefix DIR   Install location to remove (default: /opt/anas).
  -h, --help     Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)   shift; [ "$#" -gt 0 ] || { err "--prefix needs an argument"; exit 2; }; PREFIX="$1" ;;
    --prefix=*) PREFIX="${1#*=}" ;;
    -h|--help)  usage; exit 0 ;;
    *) err "unknown option: $1"; usage >&2; exit 2 ;;
  esac
  shift
done

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  err "must run as root (EUID 0) — try: sudo ./uninstall.sh"
  exit 1
fi

log "Uninstalling ANAS (prefix: ${PREFIX})..."

# 1. Stop and disable services (ignore errors — may already be gone).
info "stopping and disabling services"
systemctl disable --now anasd anas >/dev/null 2>&1 || true

# 2. Revert the PVE UI integration if its uninstaller is still present.
if [ -x "${PREFIX}/packages/pve-integration/uninstall.sh" ]; then
  info "reverting PVE UI integration"
  "${PREFIX}/packages/pve-integration/uninstall.sh" || true
else
  info "pve-integration uninstaller not found (skipping)"
fi

# 3. Remove the systemd unit files and reload.
removed_unit=0
for u in anasd anas; do
  if [ -f "${SYSTEMD_DIR}/${u}.service" ]; then
    rm -f "${SYSTEMD_DIR}/${u}.service"
    removed_unit=1
  fi
done
if [ "${removed_unit}" -eq 1 ]; then
  info "removed systemd unit files"
fi
systemctl daemon-reload >/dev/null 2>&1 || true

# 4. Remove the install prefix.
if [ -d "${PREFIX}" ]; then
  info "removing ${PREFIX}"
  rm -rf "${PREFIX}"
else
  info "${PREFIX} not present (nothing to remove)"
fi

echo
log "ANAS uninstalled."

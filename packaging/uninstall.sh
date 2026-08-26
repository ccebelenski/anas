#!/usr/bin/env bash
#
# Remove ANAS from a Proxmox VE node. Idempotent — safe to run repeatedly and
# safe to run on a partially-installed node.
#
set -euo pipefail

PREFIX="${PREFIX:-/opt/anas}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
ANAS_ENV_FILE="${ANAS_ENV_FILE:-/etc/default/anas}"

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

# 3a. Remove the iSCSI boot-ordering drop-in install.sh added beside
# rtslib-fb-targetctl.service. This is the ONLY iSCSI thing an uninstall touches.
#
# Deliberately NOT removed, ever:
#   * targetcli-fb / python3-rtslib-fb — dependencies, like samba and mdadm.
#     Removing a package the node may be using for something else is not a
#     guest's call, and python3-rtslib-fb's removal would take the boot restore
#     service with it.
#   * /etc/rtslib-fb-target/saveconfig.json and its backup/ rotation — that file
#     IS the node's iSCSI configuration: every target, every LUN, and above all
#     every LUN's unit serial, which is what initiators, ESXi, Windows and PVE's
#     own volids identify the disk by. Deleting it would silently change the
#     identity of every disk this node serves. It is data, and it stays.
#   * the live LIO configuration in configfs — the targets keep serving.
ISCSI_DROPIN_DIR="${ISCSI_DROPIN_DIR:-rtslib-fb-targetctl.service.d}"
ISCSI_DROPIN_FILE="${ISCSI_DROPIN_FILE:-anas-ordering.conf}"
if [ -f "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}" ]; then
  rm -f "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}"
  # Only if empty — another drop-in in that directory is not ours to remove.
  rmdir "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}" >/dev/null 2>&1 || true
  info "removed the iSCSI ordering drop-in (targetcli-fb, python3-rtslib-fb and the saved LIO configuration are left alone)"
fi

systemctl daemon-reload >/dev/null 2>&1 || true

# 3b. Remove the mdadm md-event hook installed by install.sh. (Any PROGRAM
# line in mdadm.conf is the daemon's surgical edit, reverted at pool teardown —
# not touched here.)
HOOK_DEST="${HOOK_DEST:-/usr/local/bin/anas-md-event}"
if [ -f "${HOOK_DEST}" ]; then
  rm -f "${HOOK_DEST}"
  info "removed md-event hook ${HOOK_DEST}"
fi

# 3c. Remove the ANAS notification templates install.sh drops into pve-manager's
# template dir. Only our own anas-named files are touched — never any other
# template in that shared directory (guest philosophy).
PVE_TEMPLATE_DIR="${PVE_TEMPLATE_DIR:-/usr/share/pve-manager/templates/default}"
removed_template=0
for tpl in anas-ahr-subject.txt.hbs anas-ahr-body.txt.hbs \
           anas-backup-subject.txt.hbs anas-backup-body.txt.hbs \
           anas-snapshot-subject.txt.hbs anas-snapshot-body.txt.hbs \
           anas-replication-subject.txt.hbs anas-replication-body.txt.hbs; do
  if [ -f "${PVE_TEMPLATE_DIR}/${tpl}" ]; then
    rm -f "${PVE_TEMPLATE_DIR}/${tpl}"
    removed_template=1
  fi
done
if [ "${removed_template}" -eq 1 ]; then
  info "removed ANAS notification templates from ${PVE_TEMPLATE_DIR}"
fi

# 3d. Remove the ANAS-owned gateway env file (issue #2). ANAS-owned, so it is
# safe to delete outright (unlike the surgical edits above).
if [ -f "${ANAS_ENV_FILE}" ]; then
  rm -f "${ANAS_ENV_FILE}"
  info "removed ${ANAS_ENV_FILE}"
fi

# 4. Remove the install prefix.
if [ -d "${PREFIX}" ]; then
  info "removing ${PREFIX}"
  rm -rf "${PREFIX}"
else
  info "${PREFIX} not present (nothing to remove)"
fi

echo
log "ANAS uninstalled."

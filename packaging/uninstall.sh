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
# Something the operator has to act on, but not a failed uninstall.
warn() { printf '    !! %s\n' "$*" >&2; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }

# Where systemd keeps a Persistent timer's last-fire stamp. The scrub timer's
# stamp is removed with the units so a later ANAS reinstall does not catch up a
# months-old missed occurrence (review R10).
TIMERS_STAMP_DIR="${TIMERS_STAMP_DIR:-/var/lib/systemd/timers}"

# Remove the ANAS SCHEDULE units (review F2/F8). ONE rule for all four unit
# families — `anas-snap-*`, `anas-backup-*`, `anas-repl-*`, `anas-scrub.*` —
# and one reason for it: every family's runner lives in /opt/anas, which this
# uninstall is deleting. A systemd timer left behind keeps firing a runner that
# no longer exists, month after month; a lost schedule is the honest outcome of
# uninstalling, a broken one is not. Each family's timers are disabled --now,
# its unit files and Persistent stamps removed, and one line names the family
# and the count.
#
# mdcheck IS re-enabled (ruling 2026-09-14, reversing review F2): a node left
# with no parity check at all is not helping or guarding, and mdadm's
# `mdcheck_start`/`mdcheck_continue` timers are ENABLED BY DEFAULT on a stock
# node (SCHEDULES-GROUND-TRUTH). Turning them back on is not a guess about what
# this node had before ANAS — it is restoring the distro default, which is what
# a guest leaves behind. The printed line says that is what happened, and how
# to turn them off again (spindown operators run without a periodic check on
# purpose).
#
# Idempotent: every step is guarded, a partially-uninstalled node is fine.
remove_schedule_units() {
  local family f svc count
  for family in anas-snap anas-backup anas-repl; do
    count=0
    for f in "${SYSTEMD_DIR}"/${family}-*.service; do
      [ -e "${f}" ] || continue
      svc="${f##*/}"; svc="${svc%.service}"
      systemctl disable --now "${svc}.timer" >/dev/null 2>&1 || true
      rm -f "${SYSTEMD_DIR}/${svc}.service" "${SYSTEMD_DIR}/${svc}.timer"
      rm -f "${TIMERS_STAMP_DIR}/stamp-${svc}.timer"
      count=$((count + 1))
    done
    if [ "${count}" -gt 0 ]; then
      info "removed ${count} ANAS schedule unit pair(s) (${family}-*)"
    fi
  done

  if [ -f "${SYSTEMD_DIR}/anas-scrub.timer" ] || [ -f "${SYSTEMD_DIR}/anas-scrub.service" ]; then
    systemctl disable --now anas-scrub.timer >/dev/null 2>&1 || true
    rm -f "${SYSTEMD_DIR}/anas-scrub.timer" "${SYSTEMD_DIR}/anas-scrub.service"
    rm -f "${TIMERS_STAMP_DIR}/stamp-anas-scrub.timer"
    info "removed 1 ANAS schedule unit pair (anas-scrub.*)"
    # The node goes back to stock (ruling 2026-09-14): ANAS disabled mdadm's
    # timers when the periodic scrub was enabled, and the distro default is
    # that they are ON. Best-effort — a node without the mdcheck units (they
    # ship with mdadm, but a minimal install may not have them), or one where
    # they have been masked, costs the re-enable and nothing else.
    #
    # REPORT WHAT ACTUALLY HAPPENED (sixth pass, N7). The line used to print
    # "has been RESTORED" unconditionally, after a call ending in `|| true` —
    # so a masked or missing unit left the node with NO periodic md parity
    # check at all while the uninstaller said the opposite. That is the one
    # sentence an operator would act on, and it has to be true.
    if systemctl enable --now mdcheck_start.timer mdcheck_continue.timer >/dev/null 2>&1; then
      info "ANAS periodic scrub removed. mdadm's own parity check (mdcheck_start.timer, mdcheck_continue.timer) is the distro default. ANAS disabled it when the scrub was enabled, and it has been RESTORED;"
      info "run \`systemctl disable --now mdcheck_start.timer mdcheck_continue.timer\` if you do not want a periodic md parity check on this node."
    else
      warn "ANAS periodic scrub removed, but mdadm's own parity check (mdcheck_start.timer, mdcheck_continue.timer) could not be re-enabled (masked or not installed). The node is left with no periodic md parity check."
      warn "Run \`systemctl enable --now mdcheck_start.timer mdcheck_continue.timer\` by hand, or arrange a parity check another way."
    fi
  fi
}

# Remove the recycle-bin age-based cleanup timer + service (smbsvc.2). ONE
# static pair (enabled by install.sh) — the runner reads each share's deletion
# age from its smb.conf marker, so there are no per-share units to sweep.
#
# Deliberately NOT touched, ever: the `#recycle` directories themselves, and
# the `recycle:*` keys / markers in smb.conf. A checkbox never deletes data —
# the bins are real files a user may still want, and an uninstall that emptied
# them would be an owner's move, not a guest's. Shares keep their (now
# unswept) bins; if smbd is still serving them, the module keeps working.
remove_recycle_units() {
  if [ ! -f "${SYSTEMD_DIR}/anas-recycle.timer" ] && [ ! -f "${SYSTEMD_DIR}/anas-recycle.service" ]; then
    return 0
  fi
  systemctl disable --now anas-recycle.timer >/dev/null 2>&1 || true
  rm -f "${SYSTEMD_DIR}/anas-recycle.timer" "${SYSTEMD_DIR}/anas-recycle.service"
  rm -f "${TIMERS_STAMP_DIR}/stamp-anas-recycle.timer"
  info "removed 1 ANAS schedule unit pair (anas-recycle.*); every #recycle directory and its contents are left in place"
}

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

# ANAS_UNINSTALL_LIB_ONLY lets the test harness source this file to exercise
# remove_schedule_units against a throwaway SYSTEMD_DIR with a faked systemctl —
# the install.sh lib-mode pattern, no root, no real node.
if [ "${ANAS_UNINSTALL_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || true
fi

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  err "must run as root (EUID 0). Try: sudo ./uninstall.sh"
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

# 3a. Remove the ANAS schedule units (periodic scrub + the snapshot/backup/
# replication schedules) — all four families, and mdcheck restored to the
# distro default when the scrub timer was one of them.
# See the function above (review F2/F8).
remove_schedule_units

# 3a'. Remove the recycle-bin cleanup timer + service (smbsvc.2) — never any
# `#recycle` contents (see remove_recycle_units above).
remove_recycle_units

# 3b. Remove the iSCSI boot-ordering drop-in install.sh added beside
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

# 3c. Remove the mdadm md-event hook installed by install.sh. (Any PROGRAM
# line in mdadm.conf is the daemon's surgical edit, reverted at pool teardown —
# not touched here.)
HOOK_DEST="${HOOK_DEST:-/usr/local/bin/anas-md-event}"
if [ -f "${HOOK_DEST}" ]; then
  rm -f "${HOOK_DEST}"
  info "removed md-event hook ${HOOK_DEST}"
fi

# 3c2. Remove the AHR read-cache removal hook and its udev rule (ahrcache.1
# slice 2). Both are ANAS's own files, named by ANAS, in the drop-in directory
# udev provides for exactly this — nothing else in /etc/udev/rules.d is read or
# touched (guest philosophy). Any `<pool>-cacheN` slice still on a disk stays
# where it is: that is the operator's data layout, and Detach cache is the verb
# that removes it.
CACHE_HOOK_DEST="${CACHE_HOOK_DEST:-/usr/local/bin/anas-cache-event}"
UDEV_RULES_DIR="${UDEV_RULES_DIR:-/etc/udev/rules.d}"
CACHE_RULE_DEST="${CACHE_RULE_DEST:-${UDEV_RULES_DIR}/99-anas-cache.rules}"
removed_cache_udev=0
if [ -f "${CACHE_HOOK_DEST}" ]; then
  rm -f "${CACHE_HOOK_DEST}"
  removed_cache_udev=1
fi
if [ -f "${CACHE_RULE_DEST}" ]; then
  rm -f "${CACHE_RULE_DEST}"
  removed_cache_udev=1
fi
if [ "${removed_cache_udev}" -eq 1 ]; then
  udevadm control --reload-rules >/dev/null 2>&1 || true
  info "removed AHR cache-event hook ${CACHE_HOOK_DEST} and ${CACHE_RULE_DEST}"
fi

# 3d. Remove the ANAS notification templates install.sh drops into pve-manager's
# template dir. Only our own anas-named files are touched — never any other
# template in that shared directory (guest philosophy).
PVE_TEMPLATE_DIR="${PVE_TEMPLATE_DIR:-/usr/share/pve-manager/templates/default}"
removed_template=0
for tpl in anas-ahr-subject.txt.hbs anas-ahr-body.txt.hbs \
           anas-backup-subject.txt.hbs anas-backup-body.txt.hbs \
           anas-snapshot-subject.txt.hbs anas-snapshot-body.txt.hbs \
           anas-replication-subject.txt.hbs anas-replication-body.txt.hbs \
           anas-cloud-subject.txt.hbs anas-cloud-body.txt.hbs; do
  if [ -f "${PVE_TEMPLATE_DIR}/${tpl}" ]; then
    rm -f "${PVE_TEMPLATE_DIR}/${tpl}"
    removed_template=1
  fi
done
if [ "${removed_template}" -eq 1 ]; then
  info "removed ANAS notification templates from ${PVE_TEMPLATE_DIR}"
fi

# 3e. Remove the ANAS-owned gateway env file (issue #2). ANAS-owned, so it is
# safe to delete outright (unlike the surgical edits above).
if [ -f "${ANAS_ENV_FILE}" ]; then
  rm -f "${ANAS_ENV_FILE}"
  info "removed ${ANAS_ENV_FILE}"
fi

# 3f. Deliberately NOT removed, ever (stated so a later reader does not add the
# removal): the rclone package, and /etc/anas/rclone.conf alongside the rest of
# /etc/anas (creds/, ahr/) — the same treatment as /etc/anas/creds. rclone is a
# dependency like samba and mdadm (the node may be using it for something
# else), and the config store is ANAS's DATA — every cloud remote and its
# credentials. Deleting it would be an owner's move, not a guest's; a reinstall
# picks the store straight back up.

# 4. Remove the install prefix.
if [ -d "${PREFIX}" ]; then
  info "removing ${PREFIX}"
  rm -rf "${PREFIX}"
else
  info "${PREFIX} not present (nothing to remove)"
fi

echo
log "ANAS uninstalled."

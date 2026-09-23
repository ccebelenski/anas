#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# smbsvc.1 live-proof fixture — disposable state on the stunt node, never a
# new pool (the Previous Versions dataset is a child of the node's existing
# `gtbackup` pool; nothing here touches its siblings cdm/img2).
#
# Builds:
#   gtbackup/pvshare  a ZFS dataset carrying report.txt with one content
#                     version per snapshot:
#                       v1  @anas-daily-2026-09-20T100000Z   (schedule-shaped)
#                       v2  @anas-hourly-2026-09-22T110000Z  (schedule-shaped)
#                           @keep-me                          (manual)
#                       v3  live (current)
#                     The two schedule-shaped names match the daemon's
#                     `shadow:format` for their buckets exactly, so
#                     vfs_shadow_copy2 must enumerate ONLY the hourly one.
#
# AHR half (loop-device AHR pool): NOT BUILT — a loop device has no
# /dev/disk/by-id entry, and the daemon addresses AHR create disks exclusively
# by by-id (shared DiskId), so a loop AHR pool cannot be created through the
# daemon's own API. The spec skips the AHR half with this reason.
#
# The fixture assumes a running node: after a reboot gtbackup is not
# auto-imported — restore the baseline snapshot instead. `down` also removes a
# [pvshare] stanza a crashed spec run may have leaked into smb.conf.

FIXDIR="/var/tmp/smbsvc-fixture"
DS="gtbackup/pvshare"
DS_PATH="/gtbackup/pvshare"
FILE="report.txt"
SHARE="pvshare"

usage() {
  echo "Usage: smbsvc-fixture.sh <up|down|status>"
  echo "  up      Build the fixture (idempotent)"
  echo "  down    Tear it down (idempotent; silent when nothing exists)"
  echo "  status  Dataset, snapshots, and the live file content"
  exit 1
}

[ $# -eq 1 ] || usage

ds_exists() { $SSH_CMD "zfs list -H ${DS}" >/dev/null 2>&1; }

# Best-effort surgical removal of a leaked [pvshare] stanza (a crashed spec
# run), then reload smbd. Never fails the down.
remove_leaked_share() {
  $SSH_CMD "python3 -c \"import re; p='/etc/samba/smb.conf'; s=open(p).read(); s2=re.sub(r'(?ms)^\\\\[${SHARE}\\\\].*?(?=^\\\\[|\\\\Z)','',s); open(p,'w').write(s2) if s2 != s else None\" && systemctl reload smbd 2>/dev/null || true" >/dev/null 2>&1 || true
}

status() {
  if ds_exists; then
    echo "--- zfs list ${DS} ---"
    $SSH_CMD "zfs list -o name,mountpoint ${DS}"
    echo
    echo "--- snapshots ---"
    $SSH_CMD "zfs list -H -o name -t snapshot -d 1 ${DS} | sort"
    echo
    echo "--- live content ---"
    $SSH_CMD "cat ${DS_PATH}/${FILE}"
    echo
    echo "--- v2 through the hourly snapshot ---"
    $SSH_CMD "cat ${DS_PATH}/.zfs/snapshot/anas-hourly-2026-09-22T110000Z/${FILE}"
  else
    echo "no fixture dataset (${DS})"
  fi
}

case "$1" in
  up)
    echo "=== smbsvc.1 fixture — up ==="

    $SSH_CMD "zpool list -H gtbackup" >/dev/null 2>&1 \
      || { echo "ERROR: pool gtbackup not present — restore the baseline snapshot" >&2; exit 1; }

    if ds_exists; then
      echo "✓ ${DS} already exists (skipping — 'down' first for a rebuild)"
    else
      $SSH_CMD "zfs create ${DS}"
      # v1 lands, is snapshotted daily; the change to v2 is snapshotted
      # hourly; a manual snapshot rides along; v3 stays live.
      $SSH_CMD "echo 'pv report v1' > ${DS_PATH}/${FILE} && chmod 644 ${DS_PATH}/${FILE} && sync"
      $SSH_CMD "zfs snapshot ${DS}@anas-daily-2026-09-20T100000Z"
      $SSH_CMD "echo 'pv report v2' > ${DS_PATH}/${FILE} && sync"
      $SSH_CMD "zfs snapshot ${DS}@anas-hourly-2026-09-22T110000Z"
      $SSH_CMD "zfs snapshot ${DS}@keep-me"
      $SSH_CMD "echo 'pv report v3' > ${DS_PATH}/${FILE} && sync"
      echo "✓ ${DS} created (v1/v2 snapshots + keep-me, live v3)"
    fi

    echo
    echo "=== Fixture ready ==="
    status
    ;;

  down)
    # A leaked share stanza first (the spec normally removes it through the API)
    remove_leaked_share
    if $SSH_CMD "grep -q '^\\[${SHARE}\\]' /etc/samba/smb.conf" 2>/dev/null; then
      echo "⚠ [${SHARE}] stanza still in smb.conf — remove it by hand"
    fi
    if ds_exists; then
      $SSH_CMD "zfs destroy -r ${DS}"
      echo "✓ ${DS} destroyed (with its snapshots)"
    fi
    if $SSH_CMD "test -d ${FIXDIR}"; then
      $SSH_CMD "rm -rf ${FIXDIR}"
      echo "✓ ${FIXDIR} removed"
    fi
    ;;

  status)
    status
    ;;

  *)
    usage
    ;;
esac

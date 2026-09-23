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
# AHR half: real DISKS, not a loop device — a loop device has no
# /dev/disk/by-id entry and the daemon addresses AHR create disks exclusively
# by by-id (shared DiskId). `ahr-up` attaches two ~1 GiB virtual SCSI disks
# (indices 7 and 8, serial ANAS_HOT7/ANAS_HOT8; 1–6 are left alone — other
# tests use them) and waits for their by-id links on the node. The POOL itself
# is NOT built here: creating it any way but the daemon's own API would dodge
# the code under proof — the spec creates (and destroys) `ahrpv` through
# /v1/ahr. `ahr-down` is the safety net: best-effort teardown of any ahrpv
# remnants (mounts, fstab lines, LVM/md, leaked stanzas) and detach of both
# disks. Separate verbs, NOT folded into up/down: `up` runs in the spec's
# beforeEach self-heal for EVERY test, and the AHR disks are only the AHR
# test's business.
#
# The fixture assumes a running node: after a reboot gtbackup is not
# auto-imported — restore the baseline snapshot instead. `down` also removes a
# [pvshare] stanza a crashed spec run may have leaked into smb.conf.

FIXDIR="/var/tmp/smbsvc-fixture"
DS="gtbackup/pvshare"
DS_PATH="/gtbackup/pvshare"
FILE="report.txt"
SHARE="pvshare"

# The AHR half's disks and pool — keep in step with the spec's AHR test.
AHR_DISKS=(7 8)
AHR_POOL="ahrpv"

ahr_by_id() { echo "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT$1"; }

usage() {
  echo "Usage: smbsvc-fixture.sh <up|down|ahr-up|ahr-down|status>"
  echo "  up        Build the ZFS fixture (idempotent)"
  echo "  down      Tear it down (idempotent; silent when nothing exists)"
  echo "  ahr-up    Attach the two AHR hot disks (${AHR_DISKS[0]}+${AHR_DISKS[1]}, 1024 MB each) and wait for their by-id links"
  echo "            (the ahrpv pool itself is created by the spec through the daemon's own API)"
  echo "  ahr-down  Best-effort ahrpv teardown (mounts, fstab, LVM/md, stanzas) + detach both disks"
  echo "  status    Dataset, snapshots, and the live file content"
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

# Wait (bounded) for one disk's by-id link to appear ON THE NODE — attach is
# live hotplug, and udev needs a moment to name it.
wait_for_by_id() {
  local id="$1" n
  $SSH_CMD "udevadm settle" >/dev/null 2>&1 || true
  for n in $(seq 1 30); do
    if $SSH_CMD "test -e /dev/disk/by-id/${id}"; then
      echo "✓ /dev/disk/by-id/${id} present"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: /dev/disk/by-id/${id} never appeared on the node" >&2
  return 1
}

# Attach one AHR hot disk and wait for its by-id link.
ahr_attach() {
  local n="$1"
  "$SCRIPT_DIR/add-disk.sh" --size 1024 "$n"
  wait_for_by_id "$(ahr_by_id "$n")"
}

# Best-effort teardown of an ahrpv pool on the node — the state a crashed spec
# run (or a destroy that predates the snapshots-mount fix) can leave behind:
# both mounts, both fstab lines, the LVM/md stack, member superblocks, GPTs.
# Every step tolerates absence; the destroy THROUGH THE API is the normal path
# and leaves nothing for this to do.
ahr_teardown_pool() {
  # The by-id names are expanded HOST-side (one line — a multi-line command
  # substitution inside the heredoc would break the remote `for`).
  local ids
  ids=$(for n in "${AHR_DISKS[@]}"; do ahr_by_id "$n"; done | tr '\n' ' ')
  $SSH_CMD "bash -s" <<REMOTE || true
umount /mnt/anas-ahr/${AHR_POOL} 2>/dev/null || true
umount /mnt/anas-ahr-snapshots/${AHR_POOL} 2>/dev/null || true
if vgs ${AHR_POOL} >/dev/null 2>&1; then
  lvremove -ff -y ${AHR_POOL}/${AHR_POOL}-vol 2>/dev/null || true
  vgremove -ff -y ${AHR_POOL} 2>/dev/null || true
fi
for md in /dev/md/${AHR_POOL}-*; do mdadm --stop "\$md" 2>/dev/null || true; done
for d in ${ids}; do
  for p in /dev/disk/by-id/\$d-part*; do
    [ -e "\$p" ] && mdadm --zero-superblock "\$p" 2>/dev/null || true
  done
  [ -e /dev/disk/by-id/\$d ] && sgdisk --zap-all /dev/disk/by-id/\$d 2>/dev/null || true
done
if grep -qE 'anas-ahr(-snapshots)?/${AHR_POOL}[^a-z-]' /etc/fstab 2>/dev/null; then
  sed -i -E '\#anas-ahr(-snapshots)?/${AHR_POOL}#d' /etc/fstab
  systemctl daemon-reload
fi
REMOTE
}

# Best-effort removal of leaked [ahrpv…] share stanzas (a crashed spec run),
# then reload smbd. Never fails the down.
remove_leaked_ahr_shares() {
  $SSH_CMD "python3 -c \"import re; p='/etc/samba/smb.conf'; s=open(p).read(); s2=re.sub(r'(?ms)^\\\\[ahrpv[^\\\\]]*\\\\].*?(?=^\\\\[|\\\\Z)','',s); open(p,'w').write(s2) if s2 != s else None\" && systemctl reload smbd 2>/dev/null || true" >/dev/null 2>&1 || true
}

# Detach the AHR disks (only when attached — virsh detach-disk errors otherwise).
ahr_detach_disks() {
  local n
  for n in "${AHR_DISKS[@]}"; do
    if sudo virsh domblklist "$VM_NAME" 2>/dev/null | grep -qF "${STORAGE_PATH}/${VM_NAME}-hot${n}.qcow2"; then
      "$SCRIPT_DIR/remove-disk.sh" "$n"
    else
      echo "✓ hot${n} not attached (skipping)"
    fi
  done
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

  ahr-up)
    echo "=== smbsvc.1 fixture — ahr-up (AHR hot disks) ==="
    for n in "${AHR_DISKS[@]}"; do
      ahr_attach "$n"
    done
    echo
    echo "=== AHR disks ready (pool 'ahrpv' is the spec's business, via POST /v1/ahr) ==="
    ;;

  ahr-down)
    echo "=== smbsvc.1 fixture — ahr-down (AHR half) ==="
    remove_leaked_ahr_shares
    ahr_teardown_pool
    ahr_detach_disks
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

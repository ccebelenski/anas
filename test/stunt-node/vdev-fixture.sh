#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# vdevs.1 / vdevs.2 live-proof fixture — disposable state on the stunt node
# (GitHub #66).
#
# Builds:
#   gtvdev  a throwaway pool carrying all SIX vdev classes, one partition each,
#           on the hot disk 9 (serial ANAS_HOT9, by-id
#           scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9, kernel /dev/sdk):
#             <D>1 data   <D>2 log       <D>3 cache
#             <D>4 spare  <D>5 special   <D>6 dedup
#           The pool is built BY CLI on purpose: this story proves the DISPLAY
#           side (the zpool-status parser over the pool-level logs/l2cache/
#           spares/special/dedup sections), not the composer. Disks 1-8,
#           gtbackup and gtiscsi are never touched.
#
# Three shapes of the same pool, one verb each — all six leaves always live on
# the SAME disk, which is the point of the by-id shape:
#   up        leaves named by KERNEL device (/dev/sdX1 …). `zpool status` then
#             carries no by-id anywhere.
#   up-byid   the same six classes created from /dev/disk/by-id/<id>-partN, so
#             every leaf is a by-id PARTITION. The whole-disk identity the
#             parser derives (the `-partN` stripped) is then the SAME string
#             for all six — the #66 split-SSD shape in the pool-level sections
#             (log and cache on one SSD), where every leaf token is unambiguous
#             exactly because it keeps `-partN`. What no capture carried when
#             the zoo was built is the split disk INSIDE a mirror — a mirror
#             leaf named by-id-partN — which is what
#             zpool-status-mirrored-log-partitions-2.4.4.json now holds for the
#             log section and what no data-tree capture holds yet.
#   up-multi  one data leaf, TWO cache leaves and TWO spares (by-id), the shape
#             that proves a pool-level section holding more than one bare leaf.
#
# Three more shapes for the topology zoo (topology.1 — the story's still-missing
# captures; test/stunt-node/topology-zoo.sh drives them and lands the files):
#   up-file       FILE vdevs on sparse files under /gtbackup/anas-topology-zoo:
#                 a file data root PLUS file-backed log, cache and spare
#                 sections in one pool — the vdev_type:"file" shapes in the
#                 tree and beside it.
#   up-mirrorlog  a FILE data root plus a MIRRORED log (two partitions) and a
#                 bare disk cache — the shape
#                 zpool-status-mirrored-log-partitions-2.4.4.json pins, with
#                 by-id partition leaves where the committed capture is
#                 kernel-named.
#   up-byid-whole a pool on the WHOLE disk by-id (no partitions) — the most
#                 common production layout, leaves named by-id without -partN.
#   up-suspended  a pool on a dm-linear device over a file under the same
#                 directory, whose table is then swapped to dm-error so every
#                 I/O fails and the pool SUSPENDS. WHY NOT "rm the backing
#                 file": ZFS holds the file OPEN, so unlinking it fails
#                 nothing — the pool keeps running on the unlinked inode.
#                 A dm table swap fails the I/O at the kernel boundary,
#                 deterministically, the way the yanked-disk capture of story
#                 3.16 did. Recovery in `down`: restore the linear table,
#                 `zpool clear` (the pool comes back and can be destroyed
#                 cleanly); `zpool destroy -f` after the table is restored is
#                 the FAILURE fallback (the pool will not clear), never a hang
#                 cure — every zpool call this shape WAITS ON runs under
#                 `timeout 60`, so a wedged command fails the verb loudly
#                 instead of hanging the run. The forcing scrub is the
#                 exception: it blocks in uninterruptible D state on a pool
#                 that suspends under it, where no signal lands, so it is
#                 launched detached and never waited on.
#
# STATED RISKS of the file-backed shapes, accepted until the first run retires
# them: they stack ZFS on ZFS (file vdevs live on the gtbackup dataset) and are
# short-lived by design — display-side fixtures, torn down at once; whether
# `zpool create` accepts a FILE as a log/cache/spare section member is
# unverified, and the verbs fail loudly if it refuses; loop-device truncation
# WOULD fail I/O on its own (EIO past EOF), and dm-error is chosen anyway
# because it is deterministic.
#
# EVERY `bash -s` heredoc below opens with an UNQUOTED delimiter (<<REMOTE) so
# the local ${VAR}s interpolate into the remote script. That also means a
# BACKTICK or an unescaped $( ) anywhere inside — including in a comment — runs
# as a command substitution ON THIS HOST and lands its output in the script that
# is sent. Comments in these blocks quote with 'single quotes', never backticks.
#
# `down` is the safety net for ALL SEVEN: restore the suspended shape's dm
# table if present, destroy gtvdev if present, wipe disk 9 (labels + GPT),
# detach it, sweep the file-vdev directory. Every verb is idempotent.

POOL="gtvdev"
DISK_NUM=9
BY_ID="scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT${DISK_NUM}"
IMAGE="${STORAGE_PATH}/${VM_NAME}-hot${DISK_NUM}.qcow2"
# The file-backed shapes live under the gtbackup MOUNTPOINT in their own
# directory — never among gtbackup's data, and never on disks 1-6.
FILES_DIR="/gtbackup/anas-topology-zoo"
DM_NAME="gtzoosusp"

usage() {
  echo "Usage: vdev-fixture.sh <up|up-byid|up-multi|up-file|up-mirrorlog|up-byid-whole|up-suspended|down|status>"
  echo "  up             Attach disk ${DISK_NUM} (2048 MB), partition it into six, create pool ${POOL} from KERNEL names (idempotent)"
  echo "  up-byid        The same six classes, created from /dev/disk/by-id/<id>-partN (idempotent)"
  echo "  up-multi       data + TWO cache leaves + TWO spares, by-id (idempotent)"
  echo "  up-file        File vdevs on sparse files under ${FILES_DIR} (idempotent)"
  echo "  up-mirrorlog   File data root + MIRRORED log on two partitions + a disk cache (idempotent)"
  echo "  up-byid-whole  A pool on the whole disk by-id, no partitions (idempotent)"
  echo "  up-suspended   A pool on a dm-linear device over a file, table swapped to dm-error so the pool suspends (idempotent)"
  echo "  down           Destroy ${POOL} if present, restore/sweep the file shapes, wipe disk ${DISK_NUM}, detach it (idempotent)"
  echo "  status         The pool's zpool status + the disk's by-id links"
  exit 1
}

[ $# -eq 1 ] || usage

pool_exists() { $SSH_CMD "timeout 60 zpool list -H ${POOL}" >/dev/null 2>&1; }

# Wait (bounded) for the disk's by-id link to appear ON THE NODE — attach is
# live hotplug, and udev needs a moment to name it.
wait_for_by_id() {
  local n
  $SSH_CMD "udevadm settle" >/dev/null 2>&1 || true
  for n in $(seq 1 30); do
    if $SSH_CMD "test -e /dev/disk/by-id/${BY_ID}"; then
      echo "✓ /dev/disk/by-id/${BY_ID} present"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: /dev/disk/by-id/${BY_ID} never appeared on the node" >&2
  return 1
}

# Detach disk 9 (only when attached — virsh detach-disk errors otherwise).
detach_disk() {
  if sudo virsh domblklist "$VM_NAME" 2>/dev/null | grep -qF "$IMAGE"; then
    "$SCRIPT_DIR/remove-disk.sh" "$DISK_NUM"
  else
    echo "✓ hot${DISK_NUM} not attached (skipping)"
  fi
}

status() {
  if pool_exists; then
    echo "--- zpool status ${POOL} ---"
    # Bounded like every other zpool call on these shapes: status() is what
    # runs straight after up-suspended.
    $SSH_CMD "timeout 60 zpool status ${POOL}"
    echo
    echo "--- by-id links ---"
    $SSH_CMD "ls -l /dev/disk/by-id/ | grep '${BY_ID#scsi-0QEMU_QEMU_HARDDISK_}'" || true
  else
    echo "no fixture pool (${POOL})"
  fi
}

# up-file — file vdevs on sparse files under ${FILES_DIR}. The files must exist
# before `zpool create` names them (ZFS does not create missing file vdevs).
up_file() {
  echo "=== topology.1 fixture — up-file (file vdevs) ==="
  if pool_exists; then
    echo "✓ ${POOL} already exists (skipping — 'down' first for a rebuild)"
    return
  fi
  $SSH_CMD "bash -s" <<REMOTE
set -euo pipefail
# MOUNTED, not merely present: an unmounted /gtbackup leaves an empty
# mountpoint directory the files would land on, outside any pool.
mountpoint -q /gtbackup || {
  echo "ERROR: /gtbackup is not mounted — the file-vdev shapes need it" >&2
  exit 1
}
mkdir -p ${FILES_DIR}
truncate -s 1G   ${FILES_DIR}/data0.img
truncate -s 256M ${FILES_DIR}/log0.img
truncate -s 256M ${FILES_DIR}/cache0.img
truncate -s 256M ${FILES_DIR}/spare0.img
zpool create -f ${POOL} \\
  "${FILES_DIR}/data0.img" \\
  log "${FILES_DIR}/log0.img" \\
  cache "${FILES_DIR}/cache0.img" \\
  spare "${FILES_DIR}/spare0.img"
REMOTE
  echo "✓ ${POOL} created (file data root + file log/cache/spare sections under ${FILES_DIR})"
}

# up-mirrorlog — the mirrored-log-partitions shape: a FILE data root, a log
# MIRROR of two partitions, a bare disk cache. The committed capture
# zpool-status-mirrored-log-partitions-2.4.4.json holds this shape on gtbackup
# (file root /var/tmp/gtbackup.img, mirror-4 of sdb1+sdb2, cache sdb3); the
# re-capture lands the same STRUCTURE with by-id partition leaves — the zoo's
# leaf form — so the leaf naming differs from that file on purpose.
up_mirrorlog() {
  echo "=== topology.1 fixture — up-mirrorlog (file root, mirrored log, disk cache) ==="

  "$SCRIPT_DIR/add-disk.sh" --size 2048 "$DISK_NUM"
  wait_for_by_id

  if pool_exists; then
    echo "✓ ${POOL} already exists (skipping — 'down' first for a rebuild)"
    return
  fi
  $SSH_CMD "bash -s" <<REMOTE
set -euo pipefail
mountpoint -q /gtbackup || {
  echo "ERROR: /gtbackup is not mounted — the mirrored-log shape needs it" >&2
  exit 1
}
mkdir -p ${FILES_DIR}
truncate -s 1G ${FILES_DIR}/data0.img
D=\$(readlink -f /dev/disk/by-id/${BY_ID})
sgdisk -Z "\$D"
sgdisk -n1:0:+200M -n2:0:+200M -n3:0:+400M "\$D"
udevadm settle
P="/dev/disk/by-id/${BY_ID}"
zpool create -f ${POOL} "${FILES_DIR}/data0.img" log mirror "\${P}-part1" "\${P}-part2" cache "\${P}-part3"
REMOTE
  echo "✓ ${POOL} created (file data root + mirrored log on two partitions of ${BY_ID} + a disk cache)"
}

# up-byid-whole — the whole disk by-id, no partitions. Its own remote block,
# deliberately NOT create_pool: the shape is the WHOLE disk, so there is no
# six-partition cut — zap the stale table, settle, create, nothing else.
up_byid_whole() {
  echo "=== topology.1 fixture — up-byid-whole (whole disk by-id) ==="

  "$SCRIPT_DIR/add-disk.sh" --size 2048 "$DISK_NUM"
  wait_for_by_id

  if pool_exists; then
    echo "✓ ${POOL} already exists (skipping — 'down' first for a rebuild)"
  else
    $SSH_CMD "bash -s" <<REMOTE
set -euo pipefail
sgdisk -Z "\$(readlink -f /dev/disk/by-id/${BY_ID})"
udevadm settle
zpool create -f ${POOL} "/dev/disk/by-id/${BY_ID}"
REMOTE
    echo "✓ ${POOL} created (whole disk ${BY_ID}, no partitions)"
  fi
}

# up-suspended — a pool on a dm-linear device over a file; the table is then
# swapped to dm-error so EVERY I/O fails and the pool suspends (failmode wait).
# See the header comment for why the backing file is not simply removed, and
# for the stated risks of the file-backed shapes. Every zpool call this verb
# WAITS ON runs under `timeout 60`, so a wedged command fails the verb loudly
# (exit 124) instead of hanging the capture run. The one call that cannot be
# bounded — and so is never waited on — is the forcing scrub; see the comment
# at the scrub itself.
up_suspended() {
  echo "=== topology.1 fixture — up-suspended (dm-error suspension) ==="
  if pool_exists; then
    echo "✓ ${POOL} already exists (skipping — 'down' first for a rebuild)"
    return
  fi
  $SSH_CMD "bash -s" <<REMOTE
set -euo pipefail
mountpoint -q /gtbackup || {
  echo "ERROR: /gtbackup is not mounted — the suspended shape needs it" >&2
  exit 1
}
# An aborted earlier run must not wedge this one: release any leaked dm device
# and any loop still holding the backing file BEFORE recreating them.
dmsetup remove ${DM_NAME} 2>/dev/null || true
LOOP_LEAK=\$(losetup -a | grep '${FILES_DIR}/susp.img' | cut -d: -f1 || true)
[ -n "\$LOOP_LEAK" ] && losetup -d "\$LOOP_LEAK" || true
mkdir -p ${FILES_DIR}
truncate -s 256M ${FILES_DIR}/susp.img
LOOP=\$(losetup --find --show ${FILES_DIR}/susp.img)
SIZE=\$(blockdev --getsz "\$LOOP")
dmsetup create ${DM_NAME} --table "0 \${SIZE} linear \${LOOP} 0"
# The saved linear table lives on the PERSISTENT pool (${FILES_DIR}), not /run
# — a reboot must still be able to restore the pool's I/O.
echo "0 \${SIZE} linear \${LOOP} 0" > ${FILES_DIR}/${DM_NAME}.table
echo "0 \${SIZE} error" > ${FILES_DIR}/${DM_NAME}.error-table
zpool create -f ${POOL} /dev/mapper/${DM_NAME}
zfs create ${POOL}/fs
# Swap the table to error and force reads: every I/O now fails and the pool
# suspends exactly the way a yanked disk does (story 3.16). Suspend before the
# load, --noflush --nolockfs (no I/O can flush anyway — it is about to fail —
# and the fs may be locked).
dmsetup suspend --noflush --nolockfs ${DM_NAME}
dmsetup load ${DM_NAME} ${FILES_DIR}/${DM_NAME}.error-table
dmsetup resume ${DM_NAME}
# Force I/O against the now-failing table. The scrub is launched DETACHED and
# never waited on: on a pool that suspends mid-call, 'zpool scrub' blocks in
# uninterruptible D state (cv_wait_common), where SIGTERM never lands — a
# 'timeout 60' wrapper then hangs alongside it instead of bounding it, which is
# how the first run of this verb wedged. Issuing the scrub is all the shape
# needs; the poll below is the real completion test, and 'zpool list' keeps
# answering on a suspended pool. The blocked scrub is released the moment
# 'down' reloads the linear table (proven on the node).
setsid zpool scrub ${POOL} </dev/null >/dev/null 2>&1 &
for n in \$(seq 1 60); do
  rc=0
  h="\$(timeout 60 zpool list -H -o health ${POOL} 2>/dev/null)" || rc=\$?
  if [ "\$h" = "SUSPENDED" ]; then
    echo "✓ ${POOL} is SUSPENDED"
    exit 0
  fi
  if [ "\$rc" -eq 124 ]; then
    echo "ERROR: 'zpool list' timed out — ${POOL} wedged before it could suspend" >&2
    exit 124
  fi
  sleep 1
done
echo "ERROR: ${POOL} never suspended" >&2
exit 1
REMOTE
}

# The suspended shape's I/O must be restored BEFORE the pool can be destroyed:
# reload the saved linear table, clear, then destroy. Everything here tolerates
# the never-suspended state, every zpool call is bounded (timeout 60), and the
# loop device is released even when its dm device is already gone. It does NOT
# rm -rf the file directory — that happens in `down` AFTER the destroy, since a
# non-suspended pool may still back onto those files.
restore_dm_and_destroy() {
  $SSH_CMD "bash -s" <<REMOTE || true
TABLE=${FILES_DIR}/${DM_NAME}.table
if dmsetup info ${DM_NAME} >/dev/null 2>&1; then
  dmsetup suspend --noflush --nolockfs ${DM_NAME} || true
  if [ -s "\$TABLE" ]; then
    # POSITIONAL table file: --table takes an INLINE table, so '--table <path>'
    # reads as a one-word table — the load fails under '|| true', 'resume'
    # re-activates dm-error, and 'zpool clear' then hangs on failmode=wait.
    dmsetup load ${DM_NAME} "\$TABLE" || true
  fi
  dmsetup resume ${DM_NAME} || true
  if timeout 60 zpool list -H ${POOL} >/dev/null 2>&1; then
    timeout 60 zpool clear ${POOL} || true
    for n in \$(seq 1 10); do
      [ "\$(timeout 60 zpool list -H -o health ${POOL} 2>/dev/null)" != "SUSPENDED" ] && break
      sleep 1
    done
    timeout 60 zpool destroy -f ${POOL} || true
  fi
  dmsetup remove ${DM_NAME} || true
fi
LOOP=\$(losetup -a | grep '${FILES_DIR}/susp.img' | cut -d: -f1 || true)
[ -n "\$LOOP" ] && losetup -d "\$LOOP" || true
REMOTE
}

# Partition disk 9 into six and create ${POOL} in ONE remote shell so the
# partition table is fresh when the pool lands (a crashed earlier run left no
# pool but may have left a stale table — zap it first). $1 is the `zpool
# create` tail, with ${P} standing for the device prefix the leaves hang off:
# the kernel device for `up`, the by-id path for the by-id shapes.
create_pool() {
  local tail="$1" prefix="$2"
  $SSH_CMD "bash -s" <<REMOTE
set -euo pipefail
D=\$(readlink -f /dev/disk/by-id/${BY_ID})
sgdisk -Z "\$D"
sgdisk -n1:0:+400M -n2:0:+200M -n3:0:+200M -n4:0:+400M -n5:0:+300M -n6:0:0 "\$D"
udevadm settle
P="${prefix}"
zpool create -f ${POOL} ${tail}
REMOTE
}

case "$1" in
  up)
    echo "=== vdevs.1 fixture — up (kernel names) ==="

    "$SCRIPT_DIR/add-disk.sh" --size 2048 "$DISK_NUM"
    wait_for_by_id

    if pool_exists; then
      echo "✓ ${POOL} already exists (skipping — 'down' first for a rebuild)"
    else
      create_pool '"${P}1" log "${P}2" cache "${P}3" spare "${P}4" special "${P}5" dedup "${P}6"' '$D'
      echo "✓ ${POOL} created (six classes on six partitions of ${BY_ID}, kernel names)"
    fi

    echo
    echo "=== Fixture ready ==="
    status
    ;;

  up-byid)
    echo "=== vdevs.2 fixture — up-byid (by-id partition leaves) ==="

    "$SCRIPT_DIR/add-disk.sh" --size 2048 "$DISK_NUM"
    wait_for_by_id

    if pool_exists; then
      echo "✓ ${POOL} already exists (skipping — 'down' first for a rebuild)"
    else
      create_pool '"${P}-part1" log "${P}-part2" cache "${P}-part3" spare "${P}-part4" special "${P}-part5" dedup "${P}-part6"' "/dev/disk/by-id/${BY_ID}"
      echo "✓ ${POOL} created (six classes as by-id partitions of ${BY_ID})"
    fi

    echo
    echo "=== Fixture ready ==="
    status
    ;;

  up-multi)
    echo "=== vdevs.2 fixture — up-multi (two cache leaves, two spares) ==="

    "$SCRIPT_DIR/add-disk.sh" --size 2048 "$DISK_NUM"
    wait_for_by_id

    if pool_exists; then
      echo "✓ ${POOL} already exists (skipping — 'down' first for a rebuild)"
    else
      create_pool '"${P}-part1" log "${P}-part2" cache "${P}-part3" "${P}-part6" spare "${P}-part4" "${P}-part5"' "/dev/disk/by-id/${BY_ID}"
      echo "✓ ${POOL} created (data + two cache leaves + two spares, by-id)"
    fi

    echo
    echo "=== Fixture ready ==="
    status
    ;;

  up-file)
    up_file
    echo
    echo "=== Fixture ready ==="
    status
    ;;

  up-mirrorlog)
    up_mirrorlog
    echo
    echo "=== Fixture ready ==="
    status
    ;;

  up-byid-whole)
    up_byid_whole
    echo
    echo "=== Fixture ready ==="
    status
    ;;

  up-suspended)
    up_suspended
    echo
    echo "=== Fixture ready ==="
    status
    ;;

  down)
    echo "=== vdevs.1 fixture — down ==="
    # The suspended shape first: its dm table is the pool's backing, and a
    # suspended pool cannot be destroyed until the I/O is restored.
    restore_dm_and_destroy
    if pool_exists; then
      # -f and tolerated: down is the idempotent safety net — a pool it cannot
      # destroy still tears the rest of the shape down.
      $SSH_CMD "zpool destroy -f ${POOL} || true"
      echo "✓ ${POOL} destroy issued (errors, if any, above)"
    else
      echo "✓ ${POOL} not present (skipping)"
    fi
    # The file directory is swept HERE — after every pool that could back onto
    # its files (the suspended shape, the file shapes) is gone.
    $SSH_CMD "rm -rf ${FILES_DIR}" || true
    echo "✓ ${FILES_DIR} swept"
    # Wipe the disk (labels + GPT) so it comes back blank. Tolerates the
    # never-attached state (no by-id link).
    $SSH_CMD "bash -s" <<REMOTE || true
# readlink -e, not -f: -f prints the path even when nothing is there, and
# wipefs/sgdisk then fail noisily against a device that is not attached
# (the file-only shapes never attach disk ${DISK_NUM}).
D=\$(readlink -e /dev/disk/by-id/${BY_ID} 2>/dev/null || true)
if [ -n "\$D" ] && [ -b "\$D" ]; then
  wipefs -a "\$D"
  sgdisk -Z "\$D"
fi
udevadm settle
REMOTE
    detach_disk
    ;;

  status)
    status
    ;;

  *)
    usage
    ;;
esac

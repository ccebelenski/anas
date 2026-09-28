#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# pvepool.1 live-proof fixture — loop-backed, disposable, never the node's
# real disks (1 GiB sparse images under /var/tmp).
#
# Builds two loop-device pools on the stunt node:
#   pvfix  PVE's own `pvesm add zfspool` on the pool root, carrying one
#          dataset of each guest-volume kind (vm-/subvol-/basevol-/base-)
#          plus ANAS siblings (media, media/child) and a dir storage (dump)
#   sysfix shaped like a ZFS-root install: ROOT/pve-1 with bootfs set, a
#          nested sysfix/data zfspool storage holding a guest zvol, and an
#          ANAS sibling (media) — the system-pool ground truth
#
# The fixture assumes a running node: after a reboot the loop devices vanish
# and the pools are not auto-imported — restore the baseline snapshot instead.

FIXDIR="/var/tmp/pvepool-fixture"

usage() {
  echo "Usage: pvepool-fixture.sh <up|down|status>"
  echo "  up      Build the fixture (idempotent)"
  echo "  down    Tear it down (idempotent; silent when nothing exists)"
  echo "  status  Storages, fixture datasets, and sysfix bootfs"
  exit 1
}

[ $# -eq 1 ] || usage

pool_exists() { $SSH_CMD "zpool list -H $1" >/dev/null 2>&1; }
# pvesm has no per-storage lookup (no `pvesm get`, `status` is a table) —
# storage.cfg is the source of truth; entries are `<type>: <id>` lines
storage_exists() { $SSH_CMD "grep -qE \"^[a-z]+: $1\$\" /etc/pve/storage.cfg"; }

# Create a dataset unless it already exists (extra zfs-args precede the name).
ensure_dataset() {
  local ds="$1"; shift
  if $SSH_CMD "zfs list -H ${ds}" >/dev/null 2>&1; then
    echo "✓ ${ds} already exists (skipping)"
  else
    $SSH_CMD "zfs create $* ${ds}"
    echo "✓ ${ds} created"
  fi
}

# Register a storage unless it already exists (args are the pvesm add args).
ensure_storage() {
  local id="$1"; shift
  if storage_exists "${id}"; then
    echo "✓ storage ${id} already registered (skipping)"
  else
    $SSH_CMD "pvesm add $*"
    echo "✓ storage ${id} registered"
  fi
}

# Create a loop-backed pool unless it already exists.
ensure_pool() {
  local pool="$1"
  # rm -rf /${pool} below — never let an empty name reach it
  [ -n "${pool}" ] || { echo "ensure_pool: empty pool name" >&2; exit 1; }
  local img="${FIXDIR}/${pool}.img"
  local marker="${FIXDIR}/${pool}.loop"

  if pool_exists "${pool}"; then
    echo "✓ pool ${pool} already exists (skipping)"
    return 0
  fi

  # Stale mountpoint from an interrupted run: zpool destroy -f leaves the
  # directory behind, and PVE re-creates dir-storage paths while the
  # storage.cfg entry exists — either way it blocks zpool create
  if $SSH_CMD "test -d /${pool}"; then
    $SSH_CMD "rm -rf /${pool}"
  fi

  $SSH_CMD "mkdir -p ${FIXDIR}"
  # Drop a loop left over from an interrupted earlier run before reusing
  # the image slot
  if $SSH_CMD "test -f ${marker}"; then
    local stale
    stale=$($SSH_CMD "cat ${marker}")
    $SSH_CMD "losetup -d ${stale} 2>/dev/null" || true
    $SSH_CMD "rm -f ${marker}"
  fi

  $SSH_CMD "rm -f ${img} && truncate -s 1G ${img}"
  local loop
  loop=$($SSH_CMD "losetup -f --show ${img}")
  $SSH_CMD "echo ${loop} > ${marker}"
  # autotrim=on: the image is sparse, and every write the guest does grows it;
  # trim holes the backing file back out (0.4.1 retrospective fixture gap).
  $SSH_CMD "zpool create -o cachefile=none -o autotrim=on -O mountpoint=/${pool} ${pool} ${loop}"
  echo "✓ pool ${pool} created on ${loop}"
}

status() {
  echo "--- pvesm status ---"
  $SSH_CMD "pvesm status"
  local pool
  for pool in pvfix sysfix; do
    pool_exists "${pool}" || continue
    echo
    echo "--- zfs list -r ${pool} ---"
    $SSH_CMD "zfs list -r -o name,type,mountpoint ${pool}"
  done
  if pool_exists sysfix; then
    echo
    echo "--- sysfix bootfs ---"
    $SSH_CMD "zpool get bootfs sysfix"
  fi
}

case "$1" in
  up)
    echo "=== pvepool.1 fixture — up ==="

    # PVE pool with guest volumes + ANAS siblings
    ensure_pool pvfix
    ensure_storage pvfix "zfspool pvfix --pool pvfix --content images,rootdir"
    ensure_dataset pvfix/vm-100-disk-0 "-V" "64M"
    ensure_dataset pvfix/subvol-101-disk-0
    ensure_dataset pvfix/basevol-102-disk-0
    ensure_dataset pvfix/base-103-disk-0 "-V" "64M"
    ensure_dataset pvfix/media
    ensure_dataset pvfix/media/child
    ensure_dataset pvfix/dump
    ensure_storage pvfixdump "dir pvfixdump --path /pvfix/dump --content backup"

    # ZFS-root-shaped pool: bootfs set, nested data storage, guest + sibling
    ensure_pool sysfix
    ensure_dataset sysfix/ROOT
    ensure_dataset sysfix/ROOT/pve-1 "-o" "mountpoint=none"
    $SSH_CMD "zpool set bootfs=sysfix/ROOT/pve-1 sysfix"
    echo "✓ sysfix bootfs set"
    ensure_dataset sysfix/data
    ensure_storage sysfix-data "zfspool sysfix-data --pool sysfix/data --content images,rootdir"
    ensure_dataset sysfix/data/vm-200-disk-0 "-V" "64M"
    ensure_dataset sysfix/media

    echo
    echo "=== Fixture ready ==="
    status
    ;;

  down)
    for id in pvfix pvfixdump sysfix-data; do
      if storage_exists "${id}"; then
        $SSH_CMD "pvesm remove ${id}" >/dev/null
        echo "✓ storage ${id} removed"
      fi
    done
    for pool in pvfix sysfix; do
      if pool_exists "${pool}"; then
        $SSH_CMD "zpool destroy -f ${pool}"
        echo "✓ pool ${pool} destroyed"
      fi
    done
    # destroy leaves the mountpoint dirs; PVE may have re-created the
    # dir-storage path — remove what is left
    for pool in pvfix sysfix; do
      if $SSH_CMD "test -d /${pool}"; then
        $SSH_CMD "rm -rf /${pool}"
        echo "✓ /${pool} removed"
      fi
    done
    for pool in pvfix sysfix; do
      if $SSH_CMD "test -f ${FIXDIR}/${pool}.loop"; then
        loop=$($SSH_CMD "cat ${FIXDIR}/${pool}.loop")
        $SSH_CMD "losetup -d ${loop} 2>/dev/null" || true
        $SSH_CMD "rm -f ${FIXDIR}/${pool}.loop"
        echo "✓ ${loop} detached (${pool})"
      fi
    done
    if $SSH_CMD "test -d ${FIXDIR}"; then
      $SSH_CMD "rm -rf ${FIXDIR}"
      echo "✓ ${FIXDIR} removed (loop images)"
    fi
    ;;

  status)
    status
    ;;

  *)
    usage
    ;;
esac

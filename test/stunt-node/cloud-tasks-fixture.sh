#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# rclone.2 live-proof fixture — disposable state on the stunt node for the
# cloud sync TASKS spec (tests/integration/cloud-tasks-api.spec.ts).
#
# Everything the remotes half needs comes from cloud-fixture.sh, which this
# script drives: the `rclonegt`/`gtpass` sftp user answering on 127.0.0.1, and
# the capture/restore of /etc/anas/rclone.conf (the spec writes its remotes
# through the API, so the store is never built here).
#
# On top of that it builds what a TASK needs:
#
#   gtbackup/cloudsrc   a ZFS dataset (the source), ~350 KB in three files:
#                         a.bin      200 KiB of random bytes
#                         b.bin      150 KiB of random bytes  (the sync test deletes this one)
#                         sub/c.txt  a small text file in a subdirectory
#                       A DATASET on purpose: the run must derive `snapshot`
#                       consistency and read through a transient
#                       `anas-cloud-<task>-<unix>` snapshot, which only a real
#                       dataset can prove.
#
#   gtbackup/cloudempty an EMPTY dataset — the `sync` empty-source refusal
#                       ("would delete everything at the destination") and the
#                       `copy`-from-empty no-op that is deliberately allowed.
#
#   /home/rclonegt/dst  the sftp-side landing area, emptied of any `copy`/`sync`
#                       tree a previous run left (hello.txt, the remotes
#                       fixture's own file, stays).
#
#   /mnt/gt-unmounted   an EMPTY MOUNTPOINT DIRECTORY plus an /etc/fstab line
#                         //192.0.2.9/nope /mnt/gt-unmounted cifs noauto,guest,x-anas-fixture 0 0
#                       that is NEVER mounted (192.0.2.9 is TEST-NET; `noauto`
#                       keeps systemd from ever trying). This is the incident
#                       shape the source guard exists for: configured in fstab,
#                       absent from the mount table, an empty directory sitting
#                       where a share should be.
#
#   /mnt/gt-guardok     backup2.11's second half: the same shape, but MOUNTABLE.
#                         tmpfs /mnt/gt-guardok tmpfs noauto,x-anas-fixture 0 0
#                       It comes up UNMOUNTED (so the guard refuses a backup
#                       rooted there), and `mount /mnt/gt-guardok` makes it real
#                       — which is how the recovery half is proven: mount it,
#                       drop a file in, Run now, and the backup completes. tmpfs
#                       rather than a second CIFS share because it needs no
#                       server, no credentials and no network at all.
#
# `down` reverses all of it — the units the spec may have leaked included (only
# the fixture's OWN task names, never a foreign anas-cloud unit) — and then runs
# `cloud-fixture.sh down`, which restores the store's pre-state and removes the
# user. Idempotent in both directions; the pool `gtbackup` itself, its siblings
# and `gtiscsi` are never touched.

POOL="gtbackup"
SRC_DS="${POOL}/cloudsrc"
SRC_PATH="/${SRC_DS}"
EMPTY_DS="${POOL}/cloudempty"
EMPTY_PATH="/${EMPTY_DS}"

RCLONE_USER="rclonegt"
DST_DIR="/home/${RCLONE_USER}/dst"

UNMOUNTED_DIR="/mnt/gt-unmounted"
FSTAB_LINE="//192.0.2.9/nope ${UNMOUNTED_DIR} cifs noauto,guest,x-anas-fixture 0 0"
FSTAB_MARK="x-anas-fixture"

# backup2.11 — the MOUNTABLE counterpart. `x-` options are userspace-only, so
# libmount strips the marker and `mount ${GUARDOK_DIR}` just works.
GUARDOK_DIR="/mnt/gt-guardok"
GUARDOK_FSTAB_LINE="tmpfs ${GUARDOK_DIR} tmpfs noauto,x-anas-fixture 0 0"

# The task names the spec creates. `down` removes exactly these units — a
# crashed run must not leave a timer behind, and a foreign anas-cloud task
# (there are none on the stunt node, but the rule is the rule) is not ours.
TASKS=(gtcopy gtsync gtempty gtemptycopy gtunmounted gtfail)

usage() {
  echo "Usage: cloud-tasks-fixture.sh <up|down|status>"
  echo "  up      cloud-fixture.sh up + ${SRC_DS} (a.bin/b.bin/sub/c.txt), ${EMPTY_DS}, a clean ${DST_DIR}, and the unmounted ${UNMOUNTED_DIR} / ${GUARDOK_DIR} fstab entries"
  echo "  down    Remove the fixture's task units, the fstab entries and mountpoints, both datasets, then cloud-fixture.sh down"
  echo "  status  Datasets and their content, the sftp-side tree, the fstab entries, any anas-cloud units"
  exit 1
}

[ $# -eq 1 ] || usage

ds_exists() { $SSH_CMD "zfs list -H $1" >/dev/null 2>&1; }

status() {
  echo "--- source dataset ---"
  if ds_exists "${SRC_DS}"; then
    $SSH_CMD "zfs list -o name,mountpoint -H ${SRC_DS}; find ${SRC_PATH} -type f -printf '%p %s\n' | sort"
    echo "--- sha256 ---"
    $SSH_CMD "cd ${SRC_PATH} && sha256sum a.bin b.bin sub/c.txt 2>/dev/null || true"
    echo "--- transient snapshots (should be none between runs) ---"
    $SSH_CMD "zfs list -H -o name -t snapshot -d 1 ${SRC_DS} 2>/dev/null || true"
  else
    echo "no ${SRC_DS}"
  fi
  echo
  echo "--- empty dataset ---"
  if ds_exists "${EMPTY_DS}"; then
    $SSH_CMD "zfs list -o name,mountpoint -H ${EMPTY_DS}; ls -A ${EMPTY_PATH} | wc -l"
  else
    echo "no ${EMPTY_DS}"
  fi
  echo
  echo "--- sftp destination tree ---"
  $SSH_CMD "find ${DST_DIR} -printf '%p\n' 2>/dev/null | sort || echo 'no ${DST_DIR}'"
  echo
  echo "--- unmounted-mount fixture ---"
  $SSH_CMD "grep -F '${FSTAB_MARK}' /etc/fstab || echo 'no fstab entry'"
  $SSH_CMD "ls -ld ${UNMOUNTED_DIR} 2>/dev/null || echo 'no ${UNMOUNTED_DIR}'"
  $SSH_CMD "findmnt -n ${UNMOUNTED_DIR} && echo 'WARNING: it is MOUNTED' || echo 'not mounted (as intended)'"
  echo
  echo "--- mountable-mount fixture (backup2.11) ---"
  $SSH_CMD "ls -ld ${GUARDOK_DIR} 2>/dev/null || echo 'no ${GUARDOK_DIR}'"
  $SSH_CMD "findmnt -n ${GUARDOK_DIR} || echo 'not mounted (the spec mounts it)'"
  echo
  echo "--- anas-cloud units ---"
  $SSH_CMD "ls /etc/systemd/system | grep anas-cloud || echo 'none'"
}

case "$1" in
  up)
    echo "=== rclone.2 tasks fixture — up ==="

    # The remotes half: the sftp user, its ~/dst, and the store's captured
    # pre-state (the spec registers its remotes through the API).
    "${SCRIPT_DIR}/cloud-fixture.sh" up
    echo

    $SSH_CMD "zpool list -H ${POOL}" >/dev/null 2>&1 \
      || { echo "ERROR: pool ${POOL} not present — restore the baseline snapshot" >&2; exit 1; }

    # --- the source dataset ------------------------------------------------
    # Rebuilt from scratch every `up`: the sync test DELETES b.bin, so a
    # surviving dataset from a crashed run is not the shape the spec asserts.
    if ds_exists "${SRC_DS}"; then
      $SSH_CMD "zfs destroy -r ${SRC_DS}"
      echo "✓ stale ${SRC_DS} destroyed"
    fi
    $SSH_CMD "zfs create ${SRC_DS}"
    $SSH_CMD "dd if=/dev/urandom of=${SRC_PATH}/a.bin bs=1024 count=200 status=none"
    $SSH_CMD "dd if=/dev/urandom of=${SRC_PATH}/b.bin bs=1024 count=150 status=none"
    $SSH_CMD "mkdir -p ${SRC_PATH}/sub && printf 'c from the rclone.2 tasks fixture\n' > ${SRC_PATH}/sub/c.txt"
    $SSH_CMD "chmod -R a+r ${SRC_PATH} && sync"
    echo "✓ ${SRC_DS} built (a.bin 200K, b.bin 150K, sub/c.txt)"

    # --- the empty dataset -------------------------------------------------
    if ds_exists "${EMPTY_DS}"; then
      $SSH_CMD "zfs destroy -r ${EMPTY_DS}"
      echo "✓ stale ${EMPTY_DS} destroyed"
    fi
    $SSH_CMD "zfs create ${EMPTY_DS}"
    echo "✓ ${EMPTY_DS} created (empty on purpose)"

    # --- the sftp-side landing area ----------------------------------------
    # cloud-fixture.sh created ~/dst with hello.txt; a previous run's copy/
    # and sync/ trees are not a "before" the spec should read.
    $SSH_CMD "rm -rf ${DST_DIR}/copy ${DST_DIR}/sync ${DST_DIR}/empty && mkdir -p ${DST_DIR} && chown -R ${RCLONE_USER}:${RCLONE_USER} ${DST_DIR}"
    echo "✓ ${DST_DIR} clean (hello.txt kept)"

    # --- the configured-but-unmounted mount --------------------------------
    # Never mounted: 192.0.2.9 is TEST-NET and `noauto` keeps systemd from
    # trying. The DIRECTORY exists and is empty — exactly the boot-race shape
    # the source guard refuses to read through.
    $SSH_CMD "mkdir -p ${UNMOUNTED_DIR}"
    if $SSH_CMD "grep -qF '${FSTAB_MARK}' /etc/fstab"; then
      echo "✓ fstab entry already present"
    else
      $SSH_CMD "printf '%s\n' '${FSTAB_LINE}' >> /etc/fstab && systemctl daemon-reload"
      echo "✓ fstab entry added for ${UNMOUNTED_DIR} (noauto — never mounted)"
    fi
    if $SSH_CMD "findmnt -n ${UNMOUNTED_DIR} >/dev/null 2>&1"; then
      echo "ERROR: ${UNMOUNTED_DIR} is MOUNTED — the guard test needs it unmounted" >&2
      exit 1
    fi

    # --- the configured-but-unmounted mount that CAN be mounted ------------
    # backup2.11's recovery half. It starts unmounted (`noauto`); the spec
    # mounts it, proves the run then completes, and `down` unmounts it again.
    $SSH_CMD "mkdir -p ${GUARDOK_DIR}"
    if $SSH_CMD "grep -qF ' ${GUARDOK_DIR} ' /etc/fstab"; then
      echo "✓ fstab entry already present for ${GUARDOK_DIR}"
    else
      $SSH_CMD "printf '%s\n' '${GUARDOK_FSTAB_LINE}' >> /etc/fstab && systemctl daemon-reload"
      echo "✓ fstab entry added for ${GUARDOK_DIR} (tmpfs, noauto — mountable on demand)"
    fi
    # A leftover mount from a crashed spec run is not the "before" the guard
    # test reads: it must start absent from the mount table.
    if $SSH_CMD "findmnt -n ${GUARDOK_DIR} >/dev/null 2>&1"; then
      $SSH_CMD "umount ${GUARDOK_DIR}"
      echo "✓ stale ${GUARDOK_DIR} mount released"
    fi

    echo
    echo "=== Fixture ready ==="
    status
    ;;

  down)
    echo "=== rclone.2 tasks fixture — down ==="

    # The fixture's OWN task units (a crashed spec run's leftovers). Named
    # explicitly: a foreign anas-cloud unit is not this fixture's to remove.
    for t in "${TASKS[@]}"; do
      if $SSH_CMD "test -f /etc/systemd/system/anas-cloud-${t}.service -o -f /etc/systemd/system/anas-cloud-${t}.timer"; then
        $SSH_CMD "systemctl disable --now anas-cloud-${t}.timer >/dev/null 2>&1; rm -f /etc/systemd/system/anas-cloud-${t}.service /etc/systemd/system/anas-cloud-${t}.timer"
        echo "✓ anas-cloud-${t} units removed"
      fi
    done
    $SSH_CMD "systemctl daemon-reload"

    # The fstab entries + their mountpoints (rmdir only — a populated directory
    # is not ours to delete). The tmpfs one is released FIRST: the spec mounts
    # it, and an fstab line removed under a live mount leaves a stray tmpfs
    # behind with nothing naming it.
    if $SSH_CMD "findmnt -n ${GUARDOK_DIR} >/dev/null 2>&1"; then
      $SSH_CMD "umount ${GUARDOK_DIR}"
      echo "✓ ${GUARDOK_DIR} unmounted"
    fi
    # One marker, both lines — the CIFS one and the tmpfs one.
    if $SSH_CMD "grep -qF '${FSTAB_MARK}' /etc/fstab"; then
      $SSH_CMD "sed -i '/${FSTAB_MARK}/d' /etc/fstab && systemctl daemon-reload"
      echo "✓ fstab entries removed"
    fi
    for d in "${UNMOUNTED_DIR}" "${GUARDOK_DIR}"; do
      if $SSH_CMD "test -d ${d}"; then
        $SSH_CMD "rmdir ${d} 2>/dev/null || true"
        echo "✓ ${d} removed (if empty)"
      fi
    done

    # The datasets, with any transient snapshot a killed run left behind.
    for ds in "${SRC_DS}" "${EMPTY_DS}"; do
      if ds_exists "${ds}"; then
        $SSH_CMD "zfs destroy -r ${ds}"
        echo "✓ ${ds} destroyed"
      fi
    done

    echo
    "${SCRIPT_DIR}/cloud-fixture.sh" down
    ;;

  status)
    status
    ;;

  *)
    usage
    ;;
esac

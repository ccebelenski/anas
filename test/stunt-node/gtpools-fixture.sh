#!/usr/bin/env bash
# gtpools-fixture.sh — the two file-backed pools every stunt-node spec treats as
# "present on every stunt node": gtbackup (backup/cloud/replication/recycle
# specs) and gtiscsi (ident-iscsi). They are NOT part of the baseline snapshot
# (rebuilt 2026-10-12): bring them up once after a rebuild or a baseline
# restore. File vdevs under /var/tmp with the default cachefile, so a reboot
# re-imports them from zpool.cache (unlike pvepool-fixture's loop pools).
# `cloud-tasks-fixture.sh trim` reclaims the sparse images after heavy specs.
#
# Usage: gtpools-fixture.sh <up|down|status>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

IMG_DIR="/var/tmp"
declare -A SIZE=([gtbackup]=8G [gtiscsi]=6G)
POOLS=(gtbackup gtiscsi)

pool_exists() { $SSH_CMD "zpool list -H $1" >/dev/null 2>&1; }

ensure_pool() {
  local pool="$1" img="${IMG_DIR}/$1.img"
  [ -n "${pool}" ] || { echo "ensure_pool: empty pool name" >&2; exit 1; }
  if pool_exists "${pool}"; then
    echo "✓ pool ${pool} already exists (skipping)"
    return 0
  fi
  # An exported pool on an existing image: import it rather than clobber it.
  if $SSH_CMD "test -f ${img}" && $SSH_CMD "zpool import -d ${IMG_DIR} ${pool}" 2>/dev/null; then
    echo "✓ pool ${pool} imported from ${img}"
    return 0
  fi
  # A stale mountpoint dir blocks zpool create.
  $SSH_CMD "test -d /${pool} && rm -rf /${pool} || true"
  $SSH_CMD "rm -f ${img} && truncate -s ${SIZE[$pool]} ${img}"
  $SSH_CMD "zpool create -o autotrim=on -O mountpoint=/${pool} ${pool} ${img}"
  echo "✓ pool ${pool} created on ${img} (${SIZE[$pool]} sparse)"
}

usage() {
  echo "Usage: gtpools-fixture.sh <up|down|status>"
  echo "  up      create (or import) gtbackup and gtiscsi on ${IMG_DIR}/<pool>.img"
  echo "  down    destroy both pools and delete their images (every dataset on them goes)"
  echo "  status  what is present"
  exit 1
}

case "${1:-}" in
  up)
    echo "=== gt pools fixture — up ==="
    for p in "${POOLS[@]}"; do ensure_pool "${p}"; done
    $SSH_CMD "zpool list -H -o name,size,health ${POOLS[*]}"
    ;;
  down)
    echo "=== gt pools fixture — down ==="
    for p in "${POOLS[@]}"; do
      if pool_exists "${p}"; then
        $SSH_CMD "zpool destroy -f ${p}" && echo "✓ pool ${p} destroyed"
      else
        echo "✓ pool ${p} not present"
      fi
      $SSH_CMD "rm -f ${IMG_DIR}/${p}.img; rmdir /${p} 2>/dev/null || true"
    done
    ;;
  status)
    for p in "${POOLS[@]}"; do
      if pool_exists "${p}"; then
        $SSH_CMD "zpool list -H -o name,size,alloc,health ${p}; du -h --apparent-size ${IMG_DIR}/${p}.img | cut -f1 | sed 's/^/  image apparent size: /'; du -h ${IMG_DIR}/${p}.img | cut -f1 | sed 's/^/  image on disk: /'"
      else
        echo "${p}: not present"
      fi
    done
    ;;
  *) usage ;;
esac

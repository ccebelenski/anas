#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# topology.1 — re-capture the pool-shape zoo on demand.
#
# Drives test/stunt-node/vdev-fixture.sh (its verbs build every shape on disk 9
# and on files under /gtbackup/anas-topology-zoo — never disks 1-6, never
# gtbackup's own data, never gtiscsi), captures BOTH commands verbatim for each
# shape, and lands them in the zoo:
#
#   packages/daemon/src/fixtures/zfs/zpool-status-<shape>-<zfsver>.json
#   packages/daemon/src/fixtures/telemetry/zpool-iostat-plv-<shape>-<zfsver>.txt
#
# Commands captured, verbatim daemon stdout:
#   zpool status  -j -p gtvdev      (the -p parseable-numbers form — see the
#                                    "-p flag" note in fixtures/zfs/NOTES.md)
#   zpool iostat -plv gtvdev 1 2    (two samples: since-boot + interval)
#
# NO PROVENANCE HEADER IS INJECTED INTO THE FILES. JSON cannot carry comments,
# and parseZpoolIostat would read a comment line as a pool row — the provenance
# is the sidecar row in fixtures/zfs/NOTES.md's zoo table (the practice the
# existing fixtures follow), plus the file name's ZFS version.
#
# The captures land under NEW version-suffixed names rather than overwriting
# the committed ones: replacing a capture is a deliberate act — it changes what
# the parser tests pin. After a capture run, add (or move) the NOTES.md zoo
# table row and the zpool-status-zoo.test.ts EXPECTED entries; the zoo test
# fails on any fixture file that has neither, so the step cannot be skipped
# silently. Then re-run the daemon suite.
#
# Idempotent: each shape is torn down (vdev-fixture.sh down) before and after.

POOL="gtvdev"
ZFS_DIR="packages/daemon/src/fixtures/zfs"
TELEMETRY_DIR="packages/daemon/src/fixtures/telemetry"

# shape → the vdev-fixture.sh verb that builds it.
declare -A SHAPE_VERB=(
  [all-vdev-classes]=up
  [byid-partition-classes]=up-byid
  [multi-cache-spare]=up-multi
  [file-vdev]=up-file
  [byid-whole-disk]=up-byid-whole
  [suspended]=up-suspended
)
SHAPES=(all-vdev-classes byid-partition-classes multi-cache-spare file-vdev byid-whole-disk suspended)

usage() {
  echo "Usage: topology-zoo.sh capture [shape ...]"
  echo "       topology-zoo.sh clean"
  echo "       topology-zoo.sh list"
  echo
  echo "Shapes: ${SHAPES[*]}"
  echo "  (default: all six — the whole zoo re-proven in one run)"
  exit 1
}

[ $# -ge 1 ] || usage

# Repo root — the fixture destinations, unless FIXTURES_ROOT overrides it.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURES_ROOT="${FIXTURES_ROOT:-${REPO_ROOT}}"

fail() { echo "ERROR: $*" >&2; exit 1; }

require_node() {
  $SSH_CMD "true" 2>/dev/null || fail "the stunt node is not reachable (\$SSH_CMD)"
}

# The node's ZFS version, filename-safe (e.g. 2.4.4-pve1).
zfs_version() {
  local v
  v="$($SSH_CMD "zfs version | head -1")"
  v="${v#zfs-}"
  v="${v%% *}"
  [[ "$v" =~ ^[0-9A-Za-z.-]+$ ]] || fail "cannot parse a ZFS version from 'zfs version' (got: $v)"
  echo "$v"
}

# capture_shape <shape> <zfsver> — the pool is UP and ready; take both files.
capture_shape() {
  local shape="$1" zfsver="$2"
  local status_out iostat_out
  local status_path iostat_path

  echo "--- capturing ${shape} ---"

  status_out="$($SSH_CMD "zpool status -j -p ${POOL}")"
  # Never land a file that is not what it claims to be: it must parse as JSON
  # and it must be THE fixture pool. (A failed capture of the wrong state
  # would otherwise become zoo material.)
  node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c).on("end", () => {
      const j = JSON.parse(raw)
      const p = j.pools && j.pools[process.argv[1]]
      if (!p) { console.error(`pool ${process.argv[1]} missing from the capture`); process.exit(1) }
      if (!p.state) { console.error("capture carries no pool state"); process.exit(1) }
    })
  ' "$POOL" <<< "$status_out"

  # VERBATIM: the only transformation is stripping the ssh transport's CR, as
  # the existing telemetry captures record in their NOTES row.
  iostat_out="$($SSH_CMD "zpool iostat -plv ${POOL} 1 2" | tr -d '\r')"
  echo "$iostat_out" | grep -q "capacity" || fail "iostat capture for ${shape} has no header line"

  status_path="${FIXTURES_ROOT}/${ZFS_DIR}/zpool-status-${shape}-${zfsver}.json"
  iostat_path="${FIXTURES_ROOT}/${TELEMETRY_DIR}/zpool-iostat-plv-${shape}-${zfsver}.txt"

  printf '%s\n' "$status_out" > "$status_path"
  printf '%s\n' "$iostat_out" > "$iostat_path"

  echo "✓ ${status_path}"
  echo "✓ ${iostat_path}"
  local state
  state="$(echo "$status_out" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const j=JSON.parse(r);console.log(Object.values(j.pools)[0].state)})')"
  echo "  pool state: ${state}"
}

cmd_capture() {
  require_node
  local zfsver
  zfsver="$(zfs_version)"
  echo "=== topology.1 zoo capture — ZFS ${zfsver} ==="

  local requested=("$@")
  [ ${#requested[@]} -eq 0 ] && requested=("${SHAPES[@]}")

  for shape in "${requested[@]}"; do
    local verb="${SHAPE_VERB[$shape]:-}"
    [ -n "$verb" ] || usage
    echo
    echo "=== shape: ${shape} (vdev-fixture.sh ${verb}) ==="
    "${SCRIPT_DIR}/vdev-fixture.sh" down >/dev/null 2>&1 || true
    "${SCRIPT_DIR}/vdev-fixture.sh" "${verb}"
    capture_shape "$shape" "$zfsver"
  done

  echo
  echo "=== tearing the last shape down ==="
  "${SCRIPT_DIR}/vdev-fixture.sh" down

  echo
  echo "=== Captured ==="
  echo "Now ink the provenance: one zoo-table row per new file in"
  echo "${ZFS_DIR}/NOTES.md, EXPECTED entries in"
  echo "packages/daemon/src/parsers/__tests__/zpool-status-zoo.test.ts —"
  echo "or replace the superseded capture with the new one, deliberately."
  echo "Then: npm test -w packages/daemon (the zoo test fails on any file"
  echo "without both)."
}

cmd_clean() {
  echo "=== topology.1 zoo — clean ==="
  "${SCRIPT_DIR}/vdev-fixture.sh" down
  echo "✓ fixture pool, disk 9 and /gtbackup/anas-topology-zoo swept"
}

cmd_list() {
  echo "Shapes and the verbs that build them:"
  for shape in "${SHAPES[@]}"; do
    echo "  ${shape}  <- vdev-fixture.sh ${SHAPE_VERB[$shape]}"
  done
}

case "$1" in
  capture)
    shift
    cmd_capture "$@"
    ;;
  clean)
    cmd_clean
    ;;
  list)
    cmd_list
    ;;
  *)
    usage
    ;;
esac

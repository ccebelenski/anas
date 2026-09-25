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
#   packages/daemon/src/fixtures/zfs/zpool-status-<token>-<zfsver>.json
#   packages/daemon/src/fixtures/telemetry/zpool-iostat-plv-<token>-<zfsver>.txt
#
# (<token> is the shape name, except for the three `-jv` re-captures — see
# SHAPE_FILE below.)
#
# Commands captured, verbatim daemon stdout — the DAEMON's argv:
#   zpool status  -jv <pool>        (what routes/disks.ts and routes/pools.ts
#                                    issue; there is no -p — see "Capture argv"
#                                    in fixtures/zfs/NOTES.md)
#   zpool iostat -plv <pool> 1 2    (two samples: since-boot + interval)
#
# Both captures run under `timeout 60` ON THE NODE: the suspended shape's
# failmode=wait can wedge any zpool call, and a hung capture must fail loudly
# (exit 124), not hang the run.
#
# THE SUSPENDED SHAPE STOPS anasd FIRST (an EXIT trap starts it again): anasd's
# dashboard pull issues `zpool status -jv` with NO pool argument, and against a
# suspended pool that call blocks — the daemon would wedge alongside the shape
# for the whole capture. No other shape touches anasd.
#
# NO PROVENANCE HEADER IS INJECTED INTO THE FILES. JSON cannot carry comments,
# and parseZpoolIostat would read a comment line as a pool row — the provenance
# is the sidecar row in fixtures/zfs/NOTES.md's zoo table (the practice the
# existing fixtures follow), plus the file name's ZFS version.
#
# The version suffix is NORMALISED to the zoo's naming: `zfs version` prints
# `zfs-2.4.4-pve1`, the committed zoo names carry `2.4.4`, so the `-pveN`
# packaging tail is stripped before it becomes a filename.
#
# Existing capture files are NEVER overwritten unless --force is given:
# replacing a capture is a deliberate act — it changes what the parser tests
# pin. After a capture run, add (or move) the NOTES.md zoo table row and the
# zpool-status-zoo.test.ts EXPECTED entries; the zoo test fails on any fixture
# file that has neither, so the step cannot be skipped silently. Then re-run
# the daemon suite.
#
# STATED RISKS, accepted until the first run retires them (the fuller list is
# in the vdev-fixture.sh header): the file-backed shapes stack ZFS on ZFS and
# are short-lived; whether `zpool create` accepts file-backed log/cache/spare
# members is unverified; the suspension uses dm-error because it is
# deterministic where loop truncation depends on the loop's refcounting.
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
  [mirrored-log-partitions]=up-mirrorlog
  [byid-whole-disk]=up-byid-whole
  [suspended]=up-suspended
)
SHAPES=(all-vdev-classes byid-partition-classes multi-cache-spare file-vdev mirrored-log-partitions byid-whole-disk suspended)

# shape → the token the fixture FILES carry. It is the shape name everywhere
# except the three shapes whose `-p` captures are already checked in under the
# unsuffixed name (see "Capture argv" in fixtures/zfs/NOTES.md): those files are
# pinned by 0.3.5's tests and must not be replaced by a `-jv` re-capture, so the
# re-capture lands beside them carrying `-jv` in its name. Both halves of a pair
# take the same token, so a status capture and its iostat stay a matched pair.
declare -A SHAPE_FILE=(
  [all-vdev-classes]=all-vdev-classes-jv
  [byid-partition-classes]=byid-partition-classes
  [multi-cache-spare]=multi-cache-spare-jv
  [file-vdev]=file-vdev
  [mirrored-log-partitions]=mirrored-log-partitions-jv
  [byid-whole-disk]=byid-whole-disk
  [suspended]=suspended
)

# shape → the pool state the shape is SUPPOSED to produce. Every captured
# status is validated against this BEFORE it is written (a capture that reads
# ONLINE for the suspended shape is a failed capture, not zoo material).
declare -A SHAPE_STATE=(
  [all-vdev-classes]=ONLINE
  [byid-partition-classes]=ONLINE
  [multi-cache-spare]=ONLINE
  [file-vdev]=ONLINE
  [mirrored-log-partitions]=ONLINE
  [byid-whole-disk]=ONLINE
  [suspended]=SUSPENDED
)

usage() {
  echo "Usage: topology-zoo.sh capture [--force] [shape ...]"
  echo "       topology-zoo.sh clean"
  echo "       topology-zoo.sh list"
  echo
  echo "Shapes: ${SHAPES[*]}"
  echo "  (default: all seven — the whole zoo re-proven in one run)"
  echo "  --force: allow overwriting an existing capture file (a deliberate act)"
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

# The node's ZFS version, filename-safe and normalised to the zoo's naming
# (`zfs-2.4.4-pve1` from `zfs version` lands as `2.4.4`).
zfs_version() {
  local v
  v="$($SSH_CMD "zfs version | head -1" | tr -d '\r')"
  v="${v#zfs-}"
  v="${v%% *}"
  v="${v%%-pve*}" # the packaging tail is not part of the zoo's names
  [[ "$v" =~ ^[0-9A-Za-z.-]+$ ]] || fail "cannot parse a ZFS version from 'zfs version' (got: $v)"
  echo "$v"
}

# capture_shape <shape> <zfsver> — the pool is UP and ready; take both files.
capture_shape() {
  local shape="$1" zfsver="$2" expected="${3:-ONLINE}"
  local status_out iostat_out rc
  local status_path iostat_path

  echo "--- capturing ${shape} ---"

  # Bounded on the node: a failmode=wait pool can wedge zpool itself.
  rc=0
  status_out="$($SSH_CMD "timeout 60 zpool status -jv ${POOL}" | tr -d '\r')" || rc=$?
  [ "$rc" -eq 124 ] && fail "zpool status timed out on ${shape} — the shape is wedged; 'vdev-fixture.sh down' and investigate"
  [ "$rc" -eq 0 ] || fail "zpool status failed on ${shape} (exit ${rc})"

  # Never land a file that is not what it claims to be: it must parse as JSON,
  # it must be THE fixture pool, and it must read the state the shape is
  # supposed to produce (a failed capture of the wrong state would otherwise
  # become zoo material).
  node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c).on("end", () => {
      let j
      try { j = JSON.parse(raw) } catch { console.error("capture is not JSON"); process.exit(1) }
      const p = j.pools && j.pools[process.argv[1]]
      if (!p) { console.error(`pool ${process.argv[1]} missing from the capture`); process.exit(1) }
      if (!p.state) { console.error("capture carries no pool state"); process.exit(1) }
      if (p.state !== process.argv[2]) {
        console.error(`capture reads ${p.state}, expected ${process.argv[2]} for this shape`)
        process.exit(1)
      }
    })
  ' "$POOL" "$expected" <<< "$status_out"

  # VERBATIM: the only transformation is stripping the ssh transport's CR, as
  # the existing telemetry captures record in their NOTES row.
  rc=0
  iostat_out="$($SSH_CMD "timeout 60 zpool iostat -plv ${POOL} 1 2" | tr -d '\r')" || rc=$?
  [ "$rc" -eq 124 ] && fail "zpool iostat timed out on ${shape} — the shape is wedged"
  [ "$rc" -eq 0 ] || fail "zpool iostat failed on ${shape} (exit ${rc})"
  echo "$iostat_out" | grep -q "capacity" || fail "iostat capture for ${shape} has no header line"

  local token="${SHAPE_FILE[$shape]:-$shape}"
  status_path="${FIXTURES_ROOT}/${ZFS_DIR}/zpool-status-${token}-${zfsver}.json"
  iostat_path="${FIXTURES_ROOT}/${TELEMETRY_DIR}/zpool-iostat-plv-${token}-${zfsver}.txt"

  if [ -e "$status_path" ] || [ -e "$iostat_path" ]; then
    [ "$FORCE" -eq 1 ] || fail "a capture already exists at ${status_path} (or its pair) — replacing a capture is deliberate; pass --force"
  fi

  printf '%s\n' "$status_out" > "$status_path"
  printf '%s\n' "$iostat_out" > "$iostat_path"

  echo "✓ ${status_path}"
  echo "✓ ${iostat_path}"
  local state
  state="$(echo "$status_out" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const j=JSON.parse(r);console.log(Object.values(j.pools)[0].state)})')"
  echo "  pool state: ${state}"
}

FORCE=0

# anasd is stopped only around the suspended shape; the EXIT trap makes sure a
# failed or interrupted run still starts it again.
#
# BOTH units are named on the way back up. The gateway unit is
# PartOf=anasd.service, so stopping anasd stops anas with it — but PartOf
# propagates stop and restart ONLY, never start, so starting anasd alone leaves
# the UI at 502. A run that stops anasd must hand back both.
ANASD_STOPPED=0
start_anasd() {
  [ "$ANASD_STOPPED" -eq 1 ] || return 0
  ANASD_STOPPED=0
  $SSH_CMD "systemctl start anasd anas" 2>/dev/null || echo "WARNING: anasd/anas did not start — 'systemctl start anasd anas' on the node by hand" >&2
}
trap start_anasd EXIT

cmd_capture() {
  require_node
  local zfsver
  zfsver="$(zfs_version)"
  echo "=== topology.1 zoo capture — ZFS ${zfsver} ==="

  local requested=()
  local arg
  for arg in "$@"; do
    case "$arg" in
      --force) FORCE=1 ;;
      *) requested+=("$arg") ;;
    esac
  done
  [ ${#requested[@]} -eq 0 ] && requested=("${SHAPES[@]}")

  for shape in "${requested[@]}"; do
    local verb="${SHAPE_VERB[$shape]:-}"
    [ -n "$verb" ] || usage
    echo
    echo "=== shape: ${shape} (vdev-fixture.sh ${verb}) ==="
    if [ "$shape" = suspended ]; then
      echo "=== stopping anasd (its dashboard pull issues 'zpool status -jv' with no pool argument and would block on the suspended pool) ==="
      $SSH_CMD "systemctl stop anasd" || fail "could not stop anasd — refusing to build the suspended shape"
      ANASD_STOPPED=1
    fi
    "${SCRIPT_DIR}/vdev-fixture.sh" down >/dev/null 2>&1 || true
    "${SCRIPT_DIR}/vdev-fixture.sh" "${verb}"
    capture_shape "$shape" "$zfsver" "${SHAPE_STATE[$shape]}"
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
    echo "  ${shape}  <- vdev-fixture.sh ${SHAPE_VERB[$shape]} (expect ${SHAPE_STATE[$shape]})"
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

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# ident3-gt.sh — live proof for story ident.3 (AHR destructive verbs act only on
# members whose on-disk identity is ours). Runs FROM THE HOST against the
# stunt node, with the build under proof already deployed (deploy-anas.sh).
#
# Three proofs, each driven through the daemon's own API (the Unix socket, the
# same identity headers the udev cache rung uses) — never by hand, which would
# dodge the code under proof:
#
#   P1  A FOREIGN `media-r1` md array (two loop devices, NOT pinned in
#       mdadm.conf, its own UUID) beside an ANAS pool named `media`:
#         - the boot recovery ladder (anasd restart) never `--run`s it while it
#           sits inactive with every member `(S)` — the GT-8 shape;
#         - DELETE /v1/ahr/media destroys the ANAS pool and leaves the foreign
#           array running, its superblocks and its data byte-identical;
#         - POST /v1/ahr refuses to create `media` again while the foreign
#           array still carries the name.
#   P2  A hot spare that md used for a rebuild is a MEMBER: DELETE
#       /v1/ahr/media/spare/<id> answers 409 CONFLICT (no confirm code) and
#       the slice stays in the array.
#   P3  Destroy-then-recreate under the same name: a HALTED intent does not
#       block the destroy, the destroy removes it, the recreated pool carries
#       no expansion; an intent that recorded another pool's UUIDs reads as
#       stale (no `expansion`, no HALTED advisory), never as halted.
#
# Disks: hot7 + hot8 (1024 MB, the pool) and hot9 (1024 MB, the spare) — the
# shared AHR test disks, recreated BLANK. Loops: /root/ident3/l0, l1 (64 MB).
# Usage: ident3-gt.sh run    — attach, prove, tear down (exit 1 on any FAIL)
#        ident3-gt.sh down   — best-effort teardown only (after a crashed run)

POOL="media"
DISKS=(7 8 9)
SIZE_MB=1024
by_id() { echo "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT$1"; }
image_of() { echo "${STORAGE_PATH}/${VM_NAME}-hot$1.qcow2"; }
D7="$(by_id 7)"; D8="$(by_id 8)"; D9="$(by_id 9)"

attached() { sudo virsh domblklist "$VM_NAME" 2>/dev/null | grep -qF "$(image_of "$1")"; }

attach_blank() {
  local n="$1"
  if attached "$n"; then
    echo "✓ hot${n} already attached — it is wiped on the node before use"
  else
    rm -f "$(image_of "$n")"
    "$SCRIPT_DIR/add-disk.sh" --size "$SIZE_MB" "$n"
  fi
  local i
  for i in $(seq 1 30); do
    $SSH_CMD "udevadm settle; test -e /dev/disk/by-id/$(by_id "$n")" && return 0
    sleep 1
  done
  echo "ERROR: /dev/disk/by-id/$(by_id "$n") never appeared" >&2
  return 1
}

# ---- node-side library: prepended to every remote step ----------------------
read -r -d '' NODE_LIB <<'LIB' || true
set -uo pipefail
R=/root/ident3
mkdir -p "$R"
SOCK=/run/anas/anasd.sock
POOL=media
FOREIGN_MD=/dev/md/gtident
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; }
check() { # check <description> <command...>
  local what=$1; shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}
# api METHOD PATH [JSON] [CONFIRM] — body → $R/body, headers → $R/headers, prints the HTTP status
api() {
  local method=$1 path=$2 body=${3:-} code=${4:-}
  local args=(-s --unix-socket "$SOCK" -X "$method" -D "$R/headers" -o "$R/body" -w '%{http_code}'
    -H 'x-anas-user: root@pam' -H 'x-anas-user-uid: 0' -H "x-anas-request-id: $(cat /proc/sys/kernel/random/uuid)")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data "$body")
  [ -n "$code" ] && args+=(-H "x-anas-confirm: $code")
  curl "${args[@]}" "http://localhost/v1$path"
}
confirm_code() { grep -i '^x-anas-confirm-code:' "$R/headers" | awk '{print $2}' | tr -d '\r'; }
# json <python-expr over d> — reads $R/body
json() { python3 -c "import json; d=json.load(open('$R/body')); print($1)"; }
# wait_job <id> — prints completed|failed|timeout; the final job JSON stays in $R/body
wait_job() {
  local i st
  for i in $(seq 1 900); do
    api GET "/jobs/$1" >/dev/null
    st=$(json "d['job']['status']")
    case "$st" in completed|failed) echo "$st"; return 0;; esac
    sleep 1
  done
  echo timeout
}
# confirmed METHOD PATH [JSON] — the 409 confirm dance → 202 → job; prints the job status
confirmed() {
  local method=$1 path=$2 body=${3:-} st code
  st=$(api "$method" "$path" "$body")
  if [ "$st" != 409 ] || [ "$(json "d['error']['code']")" != CONFIRMATION_REQUIRED ]; then
    echo "unexpected first answer $st: $(cat "$R/body")" >&2; echo refused; return 0
  fi
  code=$(confirm_code)
  st=$(api "$method" "$path" "$body" "$code")
  if [ "$st" != 202 ]; then echo "unexpected confirmed answer $st: $(cat "$R/body")" >&2; echo refused; return 0; fi
  wait_job "$(json "d['job']['id']")"
}
md_of() { basename "$(readlink -f "$1")"; }
array_state() { cat "/sys/block/$(md_of "$1")/md/array_state" 2>/dev/null || echo absent; }
wait_idle() { # wait_idle <md path> [cap]
  local i s=/sys/block/$(md_of "$1")/md/sync_action
  for i in $(seq 1 "${2:-600}"); do [ "$(cat "$s" 2>/dev/null)" = idle ] && return 0; sleep 1; done
  return 1
}
# stop_md <md> — udev's `mdadm --monitor --scan` holds arrays open (see
# test/self-heal/gt/lib.sh teardown_all): TERM it, then stop with retries.
# Every mdadm here reads /dev/null: this script itself arrives on stdin.
stop_md() {
  local try
  pkill -TERM -f "^/usr/sbin/mdadm --monitor" 2>/dev/null || true
  for try in 1 2 3; do mdadm --stop "$1" </dev/null >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}
uuid_of_md() { mdadm --detail --export "$1" 2>/dev/null | sed -n 's/^MD_UUID=//p'; }
uuid_in() { mdadm --examine --export "$1" 2>/dev/null | sed -n 's/^MD_UUID=//p'; }
loops() { for f in "$R"/l0 "$R"/l1; do losetup -j "$f" | cut -d: -f1; done; }
LIB

remote() { { printf '%s\n' "$NODE_LIB"; cat; } | $SSH_CMD "bash -s"; }

node_teardown() {
  remote <<'EOF' || true
# The foreign array and its loops.
[ -e "$FOREIGN_MD" ] && stop_md "$FOREIGN_MD"
for lo in $(loops); do
  for m in /sys/block/md*/slaves/"$(basename "$lo")"; do [ -e "$m" ] && stop_md "/dev/$(basename "$(dirname "$(dirname "$m")")")"; done
  mdadm --zero-superblock "$lo" </dev/null 2>/dev/null; losetup -d "$lo" 2>/dev/null
done
rm -f "$R"/l0 "$R"/l1 /etc/anas/ahr/media.json
# Anything of `media` a crashed run left (destroy through the API is the normal path).
umount /mnt/anas-ahr/media 2>/dev/null || true
if vgs media >/dev/null 2>&1; then lvremove -ff -y media </dev/null >/dev/null 2>&1; vgremove -ff -y media </dev/null >/dev/null 2>&1; fi
for md in /dev/md/media-r*; do [ -e "$md" ] && stop_md "$md"; done
for d in scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7 scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8 scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9; do
  for p in /dev/disk/by-id/$d-part*; do [ -e "$p" ] && { mdadm --zero-superblock "$p" </dev/null 2>/dev/null; wipefs -a "$p" >/dev/null 2>&1; }; done
  [ -e /dev/disk/by-id/$d ] && sgdisk --zap-all /dev/disk/by-id/$d >/dev/null 2>&1
done
sed -i -E '\#/dev/md/media-r[0-9]+ #d' /etc/mdadm/mdadm.conf
if grep -q '/mnt/anas-ahr/media[[:space:]]' /etc/fstab; then sed -i -E '\#/mnt/anas-ahr/media[[:space:]]#d' /etc/fstab; systemctl daemon-reload; fi
udevadm settle
EOF
}

restart_daemon() {
  $SSH_CMD "systemctl restart anasd && systemctl start anas"
  local i
  for i in $(seq 1 30); do
    $SSH_CMD "test -S /run/anas/anasd.sock" && { sleep 3; return 0; }
    sleep 1
  done
  echo "ERROR: anasd socket never came back" >&2
  return 1
}

case "${1:-}" in
  down)
    node_teardown
    for n in "${DISKS[@]}"; do attached "$n" && "$SCRIPT_DIR/remove-disk.sh" "$n" || true; done
    exit 0
    ;;
  run) ;;
  *) echo "Usage: ident3-gt.sh <run|down>"; exit 1 ;;
esac

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
step() { echo; echo "=== $* ==="; }
run_remote() { remote | tee -a "$LOG" || true; }

step "preflight"
$SSH_CMD "test -S /run/anas/anasd.sock" || { echo "ERROR: anasd is not running on the node — deploy first" >&2; exit 1; }
# hot7-9 are SHARED test disks: refuse to wipe one another fixture still uses.
for n in "${DISKS[@]}"; do
  foreign_labels="$($SSH_CMD "lsblk -nro PARTLABEL /dev/disk/by-id/$(by_id "$n") 2>/dev/null | grep -v '^media-' | grep -v '^\$' || true")"
  if [ -n "$foreign_labels" ]; then
    echo "ERROR: hot${n} carries partitions of another fixture (${foreign_labels//$'\n'/ }) — run that fixture's 'down' first" >&2
    exit 1
  fi
done
node_teardown
for n in "${DISKS[@]}"; do attach_blank "$n"; done
# Disks that were already attached are wiped: they must read `available`.
node_teardown

# ---- P1/P2 setup: the ANAS pool `media` with a hot spare ---------------------
step "create the ANAS pool '${POOL}' (AHR-1 on hot7 + hot8) through POST /v1/ahr"
run_remote <<EOF
st=\$(confirmed POST /ahr '{"name":"media","tier":"ahr1","disks":["${D7}","${D8}"]}')
check "create job completed (\$st)" test "\$st" = completed
check "media-r1 is pinned in mdadm.conf" grep -q '^ARRAY /dev/md/media-r1 ' /etc/mdadm/mdadm.conf
check "initial sync finished" wait_idle /dev/md/media-r1 600
st=\$(confirmed POST /ahr/media/spare '{"diskId":"${D9}"}')
check "spare attach job completed (\$st)" test "\$st" = completed
grep -q "\$(basename "\$(readlink -f /dev/disk/by-id/${D9}-part1)")\[[0-9]*\](S)" /proc/mdstat \
  && pass "hot9's slice is an (S) spare of media-r1" || fail "hot9's slice is not a spare: \$(grep -A1 '^md' /proc/mdstat)"
EOF

# ---- P2: a spare that took over a rebuild cannot be removed -----------------
step "P2 — fail a member: md rebuilds onto the spare; removing 'the spare' is refused"
run_remote <<EOF
mdadm /dev/md/media-r1 --fail /dev/disk/by-id/${D7}-part1 </dev/null >/dev/null 2>&1
sleep 2
spare_k=\$(basename "\$(readlink -f /dev/disk/by-id/${D9}-part1)")
grep -qE "\$spare_k\[[0-9]+\]( |\$)" /proc/mdstat && ! grep -q "\$spare_k\[[0-9]*\](S)" /proc/mdstat \
  && pass "hot9's slice is an ACTIVE member now (no (S))" || fail "takeover did not happen: \$(cat /proc/mdstat)"
st=\$(api DELETE /ahr/media/spare/${D9})
check "DELETE spare answers 409 (got \$st)" test "\$st" = 409
check "…a CONFLICT, not a confirm challenge (\$(json "d['error']['code']"))" test "\$(json "d['error']['code']")" = CONFLICT
check "…and mints no confirm code" test -z "\$(confirm_code)"
echo "      \$(json "d['error']['message']")"
sleep 2
grep -qE "\$spare_k\[[0-9]+\]( |\$)" /proc/mdstat && ! grep -q "\$spare_k\[[0-9]*\](F)" /proc/mdstat \
  && pass "the slice is still in media-r1, never failed" || fail "the slice was touched: \$(cat /proc/mdstat)"
check "rebuild onto the former spare finished" wait_idle /dev/md/media-r1 600
EOF

# ---- P1: the foreign `media-r1` ---------------------------------------------
step "P1 — build a FOREIGN 'media-r1' from two loop devices (not pinned, own UUID)"
run_remote <<'EOF'
truncate -s 64M "$R/l0" "$R/l1"
L0=$(losetup -f --show "$R/l0"); L1=$(losetup -f --show "$R/l1")
mdadm --create "$FOREIGN_MD" --name=media-r1 --level=1 --raid-devices=2 --metadata=1.2 \
  --assume-clean --run "$L0" "$L1" </dev/null >"$R/create.log" 2>&1 || { fail "foreign create: $(cat "$R/create.log")"; exit 0; }
FU=$(uuid_of_md "$FOREIGN_MD")
echo "$FU" > "$R/foreign.uuid"
check "the foreign array is named media-r1" sh -c "mdadm --detail --export $FOREIGN_MD | grep -q '^MD_NAME=.*media-r1\$'"
check "the foreign array's UUID is NOT pinned" sh -c "! grep -qi '$FU' /etc/mdadm/mdadm.conf"
head -c 4194304 /dev/urandom > "$R/pattern"
dd if="$R/pattern" of="$FOREIGN_MD" bs=1M count=4 oflag=direct status=none
sha256sum < "$R/pattern" | cut -d' ' -f1 > "$R/foreign.sha"
# GT-8 shape: stop it and assemble ONE member — inactive, every member (S).
stop_md "$FOREIGN_MD"
# GT-8 ghost: one member present, the other gone, parked by INCREMENTAL
# assembly ("not enough to start safely") — an explicit `--assemble
# --no-degraded` of a lone member creates no array at all, and a plain
# assemble starts a RAID1 member degraded. Proven by hand 2026-10-06: the
# incremental ghost stays inactive for 40 s and across an anasd restart.
losetup -d "$L1"
mdadm --incremental "$L0" </dev/null >"$R/assemble.log" 2>&1
# Incremental assembly picks its own device (the ANAS pool's own media-r1
# holds /dev/md/media-r1, so the ghost lands beside it): read it from the log.
# Address the ghost by its KERNEL device (the md/ link mdadm names is not
# reliably created for an inactive array): the mdstat line holding L0.
GHOST=/dev/$(grep -E "^md[0-9]+ : .*$(basename "$L0")\[" /proc/mdstat | cut -d' ' -f1 | head -1)
echo "$GHOST" > "$R/ghost.dev"
GSTATE=$(array_state "${GHOST:-/nonexistent}"); echo "      ghost=$GHOST state=$GSTATE mdstat: $(grep -A1 "^md" /proc/mdstat | tr "\n" " ")"
check "the foreign array sits INACTIVE (GT-8 shape) at ${GHOST:-<none>} (state $GSTATE)" test -n "$GHOST" -a "$GSTATE" = inactive
EOF

step "P1 — the boot recovery ladder (anasd restart) leaves the foreign array alone"
SINCE="$($SSH_CMD "date '+%Y-%m-%d %H:%M:%S'")"
restart_daemon
run_remote <<EOF
GHOST=\$(cat "\$R/ghost.dev")
check "the foreign array is STILL inactive — never --run" test "\$(array_state "\$GHOST")" = inactive
journalctl -u anasd --since "${SINCE}" --no-pager -o cat > "\$R/boot.log" 2>/dev/null
if grep -E 'ahr\.boot array=media-r1 .*rung=mdadm-run' "\$R/boot.log" >/dev/null; then
  fail "the ladder ran on a media-r1: \$(grep 'ahr.boot' "\$R/boot.log")"
else
  pass "no ladder rung ran on any media-r1"
fi
grep -E 'ahr\.boot array=media-r1 .*(action=ignored|reason=not-pinned)' "\$R/boot.log" \
  && pass "the scan said why it left it alone" || echo "      (no ignore line — the inactive array exported no name; the state check above is the proof)"
# Bring the foreign array back fully for the destroy proof (re-attach L1).
stop_md "\$GHOST"
losetup -f "\$R/l1" 2>/dev/null
mdadm --assemble "\$FOREIGN_MD" \$(loops) </dev/null >"\$R/reassemble.log" 2>&1
echo "      reassemble: \$(cat "\$R/reassemble.log" | tr "\\n" " ") loops: \$(loops | tr "\\n" " ") md: \$(ls /dev/md/ 2>/dev/null | tr "\\n" " ")"
st=\$(array_state "\$FOREIGN_MD"); check "the foreign array is active again (state \$st)" test "\$st" != inactive -a "\$st" != absent
EOF

# ---- P3 setup + P1: destroy with a HALTED intent and the foreign array ------
step "P1/P3 — DELETE /v1/ahr/${POOL} (a HALTED intent on file, the foreign array running)"
run_remote <<'EOF'
api GET /ahr/media >/dev/null
OURS=$(json "','.join(a['uuid'] for a in d['data']['arrays'])")
mkdir -p /etc/anas/ahr
python3 - "$OURS" <<'PY'
import json, sys, uuid
cap = dict(rawBytes=0, usableBytes=0, usedBytes=0, freeBytes=0, redundancyOverheadBytes=0, unprotectedWastedBytes=0, pendingBytes=0)
intent = dict(id=str(uuid.uuid4()), trigger='add-disk', approvedDisks=['scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8'],
              before=cap, after=cap, state='halted', arrayUuids=[u for u in sys.argv[1].split(',') if u])
open('/etc/anas/ahr/media.json', 'w').write(json.dumps(intent))
PY
chmod 600 /etc/anas/ahr/media.json
api GET /ahr/media >/dev/null
check "the pool reads its own HALTED expansion before the destroy" test "$(json "d['data'].get('expansion', {}).get('state')")" = halted
st=$(confirmed DELETE /ahr/media)
check "destroy job completed ($st)" test "$st" = completed
echo "      result: $(json "json.dumps(d['job'].get('result'))")"
FU=$(cat "$R/foreign.uuid")
check "the job reported the foreign array as left alone" sh -c "python3 -c \"import json; r=json.load(open('$R/body'))['job']['result']; exit(0 if r.get('foreignArrays') else 1)\""
check "the ANAS pool is gone" test "$(api GET /ahr/media)" = 404
check "its pins left mdadm.conf" sh -c "! grep -q '^ARRAY /dev/md/media-r' /etc/mdadm/mdadm.conf"
check "its intent went with it" test ! -e /etc/anas/ahr/media.json
st=$(array_state "$FOREIGN_MD"); check "the foreign array is still running (state $st)" test "$st" != inactive -a "$st" != absent
check "…with the same UUID" test "$(uuid_of_md "$FOREIGN_MD")" = "$FU"
for lo in $(loops); do
  check "…and its member $lo still carries the foreign superblock" test "$(uuid_in "$lo")" = "$FU"
done
check "…and its data is byte-identical" test "$(head -c 4194304 "$FOREIGN_MD" | sha256sum | cut -d' ' -f1)" = "$(cat "$R/foreign.sha")"
EOF

# ---- P1: create refuses the occupied name ------------------------------------
step "P1 — POST /v1/ahr refuses '${POOL}' while the foreign media-r1 carries the name"
run_remote <<EOF
st=\$(api POST /ahr '{"name":"media","tier":"ahr1","disks":["${D7}","${D8}"]}')
check "create answers 409 (got \$st)" test "\$st" = 409
check "…naming the foreign array" sh -c "grep -q 'media-r1' \$R/body && grep -q 'already in use' \$R/body"
check "…before any confirm code" test -z "\$(confirm_code)"
# The foreign array leaves the node.
stop_md "\$FOREIGN_MD"
for lo in \$(loops); do mdadm --zero-superblock "\$lo" </dev/null 2>/dev/null; losetup -d "\$lo"; done
rm -f "\$R"/l0 "\$R"/l1
EOF

# ---- P3: recreate — no stale intent ------------------------------------------
step "P3 — recreate '${POOL}' under the same name: no stale intent"
run_remote <<EOF
st=\$(confirmed POST /ahr '{"name":"media","tier":"ahr1","disks":["${D7}","${D8}"]}')
check "recreate job completed (\$st)" test "\$st" = completed
api GET /ahr/media >/dev/null
check "the recreated pool carries no expansion" test "\$(json "d['data'].get('expansion')")" = None
check "…and no HALTED advisory" sh -c "! grep -q HALTED \$R/body"
# A record an EARLIER pool of this name left behind reads as stale, never halted.
mkdir -p /etc/anas/ahr
python3 - <<'PY'
import json, uuid
cap = dict(rawBytes=0, usableBytes=0, usedBytes=0, freeBytes=0, redundancyOverheadBytes=0, unprotectedWastedBytes=0, pendingBytes=0)
intent = dict(id=str(uuid.uuid4()), trigger='add-disk', approvedDisks=['scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9'],
              before=cap, after=cap, state='halted', arrayUuids=['00000000:00000000:00000000:00000001'])
open('/etc/anas/ahr/media.json', 'w').write(json.dumps(intent))
PY
api GET /ahr/media >/dev/null
check "a stale record is not this pool's expansion" test "\$(json "d['data'].get('expansion')")" = None
check "…and raises no HALTED advisory" sh -c "! grep -q HALTED \$R/body"
check "resume finds nothing to resume (409)" test "\$(api POST /ahr/media/expand/resume '{}')" = 409
rm -f /etc/anas/ahr/media.json
st=\$(confirmed DELETE /ahr/media)
check "final destroy job completed (\$st)" test "\$st" = completed
EOF

step "teardown"
node_teardown
for n in "${DISKS[@]}"; do attached "$n" && "$SCRIPT_DIR/remove-disk.sh" "$n" || true; done

echo
passes=$(grep -c '^PASS:' "$LOG" || true)
fails=$(grep -c '^FAIL:' "$LOG" || true)
echo "ident.3 live proof: ${passes} passed, ${fails} failed"
[ "$fails" -eq 0 ]

#!/usr/bin/env bash
#
# Tests for packaging/uninstall.sh remove_schedule_units (review F2/F8): the
# uninstaller removes ALL FIVE ANAS schedule unit families (anas-snap-*,
# anas-backup-*, anas-repl-*, anas-cloud-*, anas-scrub.*) — their runners are
# gone with
# /opt/anas, and a timer firing a missing runner is worse than a lost schedule —
# and RESTORES mdadm's mdcheck timers when it removed the scrub timer (ruling
# 2026-09-14, reversing review F2): those timers are enabled by default on a
# stock node, so turning them back on returns the node to the distro default
# rather than guessing at its history. The scrub removal prints that it did,
# and how to turn them off again.
#
# uninstall.sh is sourced in ANAS_UNINSTALL_LIB_ONLY mode (the install.sh
# pattern) with a throwaway SYSTEMD_DIR/stamp dir and a faked systemctl that
# records every argv — no root, no real node.
#
#   bash packaging/test/uninstall-schedules.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNINSTALL="${HERE}/../uninstall.sh"

PASS=0
FAIL=0
check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  ok   ${desc}"; PASS=$((PASS + 1))
  else
    echo "  FAIL ${desc}"; FAIL=$((FAIL + 1))
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

SYSTEMD_DIR="${WORK}/systemd"
STAMPS="${WORK}/timers"
SYSTEMCTL="${WORK}/systemctl"
mkdir -p "${SYSTEMD_DIR}" "${STAMPS}"

# Faked systemctl: record argv, always succeed.
cat > "${SYSTEMCTL}" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${WORK}/systemctl.log"
exit 0
EOF
chmod +x "${SYSTEMCTL}"

# Source the uninstaller in lib mode and expose remove_schedule_units.
source_uninstall() {
  : > "${WORK}/systemctl.log"
  PATH="$(dirname "${SYSTEMCTL}"):${PATH}" \
    SYSTEMD_DIR="${SYSTEMD_DIR}" TIMERS_STAMP_DIR="${STAMPS}" \
    ANAS_UNINSTALL_LIB_ONLY=1 bash -c "source '${UNINSTALL}'; remove_schedule_units"
}

# Fixture: one unit pair from EVERY family a fully-scheduled node would carry,
# including Persistent stamps.
make_units() {
  : > "${WORK}/systemctl.log"
  rm -rf "${SYSTEMD_DIR}" "${STAMPS}"
  mkdir -p "${SYSTEMD_DIR}" "${STAMPS}"
  printf '[Service]\n' > "${SYSTEMD_DIR}/anas-scrub.service"
  printf '[Timer]\n'   > "${SYSTEMD_DIR}/anas-scrub.timer"
  : > "${STAMPS}/stamp-anas-scrub.timer"
  for n in nightly hourly; do
    for fam in snap backup repl; do
      printf '[Service]\n' > "${SYSTEMD_DIR}/anas-${fam}-${n}.service"
      printf '[Timer]\n'   > "${SYSTEMD_DIR}/anas-${fam}-${n}.timer"
      : > "${STAMPS}/stamp-anas-${fam}-${n}.timer"
    done
  done
  make_cloud_units
}

# A scheduled cloud sync task's units as services/cloud-units.ts writes them
# (cr.61, review M9 / W5): `anas-cloud-<name>.{service,timer}`, the runner in
# /opt/anas, the task JSON in an X-ANAS-Task= comment, a Persistent stamp.
make_cloud_units() {
  local n
  for n in offsite photos; do
    cat > "${SYSTEMD_DIR}/anas-cloud-${n}.service" <<UNIT
[Unit]
Description=ANAS cloud sync task ${n}
# X-ANAS-Task={"name":"${n}"}

[Service]
Type=oneshot
ExecStart=/usr/bin/node /opt/anas/packages/daemon/dist/cloud-task.js ${n}
UNIT
    printf '[Timer]\nOnCalendar=daily\nPersistent=true\n' > "${SYSTEMD_DIR}/anas-cloud-${n}.timer"
    : > "${STAMPS}/stamp-anas-cloud-${n}.timer"
  done
}

echo "== 1. all four families removed =="
make_units
source_uninstall
check "anas-scrub.timer disabled before removal" \
  grep -q 'disable --now anas-scrub.timer' "${WORK}/systemctl.log"
check "both scrub unit files removed" \
  bash -c "! test -e '${SYSTEMD_DIR}/anas-scrub.timer' && ! test -e '${SYSTEMD_DIR}/anas-scrub.service'"
check "the scrub timer's Persistent stamp removed" \
  bash -c "! test -e '${STAMPS}/stamp-anas-scrub.timer'"
for fam in snap backup repl; do
  check "${fam} unit pairs + stamps removed" \
    bash -c "! test -e '${SYSTEMD_DIR}/anas-${fam}-nightly.timer' && ! test -e '${SYSTEMD_DIR}/anas-${fam}-nightly.service' && ! test -e '${STAMPS}/stamp-anas-${fam}-nightly.timer'"
  check "${fam} timer disabled" \
    grep -q "disable --now anas-${fam}-nightly.timer" "${WORK}/systemctl.log"
done

echo "== 1b. the cloud sync family is removed too (M9) =="
for n in offsite photos; do
  check "cloud ${n}: timer disabled before removal" \
    grep -q "disable --now anas-cloud-${n}.timer" "${WORK}/systemctl.log"
  check "cloud ${n}: unit pair + stamp removed" \
    bash -c "! test -e '${SYSTEMD_DIR}/anas-cloud-${n}.timer' && ! test -e '${SYSTEMD_DIR}/anas-cloud-${n}.service' && ! test -e '${STAMPS}/stamp-anas-cloud-${n}.timer'"
done
check "no anas-cloud-* unit file left at all" \
  bash -c "! ls '${SYSTEMD_DIR}'/anas-cloud-* >/dev/null 2>&1"

echo "== 2. mdcheck is RESTORED to the distro default =="
check "both mdcheck timers re-enabled, --now" \
  grep -q 'enable --now mdcheck_start.timer mdcheck_continue.timer' "${WORK}/systemctl.log"
check "…and never disabled on the way out" \
  bash -c "! grep -qE 'disable.*mdcheck' '${WORK}/systemctl.log'"

echo "== 3. the restore line is printed =="
make_units
PATH="$(dirname "${SYSTEMCTL}"):$PATH" SYSTEMD_DIR="${SYSTEMD_DIR}" TIMERS_STAMP_DIR="${STAMPS}" \
  ANAS_UNINSTALL_LIB_ONLY=1 bash -c "source '${UNINSTALL}'; remove_schedule_units" > "${WORK}/out.log" 2>&1
check "scrub removal line names the family and count" \
  grep -F 'removed 1 ANAS schedule unit pair (anas-scrub.*)' "${WORK}/out.log"
check "the restore is stated, and named as the distro default" \
  bash -c "grep -q 'has been RESTORED' '${WORK}/out.log' && grep -q 'distro default' '${WORK}/out.log'"
check "no stale NOT-been-re-enabled admission" \
  bash -c "! grep -q 'has NOT been re-enabled' '${WORK}/out.log'"
check "the way to turn it back OFF is printed" \
  grep -q 'systemctl disable --now mdcheck_start.timer mdcheck_continue.timer' "${WORK}/out.log"
check "per-family count lines printed" \
  bash -c "grep -q 'anas-snap-\*' '${WORK}/out.log' && grep -q 'anas-backup-\*' '${WORK}/out.log' && grep -q 'anas-repl-\*' '${WORK}/out.log'"

echo "== 3b. a MASKED mdcheck is reported as NOT restored (N7) =="
# `systemctl enable --now` ends in `|| true`, so a masked or missing mdcheck
# unit used to print "has been RESTORED" anyway — the node left with no
# periodic md parity check at all, and the uninstaller saying the opposite.
MASKING_SYSTEMCTL="${WORK}/systemctl-masked"
cat > "${MASKING_SYSTEMCTL}" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${WORK}/systemctl.log"
# Everything succeeds EXCEPT enabling the mdcheck timers (masked unit).
case "\$*" in
  *enable*mdcheck*) printf 'Failed to enable unit: Unit file mdcheck_start.timer is masked.\n' >&2; exit 1 ;;
esac
exit 0
EOF
chmod +x "${MASKING_SYSTEMCTL}"
mkdir -p "${WORK}/maskedbin"
cp "${MASKING_SYSTEMCTL}" "${WORK}/maskedbin/systemctl"

make_units
PATH="${WORK}/maskedbin:$PATH" SYSTEMD_DIR="${SYSTEMD_DIR}" TIMERS_STAMP_DIR="${STAMPS}" \
  ANAS_UNINSTALL_LIB_ONLY=1 bash -c "source '${UNINSTALL}'; remove_schedule_units" > "${WORK}/masked.log" 2>&1
check "it was TRIED" \
  grep -q 'enable --now mdcheck_start.timer mdcheck_continue.timer' "${WORK}/systemctl.log"
check "no false RESTORED claim" \
  bash -c "! grep -q 'has been RESTORED' '${WORK}/masked.log'"
check "it says what it could not do, and what that leaves" \
  bash -c "grep -q 'could not be re-enabled (masked or not installed)' '${WORK}/masked.log' && grep -q 'no periodic md parity check' '${WORK}/masked.log'"
check "and how to put it right by hand" \
  grep -q 'systemctl enable --now mdcheck_start.timer mdcheck_continue.timer' "${WORK}/masked.log"
check "the scrub units are removed either way" \
  bash -c "! test -e '${SYSTEMD_DIR}/anas-scrub.timer' && ! test -e '${SYSTEMD_DIR}/anas-scrub.service'"

echo "== 4. a node with no scrub units prints no mdcheck line =="
make_units
rm -f "${SYSTEMD_DIR}/anas-scrub.timer" "${SYSTEMD_DIR}/anas-scrub.service" "${STAMPS}/stamp-anas-scrub.timer"
source_uninstall > "${WORK}/out2.log" 2>&1
check "no mdcheck mention without a removed scrub timer" \
  bash -c "! grep -q 'mdcheck' '${WORK}/out2.log'"
check "other families still removed" \
  bash -c "! test -e '${SYSTEMD_DIR}/anas-snap-nightly.timer' && ! test -e '${SYSTEMD_DIR}/anas-backup-hourly.timer'"

echo "== 4b. a node with ONLY cloud tasks still gets them removed =="
rm -rf "${SYSTEMD_DIR}" "${STAMPS}"
mkdir -p "${SYSTEMD_DIR}" "${STAMPS}"
make_cloud_units
source_uninstall > "${WORK}/cloud-only.log" 2>&1
check "both cloud unit pairs gone" \
  bash -c "! ls '${SYSTEMD_DIR}'/anas-cloud-* >/dev/null 2>&1"
check "the family and its count are printed" \
  grep -F 'removed 2 ANAS schedule unit pair(s) (anas-cloud-*)' "${WORK}/cloud-only.log"

echo "== 5. idempotent — a second run is clean =="
make_units
source_uninstall >/dev/null 2>&1
: > "${WORK}/systemctl.log"
source_uninstall >/dev/null 2>&1
check "second run issues no mdcheck or anas-scrub systemctl calls" \
  bash -c "! grep -q mdcheck '${WORK}/systemctl.log' && ! grep -q anas-scrub '${WORK}/systemctl.log'"
check "second run leaves no units" \
  bash -c "! test -e '${SYSTEMD_DIR}/anas-scrub.timer' && ! test -e '${SYSTEMD_DIR}/anas-snap-nightly.service'"

echo
echo "uninstall-schedules tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]

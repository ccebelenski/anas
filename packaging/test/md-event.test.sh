#!/usr/bin/env bash
#
# Tests for packaging/anas-md-event.sh (story 11.17): the RebuildFinished
# bad-block check + scrub recommendation. The real hook runs against a faked
# sysfs tree (ANAS_MD_SYSFS_BLOCK) with `logger` and `perl` shimmed onto PATH
# to capture what would hit journald and PVE::Notify — no mdadm, no root.
#
# Covers:
#   1. RebuildFinished + recorded bad blocks -> BADBLOCKS=N in the journald
#      line, WARNING severity, pointed "identify affected files" advice.
#   2. RebuildFinished + clean BBL -> BADBLOCKS=0, info severity, "exact"
#      wording + precaution note.
#   3. RebuildFinished + unreadable sysfs -> no BADBLOCKS key, info severity,
#      generic precaution note (fail-open).
#   4. Other events (Fail) unchanged: no scrub note, warning severity.
#   5. Usage error still exits 64.
#
#   bash packaging/test/md-event.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${HERE}/../anas-md-event.sh"

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

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# --- shims: capture logger/perl argv, one line each -------------------------
mkdir -p "${TMP}/bin"
cat > "${TMP}/bin/logger" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "${TMP}/logger.log"
EOF
cat > "${TMP}/bin/perl" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "${TMP}/perl.log"
EOF
chmod +x "${TMP}/bin/logger" "${TMP}/bin/perl"

# --- fake sysfs: md127 with three members ------------------------------------
SYS="${TMP}/sys/block"
for m in dev-sda1 dev-sdb1 dev-sdc1; do
  mkdir -p "${SYS}/md127/md/${m}"
done

run_hook() { # run_hook <event> <device> [member]
  : > "${TMP}/logger.log"; : > "${TMP}/perl.log"
  PATH="${TMP}/bin:${PATH}" ANAS_MD_SYSFS_BLOCK="${SYS}" sh "${HOOK}" "$@"
}

echo "== 1. RebuildFinished with recorded bad blocks =="
printf '17920 8\n25600 16\n' > "${SYS}/md127/md/dev-sda1/bad_blocks"
printf '99999 8\n'           > "${SYS}/md127/md/dev-sdb1/bad_blocks"
: >                            "${SYS}/md127/md/dev-sdc1/bad_blocks"
run_hook RebuildFinished /dev/md127
check "exit 0"                          test "$?" -eq 0
check "journald line has BADBLOCKS=3"   grep -q 'EVENT=RebuildFinished DEVICE=/dev/md127 BADBLOCKS=3' "${TMP}/logger.log"
check "notify severity escalated"       grep -q ' warning md RebuildFinished' "${TMP}/perl.log"
check "note counts the ranges"          grep -q '3 unreadable sector range' "${TMP}/perl.log"
check "note says data was lost"         grep -q 'could not be reconstructed' "${TMP}/perl.log"
check "note recommends a Scrub"         grep -q 'Run a Scrub on this pool to identify any affected files' "${TMP}/perl.log"

echo "== 2. RebuildFinished with a clean BBL =="
for m in dev-sda1 dev-sdb1 dev-sdc1; do : > "${SYS}/md127/md/${m}/bad_blocks"; done
run_hook RebuildFinished /dev/md127
check "journald line has BADBLOCKS=0"   grep -q 'BADBLOCKS=0' "${TMP}/logger.log"
check "notify severity stays info"      grep -q ' info md RebuildFinished' "${TMP}/perl.log"
check "note says rebuild was exact"     grep -q 'reconstructed everything exactly' "${TMP}/perl.log"
check "still offers the precaution"     grep -q 'Scrub will verify all data checksums' "${TMP}/perl.log"

echo "== 3. RebuildFinished with unreadable sysfs (fail-open) =="
run_hook RebuildFinished /dev/md_no_such
check "exit 0 despite missing sysfs"    test "$?" -eq 0
check "no BADBLOCKS key logged"         bash -c "! grep -q 'BADBLOCKS=' '${TMP}/logger.log'"
check "notify severity stays info"      grep -q ' info md RebuildFinished' "${TMP}/perl.log"
check "generic precaution note"         grep -q 'run a Scrub on this pool to verify all data checksums' "${TMP}/perl.log"

echo "== 4. Fail event unchanged =="
run_hook Fail /dev/md127 /dev/sda1
check "warning severity"                grep -q ' warning md Fail' "${TMP}/perl.log"
check "member in journald line"         grep -q 'EVENT=Fail DEVICE=/dev/md127 MEMBER=/dev/sda1' "${TMP}/logger.log"
check "no scrub note on Fail"           bash -c "! grep -q 'Scrub' '${TMP}/perl.log'"
check "no BADBLOCKS on Fail"            bash -c "! grep -q 'BADBLOCKS' '${TMP}/logger.log'"

echo "== 5. usage error =="
PATH="${TMP}/bin:${PATH}" sh "${HOOK}" OnlyOneArg; RC=$?
check "exits 64"                        test "${RC}" -eq 64

# mdadm --monitor names EVERY sync op Rebuild* — a finished CHECK (the
# scheduled scrub) must be reported as a routine check, not a rebuild.
echo "== 6. RebuildFinished after a clean check window =="
printf 'check\n' > "${SYS}/md127/md/last_sync_action"
printf '0\n'     > "${SYS}/md127/md/mismatch_cnt"
printf '17920 8\n' > "${SYS}/md127/md/dev-sda1/bad_blocks"   # must be IGNORED for a check
run_hook RebuildFinished /dev/md127
check "journald has ACTION=check"       grep -q 'ACTION=check' "${TMP}/logger.log"
check "journald has MISMATCHES=0"       grep -q 'MISMATCHES=0' "${TMP}/logger.log"
check "no BADBLOCKS on a check"         bash -c "! grep -q 'BADBLOCKS' '${TMP}/logger.log'"
check "title says check finished"       grep -q 'md check finished: /dev/md127' "${TMP}/perl.log"
check "severity stays info"             grep -q ' info md check finished' "${TMP}/perl.log"
check "says routine, no disk rebuilt"   grep -q 'routine, no disk was rebuilt' "${TMP}/perl.log"
check "explains resume-in-windows"      grep -q 'resume in daily windows' "${TMP}/perl.log"
check "reports zero mismatches"         grep -q 'No parity mismatches were counted' "${TMP}/perl.log"
check "no rebuild wording"              bash -c "! grep -q 'reconstructed everything exactly' '${TMP}/perl.log'"

echo "== 7. RebuildFinished after a check that found mismatches =="
printf '384\n' > "${SYS}/md127/md/mismatch_cnt"
run_hook RebuildFinished /dev/md127
check "journald has MISMATCHES=384"     grep -q 'MISMATCHES=384' "${TMP}/logger.log"
check "severity escalated to warning"   grep -q ' warning md check finished' "${TMP}/perl.log"
check "counts the mismatches"           grep -q '384 parity mismatch' "${TMP}/perl.log"
check "recommends an ANAS Scrub"        grep -q 'run a Scrub on this pool so btrfs checksums can identify' "${TMP}/perl.log"

echo "== 8. Rebuild progress event carries ACTION in journald =="
run_hook Rebuild20 /dev/md127
check "journald has ACTION=check"       grep -q 'EVENT=Rebuild20 DEVICE=/dev/md127 ACTION=check' "${TMP}/logger.log"
check "progress events do not notify"   bash -c "! test -s '${TMP}/perl.log'"

echo "== 9. real rebuild (recover) still reports the BBL outcome =="
printf 'recover\n' > "${SYS}/md127/md/last_sync_action"
: > "${SYS}/md127/md/dev-sda1/bad_blocks"
run_hook RebuildFinished /dev/md127
check "journald has ACTION=recover"     grep -q 'ACTION=recover' "${TMP}/logger.log"
check "BBL outcome reported"            grep -q 'BADBLOCKS=0' "${TMP}/logger.log"
check "rebuild wording kept"            grep -q 'reconstructed everything exactly' "${TMP}/perl.log"

echo
echo "md-event tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]

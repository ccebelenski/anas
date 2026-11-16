#!/usr/bin/env bash
#
# cr3.core: packaging/uninstall.sh
#
#   ORDER  the PVE UI integration (whose uninstaller restarts pveproxy, which
#          kills a shell running inside pveproxy's cgroup: the PVE web shell)
#          is reverted LAST, after every unit, schedule timer, hook, template
#          and the env file, and just before the prefix that holds it. Before
#          it ran second, and a web-shell uninstall died with everything else
#          still in place.
#   L7     the mdadm.conf PROGRAM line pointing at ANAS's md-event hook is
#          retired with the hook (only that exact line, every other byte kept,
#          the monitor restarted); surviving AHR read caches are named, since
#          their automatic recovery leaves with ANAS.
#
# The order is read from the script (its main body needs root); the L7
# functions run in ANAS_UNINSTALL_LIB_ONLY mode against a throwaway tree with
# systemctl and lsblk faked.
#
#   bash packaging/test/uninstall-order.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNINSTALL="${HERE}/../uninstall.sh"

PASS=0
FAIL=0
ok()   { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

WORK="$(mktemp -d -p "${ANAS_TEST_TMPDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}" .scratch.XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT

# Line number of the first line matching the fixed string $1 at the start of a
# command (not inside a comment).
line_of() {
  grep -nF -- "$1" "${UNINSTALL}" | grep -v '^[0-9]*:[[:space:]]*#' | head -n1 | cut -d: -f1
}

echo "== ORDER: the UI integration (pveproxy restart) is reverted after everything else, before the prefix =="
UI="$(line_of '"${PREFIX}/packages/pve-integration/uninstall.sh" || true')"
# The prefix is removed by remove_prefix; its CALL (a line that is only the
# name), not its definition, is the step whose order matters.
RM_PREFIX="$(grep -nx 'remove_prefix' "${UNINSTALL}" | head -n1 | cut -d: -f1)"
check "the integration revert is found" "[ -n '${UI}' ]"
for step in \
  'systemctl disable --now anasd anas' \
  'rm -f "${SYSTEMD_DIR}/${u}.service"' \
  'remove_schedule_units' \
  'remove_recycle_units' \
  'rm -f "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}"' \
  'systemctl daemon-reload' \
  'rm -f "${HOOK_DEST}"' \
  'rm -f "${CACHE_RULE_DEST}"' \
  'rm -f "${PVE_TEMPLATE_DIR}/${tpl}"' \
  'rm -f "${ANAS_ENV_FILE}"'; do
  n="$(line_of "${step}")"
  check "'${step}' (line ${n:-?}) runs before the integration revert (line ${UI:-?})" "[ -n '${n}' ] && [ '${n}' -lt '${UI}' ]"
done
check "the integration revert (line ${UI:-?}) runs before the prefix is removed (line ${RM_PREFIX:-?})" "[ '${UI}' -lt '${RM_PREFIX}' ]"

# Fakes: systemctl records its argv; lsblk prints the labels in LSBLK_OUT.
mkdir -p "${WORK}/bin"
cat > "${WORK}/bin/systemctl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${WORK}/systemctl.log"
exit 0
EOF
cat > "${WORK}/bin/lsblk" <<'EOF'
#!/usr/bin/env bash
printf '%s' "${LSBLK_OUT:-}"
EOF
chmod +x "${WORK}/bin/systemctl" "${WORK}/bin/lsblk"
for _tool in apt apt-get dpkg update-initramfs pveproxy service udevadm; do
  printf '#!/bin/sh\nexit 0\n' > "${WORK}/bin/${_tool}"
  chmod +x "${WORK}/bin/${_tool}"
done

run_lib() {
  : > "${WORK}/systemctl.log"
  PATH="${WORK}/bin:${PATH}" MDADM_CONF="${WORK}/mdadm.conf" \
    ANAS_UNINSTALL_LIB_ONLY=1 bash -c "[ \"\$(command -v systemctl)\" = '${WORK}/bin/systemctl' ] || exit 99; source '${UNINSTALL}'; $1" > "${WORK}/out.log" 2>&1
}

HOOK=/usr/local/bin/anas-md-event

echo "== L7: the PROGRAM line pointing at ANAS's hook is retired, every other byte kept =="
cat > "${WORK}/mdadm.conf" <<EOF
# mdadm.conf
HOMEHOST <system>
MAILADDR root
ARRAY /dev/md/tank-r0 metadata=1.2 UUID=11111111:22222222:33333333:44444444 name=pve:tank-r0
PROGRAM ${HOOK}
ARRAY /dev/md0 metadata=1.2 UUID=aaaaaaaa:bbbbbbbb:cccccccc:dddddddd
EOF
chmod 0640 "${WORK}/mdadm.conf"
grep -vx "PROGRAM ${HOOK}" "${WORK}/mdadm.conf" > "${WORK}/expected.conf"
run_lib "retire_md_program_hook '${HOOK}'"
check "the PROGRAM line is gone" "! grep -q '^PROGRAM' '${WORK}/mdadm.conf'"
check "every other line is byte-identical (ARRAY pins, MAILADDR, comments)" "cmp -s '${WORK}/expected.conf' '${WORK}/mdadm.conf'"
check "the file keeps its mode" "[ \"\$(stat -c %a '${WORK}/mdadm.conf')\" = 640 ]"
check "the running monitor is restarted to drop the hook" "grep -qx 'try-restart mdmonitor.service' '${WORK}/systemctl.log'"
check "it says what it removed" "grep -q 'PROGRAM ${HOOK}' '${WORK}/out.log'"
check "no temp file is left beside it" "[ -z \"\$(ls -A '${WORK}' | grep 'mdadm.conf.anas')\" ]"

echo "== L7: an operator's own PROGRAM line is not ours =="
printf 'MAILADDR root\nPROGRAM /usr/local/sbin/my-hook\n' > "${WORK}/mdadm.conf"
cp "${WORK}/mdadm.conf" "${WORK}/expected.conf"
run_lib "retire_md_program_hook '${HOOK}'"
check "the foreign PROGRAM line survives, file untouched" "cmp -s '${WORK}/expected.conf' '${WORK}/mdadm.conf'"
check "the monitor is not restarted" "[ ! -s '${WORK}/systemctl.log' ]"

echo "== L7: a hook path that only LOOKS like ours (a regex metacharacter) is not matched =="
printf 'PROGRAM /usr/local/bin/anasXmd-event\n' > "${WORK}/mdadm.conf"
cp "${WORK}/mdadm.conf" "${WORK}/expected.conf"
run_lib "retire_md_program_hook '/usr/local/bin/anas.md-event'"
check "a '.' in the hook path is a literal dot" "cmp -s '${WORK}/expected.conf' '${WORK}/mdadm.conf'"

echo "== L7: no mdadm.conf at all is a no-op =="
rm -f "${WORK}/mdadm.conf"
run_lib "retire_md_program_hook '${HOOK}'"; rc=$?
check "exits 0" "[ ${rc} -eq 0 ]"
check "creates nothing" "[ ! -e '${WORK}/mdadm.conf' ]"

echo "== cr3 review 3: which lines are ANAS's (the daemon's own reading), and a byte-safe, checked rewrite =="
U=11111111:22222222:33333333:44444444
# md_case <label> <printf %b input> <line numbers removed, space-separated, or -> [locale] [extra shell before the call]
md_case() {
  local label="$1" input="$2" removed="$3" loc="${4:-C.UTF-8}" extra="${5:-}" d expr="" n
  d="${WORK}/md.$((++MD_N))"; mkdir -p "${d}"
  printf '%b' "${input}" > "${d}/mdadm.conf"; chmod 0640 "${d}/mdadm.conf"
  cp -p "${d}/mdadm.conf" "${d}/before"
  if [ "${removed}" = "-" ]; then cp "${d}/before" "${d}/expected"
  else for n in ${removed}; do expr="${expr} -e ${n}d"; done; LC_ALL=C sed ${expr} "${d}/before" > "${d}/expected"; fi
  : > "${WORK}/systemctl.log"
  PATH="${WORK}/bin:${PATH}" MDADM_CONF="${d}/mdadm.conf" LANG="${loc}" LC_ALL="${loc}" \
    ANAS_UNINSTALL_LIB_ONLY=1 bash -c "[ \"\$(command -v systemctl)\" = '${WORK}/bin/systemctl' ] || exit 99; source '${UNINSTALL}'; ${extra:-:}; retire_md_program_hook '${HOOK}'" > "${d}/out" 2>&1
  if [ "${removed}" = "-" ]; then
    check "${label}: untouched (bytes and inode), monitor not restarted" "cmp -s '${d}/before' '${d}/mdadm.conf' && [ \"\$(stat -c %i '${d}/before')\" != '' ] && [ ! -s '${WORK}/systemctl.log' ]"
  else
    check "${label}: exactly line(s) ${removed} removed, every other byte kept" "cmp -s '${d}/expected' '${d}/mdadm.conf'"
    check "${label}: mode kept, monitor restarted" "[ \"\$(stat -c %a '${d}/mdadm.conf')\" = 640 ] && grep -qx 'try-restart mdmonitor.service' '${WORK}/systemctl.log'"
  fi
  check "${label}: no temp file left" "[ -z \"\$(ls -A '${d}' | grep anas)\" ]"
}
MD_N=0
md_case "01 ours, exact" "MAILADDR root\nARRAY /dev/md/tank-r1 metadata=1.2 UUID=$U\nPROGRAM $HOOK\n" "3"
md_case "02 trailing spaces" "ARRAY /dev/md/tank-r1 UUID=$U\nPROGRAM $HOOK   \n" "2"
md_case "03 trailing # comment" "ARRAY /dev/md/tank-r1 UUID=$U\nPROGRAM $HOOK # anas\n" "2"
md_case "04 commented out" "ARRAY /dev/md/tank-r1 UUID=$U\n#PROGRAM $HOOK\n" "-"
md_case "05 foreign program" "ARRAY /dev/md/tank-r1 UUID=$U\nPROGRAM /usr/sbin/myhook\n" "-"
md_case "06 a longer path (-old)" "ARRAY /dev/md/tank-r1 UUID=$U\nPROGRAM ${HOOK}-old\n" "-"
md_case "07 CRLF file" "MAILADDR root\r\nARRAY /dev/md/tank-r1 UUID=$U\r\nPROGRAM $HOOK\r\n" "3"
md_case "08 ours last, no final newline" "ARRAY /dev/md/tank-r1 UUID=$U\nPROGRAM $HOOK" "2"
md_case "09 ours first, the last line without a newline keeps none" "PROGRAM $HOOK\nARRAY /dev/md/tank-r1 UUID=$U" "1"
md_case "10 an indented continuation line (the daemon does not read it)" "ARRAY /dev/md/tank-r1 UUID=$U\n  PROGRAM $HOOK\n" "-"
md_case "11 lower-case keyword" "ARRAY /dev/md/tank-r1 UUID=$U\nprogram $HOOK\n" "2"
md_case "11b abbreviated PROG" "ARRAY /dev/md/tank-r1 UUID=$U\nPROG $HOOK\n" "2"
md_case "11c abbreviated pro (three letters)" "ARRAY /dev/md/tank-r1 UUID=$U\npro $HOOK\n" "2"
md_case "11d 'pr' is no keyword" "ARRAY /dev/md/tank-r1 UUID=$U\npr $HOOK\n" "-"
md_case "11e 'PROGRAMS' is no keyword" "ARRAY /dev/md/tank-r1 UUID=$U\nPROGRAMS $HOOK\n" "-"
md_case "12 TAB separated" "ARRAY /dev/md/tank-r1 UUID=$U\nPROGRAM\t$HOOK\n" "2"
md_case "13 ours twice" "PROGRAM $HOOK\nARRAY /dev/md/tank-r1 UUID=$U\nPROGRAM $HOOK\n" "1 3"
md_case "14 only our line" "PROGRAM $HOOK\n" "1"
md_case "15 a Latin-1 comment (0xE9), UTF-8 locale" "# Configuration de l'h\xe9te\nARRAY /dev/md/tank-r1 UUID=$U\nPROGRAM $HOOK\nARRAY /dev/md/tank-r2 UUID=$U\n" "3" "en_US.UTF-8"
md_case "16 a Latin-1 comment, C locale" "# h\xe9te\nARRAY /dev/md/tank-r1 UUID=$U\nPROGRAM $HOOK\n" "3" "C"
md_case "17 a NUL byte in a comment" "# a\x00b\nARRAY /dev/md/tank-r1 UUID=$U\nPROGRAM $HOOK\nARRAY /dev/md/tank-r2 UUID=$U\n" "3"
BIG="$(head -c 3000 /dev/zero | tr '\0' 'x' | fold -w 60 | sed 's/^/# /' | sed 's/$/\\n/' | tr -d '\n')"
md_case "18 the temp write fails (EFBIG, as ENOSPC would)" "${BIG}ARRAY /dev/md/tank-r1 UUID=$U\nPROGRAM $HOOK\n" "-" "C.UTF-8" 'trap "" XFSZ; ulimit -f 1'
check "18 the failure is said, naming the file" "grep -q 'could not rewrite' '${WORK}/md.${MD_N}/out'"
# 19: mdadm.conf is a symlink to the real file.
d="${WORK}/md.link"; mkdir -p "${d}"
printf 'ARRAY /dev/md/tank-r1 UUID=%s\nPROGRAM %s\n' "$U" "$HOOK" > "${d}/real"; chmod 0600 "${d}/real"
ln -s real "${d}/mdadm.conf"
: > "${WORK}/systemctl.log"
PATH="${WORK}/bin:${PATH}" MDADM_CONF="${d}/mdadm.conf" ANAS_UNINSTALL_LIB_ONLY=1 \
  bash -c "[ \"\$(command -v systemctl)\" = '${WORK}/bin/systemctl' ] || exit 99; source '${UNINSTALL}'; retire_md_program_hook '${HOOK}'" > "${d}/out" 2>&1
check "19 a symlinked mdadm.conf stays the same link" "[ -L '${d}/mdadm.conf' ] && [ \"\$(readlink '${d}/mdadm.conf')\" = real ]"
check "19 the target lost exactly our line and keeps its mode" "[ \"\$(cat '${d}/real')\" = 'ARRAY /dev/md/tank-r1 UUID=$U' ] && [ \"\$(stat -c %a '${d}/real')\" = 600 ]"

echo "== L7: surviving AHR read caches are named, with the manual recovery =="
LSBLK_OUT=$'\nEFI\ntank-cache1\ntank-d0-b1\n' run_lib "warn_surviving_ahr_caches"
check "names the cache slice" "grep -q 'tank-cache1' '${WORK}/out.log'"
check "does not name a band member slice" "! grep -q 'tank-d0-b1' '${WORK}/out.log'"
check "says how to recover by hand" "grep -q 'lvconvert --uncache' '${WORK}/out.log'"
LSBLK_OUT=$'EFI\ntank-d0-b1\n' run_lib "warn_surviving_ahr_caches"
check "says nothing when no cache slice remains" "[ ! -s '${WORK}/out.log' ]"

echo "== cr4 3e: a symlinked env file: the link goes, the file stays, the log says so =="
d="${WORK}/env.link"; mkdir -p "${d}"
printf 'ANAS_PORT=3005\n' > "${d}/real-anas"
ln -s real-anas "${d}/default-anas"
ANAS_ENV_FILE="${d}/default-anas" ANAS_UNINSTALL_LIB_ONLY=1 \
  bash -c "source '${UNINSTALL}'; remove_env_file" > "${d}/out" 2>&1
check "3e the link is gone" "[ ! -L '${d}/default-anas' ]"
check "3e the file it pointed to is untouched" "[ -f '${d}/real-anas' ] && grep -qx 'ANAS_PORT=3005' '${d}/real-anas'"
check "3e the log says the symlink was removed" "grep -qF 'removed the symlink ${d}/default-anas' '${d}/out'"
check "3e the log names the surviving file and says it was left" \
  "grep -qF \"${d}/real-anas, was left in place\" '${d}/out'"
check "3e the log does not claim the env file path itself was removed" \
  "! grep -qF 'removed ${d}/default-anas' '${d}/out'"

echo "== cr4 3e: a dangling symlink is removed too, and the log says the target does not exist =="
d="${WORK}/env.dangling"; mkdir -p "${d}"
ln -s gone-anas "${d}/default-anas"
ANAS_ENV_FILE="${d}/default-anas" ANAS_UNINSTALL_LIB_ONLY=1 \
  bash -c "source '${UNINSTALL}'; remove_env_file" > "${d}/out" 2>&1
check "3e the dangling link is gone" "[ ! -L '${d}/default-anas' ]"
check "3e the log calls it dangling and names the target" \
  "grep -qF 'dangling symlink ${d}/default-anas' '${d}/out' && grep -qF 'gone-anas' '${d}/out'"
check "3e the log does not claim a file was left" "! grep -qF 'was left in place' '${d}/out'"

echo "== cr4 3e: a regular env file is still removed and the log says that =="
d="${WORK}/env.plain"; mkdir -p "${d}"
printf 'ANAS_PORT=3005\n' > "${d}/default-anas"
ANAS_ENV_FILE="${d}/default-anas" ANAS_UNINSTALL_LIB_ONLY=1 \
  bash -c "source '${UNINSTALL}'; remove_env_file" > "${d}/out" 2>&1
check "3e the regular file is removed" "[ ! -e '${d}/default-anas' ]"
check "3e the log says it was removed" "grep -qF \"removed ${d}/default-anas\" '${d}/out'"
check "3e the log says nothing about symlinks" "! grep -qF 'symlink' '${d}/out'"

# -----------------------------------------------------------------------------
echo "== remove_prefix removes an ANAS install and leaves anything else =="
rp() { ANAS_UNINSTALL_LIB_ONLY=1 PREFIX="$1" bash -c "source '${UNINSTALL}'; remove_prefix" > "${WORK}/rp.log" 2>&1; }
d="${WORK}/rp"; rm -rf "${d}"; mkdir -p "${d}/etc-like/cron.d" "${d}/inst/packages/daemon" "${d}/empty"; : > "${d}/etc-like/passwd"
rp "${d}/etc-like"
check "a directory that is not an ANAS install is left whole" "[ -f '${d}/etc-like/passwd' ] && [ -d '${d}/etc-like/cron.d' ]"
check "the log says it was left and names --prefix" "grep -qF 'is not an ANAS install' '${WORK}/rp.log' && grep -qF -- '--prefix' '${WORK}/rp.log'"
rp "${d}/inst"
check "an ANAS install is removed" "[ ! -e '${d}/inst' ]"
rp "${d}/empty"
check "an empty directory is removed" "[ ! -e '${d}/empty' ]"
rp "${d}/never"
check "an absent prefix says nothing to remove" "grep -qF 'not present (nothing to remove)' '${WORK}/rp.log'"

echo
echo "uninstall-order tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]

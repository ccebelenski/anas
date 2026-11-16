#!/usr/bin/env bash
#
# cr3.core CORE-M2 + CORE-L4: install.sh's phase-1 rollback.
#
#   L4  a command that fails INSIDE a function phase1_install calls
#       (install_units) must still run the rollback: without `set -E` the ERR
#       trap was not inherited, bash exited under -e, and a fresh install left
#       ${PREFIX}, the env file and the hooks behind.
#   M2  a failed UPGRADE's rollback must put back exactly what was there: the
#       old unit files (not the new release's), the old env file (a --port had
#       rewritten it), the units enabled again (it disabled them and never
#       re-enabled: the restored install ran until the next reboot, then never
#       started), the services it stopped started again, the recycle timer
#       running again.
#
# install.sh is sourced in ANAS_INSTALL_LIB_ONLY mode into a throwaway tree
# with systemctl / udevadm / chown faked; no root, no real node.
#
#   bash packaging/test/install-rollback.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/.." && pwd)"
INSTALL="${PKG}/install.sh"

PASS=0
FAIL=0
ok()   { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

WORK="$(mktemp -d -p "${ANAS_TEST_TMPDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}" .scratch.XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT

# Recording stubs FIRST on PATH as well as the shell functions below, so no
# path through install.sh can reach the real system tools.
mkdir -p "${WORK}/bin" "${WORK}/tmp"
for _tool in systemctl apt apt-get dpkg update-initramfs pveproxy service udevadm journalctl; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 0\n' "${_tool}" "${WORK}/bin/calls.log" > "${WORK}/bin/${_tool}"
  chmod +x "${WORK}/bin/${_tool}"
done
export PATH="${WORK}/bin:${PATH}"
[ "$(command -v systemctl)" = "${WORK}/bin/systemctl" ] || { echo "FATAL: systemctl stub not first on PATH" >&2; exit 1; }

# A tree standing in for the node, and a fake app/ whose integration scripts
# only print.
new_tree() {
  local t="$1"
  mkdir -p "${t}/app/packages/pve-integration" "${t}/systemd-dir" "${t}/udev" "${t}/tpl/default" "${t}/js"
  printf '#!/bin/sh\necho fake-integration "$0"\n' > "${t}/app/packages/pve-integration/install.sh"
  cp "${t}/app/packages/pve-integration/install.sh" "${t}/app/packages/pve-integration/uninstall.sh"
  chmod +x "${t}/app/packages/pve-integration/"*.sh
  echo "NEW" > "${t}/app/VERSION"
}

# Run phase1_install against tree $1 with the systemctl answers in $2
# ("enabled" = every unit enabled and active before the run; "" = none).
# Extra shell lines in $3 run after sourcing (to break a step).
run_phase1() {
  local t="$1" state="$2" extra="$3"
  (
    export PREFIX="${t}/opt/anas" SYSTEMD_DIR="${t}/systemd-dir" ANAS_ENV_FILE="${t}/default-anas"
    # The installer's scratch (saved byte copies of prior files) stays in the
    # throwaway tree, never the machine's /tmp.
    export TMPDIR="${WORK}/tmp"
    export HOOK_DEST="${t}/anas-md-event" CACHE_HOOK_DEST="${t}/anas-cache-event" UDEV_RULES_DIR="${t}/udev"
    export PVE_TEMPLATE_DIR="${t}/tpl/default" PVE_JS_DIR="${t}/js" PVE_TPL="${t}/index.html.tpl"
    export MDADM_CONF="${t}/mdadm.conf"
    export ANAS_INSTALL_LIB_ONLY=1
    # Sourced with no arguments (a function's own would reach the arg parser).
    set --
    # shellcheck disable=SC1090
    source "${INSTALL}"
    systemctl() {
      printf '%s\n' "$*" >> "${t}/systemctl.log"
      case "$1" in
        is-enabled|is-active) [ "${state}" = "enabled" ] ;;
        *) return 0 ;;
      esac
    }
    chown() { printf '%s\n' "$*" >> "${t}/chown.log"; return 0; }
    udevadm() { return 0; }
    journalctl() { return 0; }
    APP_SRC="${t}/app"
    RESOLVED_PORT=3007
    HEALTH_PORT=3007
    eval "${extra}"
    phase1_install
    echo "PHASE1-RETURNED"
  ) > "${t}/out.log" 2>&1
  echo $? > "${t}/rc"
}

echo "== L4: a failure inside a function phase1_install calls rolls back (fresh install) =="
T1="${WORK}/fresh"
new_tree "${T1}"
# install_units' first sed reads a unit source that does not exist: the failing
# command is INSIDE install_units, two calls below the trap.
run_phase1 "${T1}" "" 'UNIT_SRC="${t}/no-such-systemd-src"'
check "the installer failed (exit 1)" "[ \"\$(cat '${T1}/rc')\" = 1 ]"
check "phase1_install did not carry on past the failure" "! grep -q PHASE1-RETURNED '${T1}/out.log'"
check "the rollback ran" "grep -q 'rolling back' '${T1}/out.log'"
check "the rollback ran ONCE" "[ \"\$(grep -c 'rolling back' '${T1}/out.log')\" = 1 ]"
check "the fresh ${PREFIX:-prefix} copy is removed" "[ ! -e '${T1}/opt/anas' ]"
check "the env file this run created is removed" "[ ! -e '${T1}/default-anas' ]"
check "the md-event hook this run created is removed" "[ ! -e '${T1}/anas-md-event' ]"
check "the cache-event hook this run created is removed" "[ ! -e '${T1}/anas-cache-event' ]"
check "the udev rule this run created is removed" "[ ! -e '${T1}/udev/99-anas-cache.rules' ]"

echo "== M2: a failed upgrade restores the previous install, its files, enablement and services =="
T2="${WORK}/upgrade"
new_tree "${T2}"
mkdir -p "${T2}/opt/anas/packages/pve-integration"
echo "OLD" > "${T2}/opt/anas/VERSION"
cp "${T2}/app/packages/pve-integration/"*.sh "${T2}/opt/anas/packages/pve-integration/"
for u in anasd.service anas.service anas-recycle.timer anas-recycle.service; do
  printf '# OLD %s\nExecStart=/old/path\n' "${u}" > "${T2}/systemd-dir/${u}"
  chmod 0640 "${T2}/systemd-dir/${u}"
done
mkdir -p "${T2}/systemd-dir/rtslib-fb-targetctl.service.d"
printf '# OLD drop-in\n' > "${T2}/systemd-dir/rtslib-fb-targetctl.service.d/anas-ordering.conf"
printf '# operator-kept\nANAS_PORT=3005\n\n' > "${T2}/default-anas"
printf '#!/bin/sh\n# OLD md hook\n' > "${T2}/anas-md-event"
printf '#!/bin/sh\n# OLD cache hook\n' > "${T2}/anas-cache-event"
printf '# OLD rule\n' > "${T2}/udev/99-anas-cache.rules"
printf 'OLD template\n' > "${T2}/tpl/default/anas-ahr-body.txt.hbs"
cp -a "${T2}/systemd-dir" "${T2}/systemd-before"
cp "${T2}/default-anas" "${T2}/default-anas.before"
# The new release installs fine and then fails its health check.
run_phase1 "${T2}" "enabled" 'health_check() { return 1; }'
check "the installer failed (exit 1)" "[ \"\$(cat '${T2}/rc')\" = 1 ]"
check "the rollback ran once" "[ \"\$(grep -c 'rolling back' '${T2}/out.log')\" = 1 ]"
check "the previous install is back at the prefix" "[ \"\$(cat '${T2}/opt/anas/VERSION')\" = OLD ]"
check "no backup directory is left behind" "! ls -d '${T2}'/opt/anas.bak.* 2>/dev/null"
for u in anasd.service anas.service anas-recycle.timer anas-recycle.service; do
  check "${u}: the OLD unit file, byte for byte (not the new release's)" "cmp -s '${T2}/systemd-before/${u}' '${T2}/systemd-dir/${u}'"
  check "${u}: its old mode (0640)" "[ \"\$(stat -c %a '${T2}/systemd-dir/${u}')\" = 640 ]"
done
check "the iSCSI drop-in is the old one" "cmp -s '${T2}/systemd-before/rtslib-fb-targetctl.service.d/anas-ordering.conf' '${T2}/systemd-dir/rtslib-fb-targetctl.service.d/anas-ordering.conf'"
check "the env file a --port rewrote has its old content back (trailing blank line kept)" "cmp -s '${T2}/default-anas.before' '${T2}/default-anas'"
check "the md-event hook is the old one" "grep -q 'OLD md hook' '${T2}/anas-md-event'"
check "the cache-event hook is the old one" "grep -q 'OLD cache hook' '${T2}/anas-cache-event'"
check "the udev rule is the old one" "grep -q 'OLD rule' '${T2}/udev/99-anas-cache.rules'"
check "a template the run overwrote is the old one" "grep -q 'OLD template' '${T2}/tpl/default/anas-ahr-body.txt.hbs'"
# The systemctl calls AFTER the rollback began.
awk '/disable --now anasd anas/{on=1} on' "${T2}/systemctl.log" > "${T2}/rollback-calls.log"
check "anasd.service is enabled again" "grep -qx 'enable anasd.service' '${T2}/rollback-calls.log'"
check "anas.service is enabled again" "grep -qx 'enable anas.service' '${T2}/rollback-calls.log'"
check "the recycle timer is enabled again" "grep -qx 'enable anas-recycle.timer' '${T2}/rollback-calls.log'"
check "the services this run stopped are started again" "grep -qx 'restart anasd anas' '${T2}/rollback-calls.log'"
check "the recycle timer is started again" "grep -qx 'start anas-recycle.timer' '${T2}/rollback-calls.log'"

echo "== M2: a failed upgrade of a node whose services were NOT enabled or running leaves them so =="
T3="${WORK}/upgrade-stopped"
new_tree "${T3}"
mkdir -p "${T3}/opt/anas"
echo "OLD" > "${T3}/opt/anas/VERSION"
run_phase1 "${T3}" "" 'health_check() { return 1; }'
awk '/disable --now anasd anas/{on=1} on' "${T3}/systemctl.log" > "${T3}/rollback-calls.log"
check "the previous install is back" "[ \"\$(cat '${T3}/opt/anas/VERSION')\" = OLD ]"
check "nothing is enabled that was not" "! grep -q '^enable ' '${T3}/rollback-calls.log'"
check "nothing is started that was not running" "! grep -qE '^(restart|start) ' '${T3}/rollback-calls.log'"
check "unit files this run created are removed" "[ ! -e '${T3}/systemd-dir/anasd.service' ]"
check "... the recycle pair too" "[ ! -e '${T3}/systemd-dir/anas-recycle.timer' ] && [ ! -e '${T3}/systemd-dir/anas-recycle.service' ]"

echo "== cr4 inst D-5b: the rollback starts only the service that was running before =="
T28="${WORK}/one-active"
new_tree "${T28}"
mkdir -p "${T28}/opt/anas"
echo "OLD" > "${T28}/opt/anas/VERSION"
# anasd was enabled AND running; anas was enabled but deliberately stopped.
# One systemctl stub answering is-active per unit, which run_phase1's single
# state answer cannot express.
run_phase1 "${T28}" "enabled" '
  systemctl() {
    printf "%s\n" "$*" >> "${t}/systemctl.log"
    case "$1" in
      is-enabled) return 0 ;;
      is-active) [ "${3}" = "anasd" ] ;;
      *) return 0 ;;
    esac
  }
  health_check() { return 1; }
'
check "the installer failed (exit 1)" "[ \"\$(cat '${T28}/rc')\" = 1 ]"
awk '/disable --now anasd anas/{on=1} on' "${T28}/systemctl.log" > "${T28}/rollback-calls.log"
RESTART28="$(grep '^restart ' "${T28}/rollback-calls.log" || true)"
check "the rollback restarted only anasd, the one that was running before" "[ \"${RESTART28}\" = 'restart anasd' ]"

echo "== cr4 fold A: a failed restart of a unit that was running is a failed restore step =="
T30="${WORK}/restart-fails"
new_tree "${T30}"
mkdir -p "${T30}/opt/anas"
echo "OLD" > "${T30}/opt/anas/VERSION"
# Both services were enabled AND running before the run (probe A's input).
# After the rollback's first `disable --now`, every restart FAILS and every
# is-active answer says INACTIVE: the units this run stopped do not come back,
# so the node is left with both services down. The last line must not claim
# "node unchanged" over that; it must name the units and say how to look.
run_phase1 "${T30}" "enabled" '
  ROLLBACK_BEGUN=0
  systemctl() {
    printf "%s\n" "$*" >> "${t}/systemctl.log"
    case "$1" in
      disable) ROLLBACK_BEGUN=1; return 0 ;;
      is-enabled) return 0 ;;
      is-active) [ "${ROLLBACK_BEGUN}" = 0 ] ;;
      restart) [ "${ROLLBACK_BEGUN}" = 0 ] ;;
      *) return 0 ;;
    esac
  }
  health_check() { return 1; }
'
check "the installer failed (exit 1)" "[ \"\$(cat '${T30}/rc')\" = 1 ]"
awk '/disable --now anasd anas/{on=1} on' "${T30}/systemctl.log" > "${T30}/rollback-calls.log"
check "the rollback tried the restart of both services that were running" "grep -qx 'restart anasd anas' '${T30}/rollback-calls.log'"
check "and asked which of them came back" "grep -qx 'is-active --quiet anasd' '${T30}/rollback-calls.log' && grep -qx 'is-active --quiet anas' '${T30}/rollback-calls.log'"
check "the last line does NOT claim the node is unchanged" "! grep -q 'node unchanged' '${T30}/out.log'"
check "it names the units that could not be started" "grep -q 'could not be started again: anasd anas' '${T30}/out.log'"
check "it says to run systemctl status on each unit" "grep -q 'systemctl status anasd' '${T30}/out.log' && grep -q 'systemctl status anas' '${T30}/out.log'"
check "it says to run journalctl -u <unit> -b on each" "grep -q 'journalctl -u anasd -b' '${T30}/out.log' && grep -q 'journalctl -u anas -b' '${T30}/out.log'"
check "the previous install is still back at the prefix (the file restore itself worked)" "[ \"\$(cat '${T30}/opt/anas/VERSION')\" = OLD ]"

echo "== cr4 fold A: a restart that fails while the unit is ACTIVE is not a lost service =="
T30b="${WORK}/restart-succeeded-anyway"
new_tree "${T30b}"
mkdir -p "${T30b}/opt/anas"
echo "OLD" > "${T30b}/opt/anas/VERSION"
# The restart call exits non-zero but every unit answers is-active ACTIVE
# afterwards: nothing was lost, so "node unchanged" must STAY true (the
# installer does not guess a failure the unit itself denies).
run_phase1 "${T30b}" "enabled" '
  ROLLBACK_BEGUN=0
  systemctl() {
    printf "%s\n" "$*" >> "${t}/systemctl.log"
    case "$1" in
      disable) ROLLBACK_BEGUN=1; return 0 ;;
      *) return 0 ;;
    esac
  }
  health_check() { return 1; }
'
check "the last line still says the node is unchanged" "grep -q 'node unchanged' '${T30b}/out.log'"
check "no service failure is claimed" "! grep -q 'could not be started again' '${T30b}/out.log'"

echo "== cr4 inst D-5a: a saved file with NUL bytes is restored byte for byte (cmp) =="
T29="${WORK}/nul-bytes"
new_tree "${T29}"
mkdir -p "${T29}/opt/anas" "${T29}/tmp"
echo "OLD" > "${T29}/opt/anas/VERSION"
# One NUL byte: exactly what $( cat ) drops, and what the rollback then wrote
# back one byte short (reviewer probe: original=51 restored=50 bytes).
printf 'ANAS_PORT=3005\nANAS_OPERATOR_BYTES=a\x00b\n' > "${T29}/default-anas"
cp -p "${T29}/default-anas" "${T29}/default-anas.before"
run_phase1 "${T29}" "enabled" 'TMPDIR="${t}/tmp"; export TMPDIR; health_check() { return 1; }'
check "the installer failed (exit 1)" "[ \"\$(cat '${T29}/rc')\" = 1 ]"
check "the rollback ran once" "[ \"\$(grep -c 'rolling back' '${T29}/out.log')\" = 1 ]"
check "the restored env file is IDENTICAL to what was there, NUL byte included (cmp)" "cmp -s '${T29}/default-anas.before' '${T29}/default-anas'"
check "'node unchanged'" "grep -q 'node unchanged' '${T29}/out.log'"
check "the scratch holding the saved copies does not outlive a rollback that restored everything" "[ -z \"\$(ls -A '${T29}/tmp')\" ]"

echo "== cr4 fold B2: a scratch directory that cannot be made says so, not 'cannot read' =="
T31="${WORK}/scratchdir-fails"
new_tree "${T31}"
mkdir -p "${T31}/opt/anas"
echo "OLD" > "${T31}/opt/anas/VERSION"
printf 'ANAS_PORT=3005\n' > "${T31}/default-anas"
# Probe B2's input: TMPDIR points at a directory that does not exist, so the
# scratch mktemp fails on the first prior file. Every file is world-readable,
# yet the sentence used to be "cannot read <file>". The scratch failure gets
# its own sentence, naming the directory and the fix.
run_phase1 "${T31}" "enabled" 'TMPDIR="${t}/no-such-dir"; export TMPDIR; health_check() { return 1; }'
check "the install failed before phase 1 (exit 1)" "[ \"\$(cat '${T31}/rc')\" = 1 ]"
check "it names the directory it could not create" "grep -qF 'cannot create the scratch directory ${T31}/no-such-dir/.anas-prior-state' '${T31}/out.log'"
check "it gives the fix: a writable TMPDIR, or space there" "grep -qF 'set TMPDIR to a writable directory, or free space there' '${T31}/out.log'"
check "the node was NOT modified is stated" "grep -qF 'The node was NOT modified' '${T31}/out.log'"
check "no file is blamed for being unreadable" "! grep -q 'cannot read' '${T31}/out.log'"
check "the env file is intact" "grep -qx 'ANAS_PORT=3005' '${T31}/default-anas'"
check "no rollback ran (nothing was modified)" "! grep -q 'rolling back' '${T31}/out.log'"

echo "== cr4 fold D: a killed run does not leave the scratch behind =="
T32="${WORK}/killed-run"
new_tree "${T32}"
mkdir -p "${T32}/opt/anas" "${T32}/tmp"
echo "OLD" > "${T32}/opt/anas/VERSION"
printf 'ANAS_PORT=3005\n' > "${T32}/default-anas"
# Probe D: the prior state is saved (the scratch is now ON DISK), then the
# shell dies the way a Ctrl-C or a dropped ssh session kills an install: an
# untrapped SIGTERM. No rollback runs, no finish_success runs; only the EXIT
# path can take the scratch with the shell.
# The braces keep the runner's own "Terminated ( ... )" notice (bash prints it
# when a foreground child dies of SIGTERM) out of the suite's output; the
# subshell's own stderr goes to out.log.
{
(
  export PREFIX="${T32}/opt/anas" SYSTEMD_DIR="${T32}/systemd-dir" ANAS_ENV_FILE="${T32}/default-anas"
  export TMPDIR="${T32}/tmp"
  export HOOK_DEST="${T32}/anas-md-event" CACHE_HOOK_DEST="${T32}/anas-cache-event" UDEV_RULES_DIR="${T32}/udev"
  export PVE_TEMPLATE_DIR="${T32}/tpl/default" PVE_JS_DIR="${T32}/js" PVE_TPL="${T32}/index.html.tpl"
  export MDADM_CONF="${T32}/mdadm.conf"
  export ANAS_INSTALL_LIB_ONLY=1
  set --
  # shellcheck disable=SC1090
  source "${INSTALL}"
  systemctl() { return 0; }
  save_prior_state
  printf 'SCRATCH:%s\n' "$(ls -A "${T32}/tmp")"
  # The kill: an untrapped SIGTERM to this very subshell (BASHPID: $$ would
  # be the test runner).
  kill -TERM "${BASHPID}"
  printf 'NEVER-REACHED\n'
) > "${T32}/out.log" 2>&1
echo $? > "${T32}/rc"
} 2>/dev/null
check "the scratch was on disk while the run lived (the kill's premise)" "grep -q 'SCRATCH:.anas-prior-state' '${T32}/out.log'"
check "the run died of SIGTERM (exit 143)" "[ \"\$(cat '${T32}/rc')\" = 143 ]"
check "neither a rollback nor an orderly end ran (what makes this every other test's blind spot)" "! grep -qE 'rolling back|NEVER-REACHED' '${T32}/out.log'"
check "the killed run's scratch does not outlive it" "[ -z \"\$(ls -A '${T32}/tmp')\" ]"

echo "== L4: an ERR inside a command substitution does not run a second rollback in the subshell =="
T4="${WORK}/subshell"
new_tree "${T4}"
run_phase1 "${T4}" "" 'health_check() { local x; x="$(false)"; return 1; }'
check "the rollback ran exactly once" "[ \"\$(grep -c 'rolling back' '${T4}/out.log')\" = 1 ]"
check "the fresh prefix is removed" "[ ! -e '${T4}/opt/anas' ]"

echo "== cr3 review: a symlinked env file and unit file keep their link, and the TARGET's mode and owner =="
T5="${WORK}/symlinks"
new_tree "${T5}"
mkdir -p "${T5}/opt/anas" "${T5}/elsewhere"
echo "OLD" > "${T5}/opt/anas/VERSION"
printf 'ANAS_PORT=3005\n' > "${T5}/elsewhere/anas.env"
chmod 0600 "${T5}/elsewhere/anas.env"
ln -s "${T5}/elsewhere/anas.env" "${T5}/default-anas"
printf '# OLD linked unit\n' > "${T5}/elsewhere/anasd.service"
chmod 0644 "${T5}/elsewhere/anasd.service"
ln -s "${T5}/elsewhere/anasd.service" "${T5}/systemd-dir/anasd.service"
run_phase1 "${T5}" "enabled" 'health_check() { return 1; }'
check "the rollback ran" "grep -q 'rolling back' '${T5}/out.log'"
check "the env path is still the same symlink" "[ -L '${T5}/default-anas' ] && [ \"\$(readlink '${T5}/default-anas')\" = '${T5}/elsewhere/anas.env' ]"
check "the env target has its old bytes back" "[ \"\$(cat '${T5}/elsewhere/anas.env')\" = 'ANAS_PORT=3005' ]"
check "the env target is still 0600 (never the link's own 777)" "[ \"\$(stat -c %a '${T5}/elsewhere/anas.env')\" = 600 ]"
check "the owner restored is the TARGET's uid:gid, on the target itself (restored in place)" "grep -qx \"\$(stat -c %u:%g '${T5}/elsewhere/anas.env') -- ${T5}/elsewhere/anas.env\" '${T5}/chown.log'"
check "the unit path is a symlink again (the rollback removed it before restoring)" "[ -L '${T5}/systemd-dir/anasd.service' ] && [ \"\$(readlink '${T5}/systemd-dir/anasd.service')\" = '${T5}/elsewhere/anasd.service' ]"
check "the linked unit file has its old bytes" "[ \"\$(cat '${T5}/elsewhere/anasd.service')\" = '# OLD linked unit' ]"

echo "== cr3 review: a failed UI verify on an upgrade rolls back and re-applies the previous UI =="
T6="${WORK}/ui-upgrade"
new_tree "${T6}"
printf '#!/bin/sh\necho "NEW $(basename "$0")" >> "%s/ui.log"\n' "${T6}" > "${T6}/app/packages/pve-integration/install.sh"
cp "${T6}/app/packages/pve-integration/install.sh" "${T6}/app/packages/pve-integration/uninstall.sh"
mkdir -p "${T6}/opt/anas/packages/pve-integration"
echo "OLD" > "${T6}/opt/anas/VERSION"
printf '#!/bin/sh\necho "OLD $(basename "$0")" >> "%s/ui.log"\n' "${T6}" > "${T6}/opt/anas/packages/pve-integration/install.sh"
cp "${T6}/opt/anas/packages/pve-integration/install.sh" "${T6}/opt/anas/packages/pve-integration/uninstall.sh"
chmod +x "${T6}/app/packages/pve-integration/"*.sh "${T6}/opt/anas/packages/pve-integration/"*.sh
echo '// old' > "${T6}/js/anas.js"
: > "${T6}/index.html.tpl"   # the UI was there; the new verify finds no script line
run_phase1 "${T6}" "enabled" 'health_check() { return 0; }'
check "the installer failed (exit 1), never returned" "[ \"\$(cat '${T6}/rc')\" = 1 ] && ! grep -q PHASE1-RETURNED '${T6}/out.log'"
check "the verify failure reached the rollback" "grep -q 'rolling back' '${T6}/out.log'"
check "the new integration ran, then its uninstaller, then the OLD installer re-applied the UI" \
  "[ \"\$(cat '${T6}/ui.log' | tr '\\n' ' ')\" = 'NEW install.sh NEW uninstall.sh OLD install.sh ' ]"
check "the previous install is back" "[ \"\$(cat '${T6}/opt/anas/VERSION')\" = OLD ]"

echo "== cr3 review: a fresh install whose integration installer fails half way leaves nothing behind =="
T7="${WORK}/ui-fresh"
new_tree "${T7}"
printf '#!/bin/sh\necho "NEW install.sh" >> "%s/ui.log"; echo partial > "%s/js/anas.js"; exit 3\n' "${T7}" "${T7}" > "${T7}/app/packages/pve-integration/install.sh"
printf '#!/bin/sh\necho "NEW uninstall.sh" >> "%s/ui.log"; rm -f "%s/js/anas.js"\n' "${T7}" "${T7}" > "${T7}/app/packages/pve-integration/uninstall.sh"
chmod +x "${T7}/app/packages/pve-integration/"*.sh
: > "${T7}/index.html.tpl"
run_phase1 "${T7}" "" 'health_check() { return 0; }'
check "the rollback ran" "grep -q 'rolling back' '${T7}/out.log'"
check "the half-done integration was reverted by its uninstaller" "grep -qx 'NEW uninstall.sh' '${T7}/ui.log' && [ ! -e '${T7}/js/anas.js' ]"
check "the notification templates this run created are removed" "[ -z \"\$(ls '${T7}/tpl/default')\" ]"
check "the prefix is removed" "[ ! -e '${T7}/opt/anas' ]"

echo "== cr3 review: a failed upgrade leaves the templates it found, and removes only the ones it added =="
T8="${WORK}/templates"
new_tree "${T8}"
mkdir -p "${T8}/opt/anas"
echo "OLD" > "${T8}/opt/anas/VERSION"
printf 'OLD only one template\n' > "${T8}/tpl/default/anas-ahr-body.txt.hbs"
run_phase1 "${T8}" "enabled" 'health_check() { return 1; }'
check "exactly the one template it found is left" "[ \"\$(ls '${T8}/tpl/default')\" = 'anas-ahr-body.txt.hbs' ]"
check "with its old content" "grep -qx 'OLD only one template' '${T8}/tpl/default/anas-ahr-body.txt.hbs'"

# Inode + mtime (ns) + bytes of a path, through a link: "untouched" means equal.
fp() { if [ -e "$1" ]; then printf '%s %s %s' "$(stat -L -c '%i %y %a %u:%g' -- "$1")" "$(md5sum < "$1" | cut -c1-12)" "$( [ -L "$1" ] && readlink -- "$1")"; else printf ABSENT; fi; }

echo "== cr3 review 2 (1): the installer never touches mdadm.conf, AHR pin or not =="
T9="${WORK}/mdprog"
new_tree "${T9}"
mkdir -p "${T9}/opt/anas"
echo "OLD" > "${T9}/opt/anas/VERSION"
printf 'ARRAY /dev/md/backup-r1 metadata=1.2 UUID=11111111:22222222:33333333:44444444\n' > "${T9}/mdadm.conf"
B9="$(fp "${T9}/mdadm.conf")"
sleep 0.05
run_phase1 "${T9}" "enabled" 'health_check() { return 1; }'
check "mdadm.conf: same inode, mtime, mode, owner and bytes after a failed upgrade" "[ \"\$(fp '${T9}/mdadm.conf')\" = '${B9}' ]"
check "install.sh has no mdadm.conf handling at all" "! grep -qE 'MDADM_CONF|md_conf_facts|wire_md_program_hook' '${INSTALL}'"
check "mdmonitor is never restarted by the installer" "! grep -q mdmonitor '${T9}/systemctl.log'"

echo "== cr3 review 2 (2): a path phase 1 never touched is not rewritten by the rollback =="
T10="${WORK}/untouched"
new_tree "${T10}"
mkdir -p "${T10}/opt/anas" "${T10}/systemd-dir/rtslib-fb-targetctl.service.d"
echo "OLD" > "${T10}/opt/anas/VERSION"
printf 'ANAS_PORT=3005\n' > "${T10}/default-anas"
printf '# OLD unit\n' > "${T10}/systemd-dir/anasd.service"
printf 'OLD template\n' > "${T10}/tpl/default/anas-ahr-body.txt.hbs"
printf '#!/bin/sh\n# OLD md hook\n' > "${T10}/anas-md-event"
declare -A B10=()
for f in default-anas systemd-dir/anasd.service tpl/default/anas-ahr-body.txt.hbs anas-md-event; do B10[$f]="$(fp "${T10}/${f}")"; done
sleep 0.05
# The copy of the app fails: phase 1's first act after the backup.
run_phase1 "${T10}" "enabled" 'APP_SRC="${t}/no-such-app"'
check "the rollback ran once" "[ \"\$(grep -c 'rolling back' '${T10}/out.log')\" = 1 ]"
for f in default-anas systemd-dir/anasd.service tpl/default/anas-ahr-body.txt.hbs anas-md-event; do
  check "${f}: untouched by the rollback (same inode, mtime, bytes)" "[ \"\$(fp '${T10}/${f}')\" = '${B10[$f]}' ]"
done
check "the previous install is back" "[ \"\$(cat '${T10}/opt/anas/VERSION')\" = OLD ]"

echo "== cr3 review 2 (2): a restore is written through a temp file and renamed; one that fails is named, never 'node unchanged' =="
T11="${WORK}/restore-fails"
if [ "$(id -u)" = 0 ] || { mkdir -p "${WORK}/ro11"; chmod 0555 "${WORK}/ro11"; touch "${WORK}/ro11/x" 2>/dev/null; }; then
  echo "  skip this user can write into a 0555 directory (root, or root in a user namespace): the failure cannot be staged"
  T11_SKIP=1
else
  T11_SKIP=0
fi
chmod 0755 "${WORK}/ro11" 2>/dev/null || true
if [ "${T11_SKIP}" = 0 ]; then
  new_tree "${T11}"
  mkdir -p "${T11}/opt/anas" "${T11}/envdir"
  echo "OLD" > "${T11}/opt/anas/VERSION"
  printf 'ANAS_PORT=3005\n' > "${T11}/envdir/anas"
  # Phase 1 rewrites the env file (port 3007), then its directory becomes
  # read-only: the rollback cannot create its temp file beside it.
  run_phase1 "${T11}" "enabled" 'ANAS_ENV_FILE="${t}/envdir/anas"; health_check() { chmod 0555 "${t}/envdir"; return 1; }'
  chmod 0755 "${T11}/envdir"
  check "the env file is not truncated: it still holds a whole file (the new port)" "[ \"\$(grep -c '^ANAS_PORT=3007$' '${T11}/envdir/anas')\" = 1 ]"
  check "the rollback names the path it could not restore" "grep -q 'could not be restored' '${T11}/out.log' && grep -q '${T11}/envdir/anas' '${T11}/out.log'"
  check "and never claims the node is unchanged" "! grep -q 'node unchanged' '${T11}/out.log'"
  check "no temp file is left behind" "[ -z \"\$(ls -A '${T11}/envdir' | grep -v '^anas$')\" ]"
fi
T11b="${WORK}/restore-ok"
new_tree "${T11b}"
mkdir -p "${T11b}/opt/anas"
echo "OLD" > "${T11b}/opt/anas/VERSION"
printf 'ANAS_PORT=3005\n' > "${T11b}/default-anas"
INO11="$(stat -c %i "${T11b}/default-anas")"
MT11="$(stat -c %.9Y "${T11b}/default-anas")"
run_phase1 "${T11b}" "enabled" 'health_check() { return 1; }'
check "the env file (written in place by phase 1) is restored IN PLACE: same inode" "[ \"\$(stat -c %i '${T11b}/default-anas')\" = '${INO11}' ] && grep -qx 'ANAS_PORT=3005' '${T11b}/default-anas'"
check "... and with its old mtime (a restored file reads as never touched)" "[ \"\$(stat -c %.9Y '${T11b}/default-anas')\" = '${MT11}' ]"
check "a rollback that restored everything still says 'node unchanged'" "grep -q 'node unchanged' '${T11b}/out.log'"

echo "== cr4 fold E: a rollback that kept the scratch keeps it through the EXIT path =="
if [ "$(id -u)" = 0 ] || { mkdir -p "${WORK}/ro33"; chmod 0555 "${WORK}/ro33"; touch "${WORK}/ro33/x" 2>/dev/null; }; then
  echo "  skip: this user can write into a 0555 directory (root, or root in a user namespace): the failure cannot be staged"
  T33_SKIP=1
else
  T33_SKIP=0
fi
chmod 0755 "${WORK}/ro33" 2>/dev/null || true
rm -rf "${WORK}/ro33" 2>/dev/null || true
if [ "${T33_SKIP}" = 0 ]; then
  T33="${WORK}/kept-scratch"
  new_tree "${T33}"
  mkdir -p "${T33}/opt/anas" "${T33}/envdir" "${T33}/tmp"
  echo "OLD" > "${T33}/opt/anas/VERSION"
  printf 'ANAS_PORT=3005\n' > "${T33}/envdir/anas"
  # Probe E's input: the env file lives in a directory phase 1 rewrites and the
  # health check then makes read-only, so the restore fails and the rollback
  # keeps the scratch and names it. The EXIT path armed by save_prior_state
  # must respect that keep: the scratch has to still be there AFTER the shell
  # that made it has exited.
  run_phase1 "${T33}" "enabled" 'ANAS_ENV_FILE="${t}/envdir/anas"; TMPDIR="${t}/tmp"; export TMPDIR; health_check() { chmod 0555 "${t}/envdir"; return 1; }'
  chmod 0755 "${T33}/envdir"
  check "the rollback named the path it could not restore" "grep -q 'could not be restored' '${T33}/out.log' && grep -q '${T33}/envdir/anas' '${T33}/out.log'"
  check "the message names the scratch it kept" "grep -q 'ANAS saved copies of the files it replaced in ${T33}/tmp/.anas-prior-state' '${T33}/out.log'"
  check "the scratch is still on disk AFTER the installer shell exited (the EXIT path respected the keep)" "ls -d '${T33}'/tmp/.anas-prior-state.* >/dev/null 2>&1"
  check "it still holds the saved byte copies" "[ \"\$(ls -A '${T33}'/tmp/.anas-prior-state.* | wc -l)\" -ge 1 ]"
fi

echo "== cr3 review 2 (3): a symlink phase 1 replaced is restored as the link, and the file behind it is not written =="
T12="${WORK}/foreign-link"
new_tree "${T12}"
mkdir -p "${T12}/opt/anas" "${T12}/otherpkg"
echo "OLD" > "${T12}/opt/anas/VERSION"
printf '#!/bin/sh\n# FOREIGN hook v1\n' > "${T12}/otherpkg/hook"
chmod 0750 "${T12}/otherpkg/hook"
ln -s "${T12}/otherpkg/hook" "${T12}/anas-md-event"
# The other package upgrades its file while phase 1 runs.
run_phase1 "${T12}" "enabled" 'health_check() { printf "#!/bin/sh\n# FOREIGN hook v2\n" > "${t}/otherpkg/hook"; return 1; }'
check "the hook path is the same symlink again" "[ -L '${T12}/anas-md-event' ] && [ \"\$(readlink '${T12}/anas-md-event')\" = '${T12}/otherpkg/hook' ]"
check "the other package's v2 is left as it wrote it" "grep -q 'FOREIGN hook v2' '${T12}/otherpkg/hook'"
check "... with its own mode" "[ \"\$(stat -c %a '${T12}/otherpkg/hook')\" = 750 ]"

echo "== cr3 review 2 (4): a file another process created during the run is not removed =="
T13="${WORK}/foreign-new"
new_tree "${T13}"
mkdir -p "${T13}/opt/anas"
echo "OLD" > "${T13}/opt/anas/VERSION"
# Before phase 1 reaches the templates, another tool drops one of the names;
# then the copy fails. Absent at save and present now is NOT "this run made it".
run_phase1 "${T13}" "enabled" 'cp() { printf "THEIRS\n" > "${t}/tpl/default/anas-ahr-body.txt.hbs"; return 1; }'
check "the rollback ran" "grep -q 'rolling back' '${T13}/out.log'"
check "the other tool's file is still there" "grep -qx THEIRS '${T13}/tpl/default/anas-ahr-body.txt.hbs'"

echo "== cr3 review 2 (5): a file that cannot be read before phase 1 stops the install, nothing changed =="
T14="${WORK}/unreadable"
new_tree "${T14}"
mkdir -p "${T14}/opt/anas"
echo "OLD" > "${T14}/opt/anas/VERSION"
printf '#!/bin/sh\n# OLD hook body\n' > "${T14}/anas-md-event"
chmod 000 "${T14}/anas-md-event"
if cat "${T14}/anas-md-event" >/dev/null 2>&1; then
  echo "  skip running as root: mode 000 does not stop root reading"
else
  run_phase1 "${T14}" "enabled" 'health_check() { return 1; }'
  chmod 0644 "${T14}/anas-md-event"
  check "the install failed" "[ \"\$(cat '${T14}/rc')\" = 1 ]"
  # stat succeeds on a 000-mode file; the failure is the COPY. Since the cr4
  # fold split the shared sentence, this file is named as what failed: cp.
  check "the sentence names the file" "grep -q 'cannot copy ${T14}/anas-md-event' '${T14}/out.log'"
  check "it is not called a read failure (the read succeeded)" "! grep -q 'cannot read' '${T14}/out.log'"
  check "before phase 1: no rollback, the prefix never moved" "! grep -q 'rolling back' '${T14}/out.log' && [ \"\$(cat '${T14}/opt/anas/VERSION')\" = OLD ] && ! ls -d '${T14}'/opt/anas.bak.* >/dev/null 2>&1"
  check "the file keeps its bytes" "grep -q 'OLD hook body' '${T14}/anas-md-event'"
fi

echo "== cr3 review 2 (6): the preflight refuses a dangling env-file link and a directory where a file goes =="
T15="${WORK}/preflight"
mkdir -p "${T15}/etc-real" "${T15}/anas-md-event" "${T15}/systemd-dir" "${T15}/udev" "${T15}/tpl/default"
ln -s "${T15}/etc-real/anas" "${T15}/default-anas"
(
  export SYSTEMD_DIR="${T15}/systemd-dir" ANAS_ENV_FILE="${T15}/default-anas"
  export HOOK_DEST="${T15}/anas-md-event" CACHE_HOOK_DEST="${T15}/anas-cache-event" UDEV_RULES_DIR="${T15}/udev"
  export PVE_TEMPLATE_DIR="${T15}/tpl/default" ANAS_INSTALL_LIB_ONLY=1
  set --
  # shellcheck disable=SC1090
  source "${INSTALL}"
  FATAL=()
  preflight_owned_paths
  printf '%s\n' "${FATAL[@]}"
) > "${T15}/out.log" 2>&1
check "the dangling env link is refused, naming the missing target" "grep -q '${T15}/default-anas' '${T15}/out.log' && grep -q '${T15}/etc-real/anas' '${T15}/out.log'"
check "the directory at the hook path is refused" "grep -q '${T15}/anas-md-event is a directory' '${T15}/out.log'"
check "nothing was written: the link's target was not created, the directory is empty" "[ ! -e '${T15}/etc-real/anas' ] && [ -z \"\$(ls -A '${T15}/anas-md-event')\" ]"
check "phase0_preflight runs that check" "grep -q '^  preflight_owned_paths' '${INSTALL}'"

echo "== cr3 review 3 (2a): a link re-pointed by another process is left alone, and named with the file this run wrote through it =="
T20="${WORK}/repointed"
new_tree "${T20}"
mkdir -p "${T20}/opt/anas"
echo "OLD" > "${T20}/opt/anas/VERSION"
printf 'ANAS_PORT=3005\n' > "${T20}/A"; printf 'B-CONTENT\n' > "${T20}/B"
ln -s "${T20}/A" "${T20}/default-anas"
run_phase1 "${T20}" "enabled" 'health_check() { ln -sfn "${t}/B" "${t}/default-anas"; return 1; }'
check "their link is left pointing where they pointed it" "[ \"\$(readlink '${T20}/default-anas')\" = '${T20}/B' ] && grep -qx B-CONTENT '${T20}/B'"
check "the link is named as not restored" "grep -q -- '- ${T20}/default-anas (re-pointed' '${T20}/out.log'"
check "and the file this run wrote through it" "grep -q -- '- ${T20}/A (this installation wrote it through' '${T20}/out.log'"
check "no 'node unchanged'" "! grep -q 'node unchanged' '${T20}/out.log'"

echo "== cr3 review 3 (2b): a file phase 1 writes in place is restored in place: hard links, ACLs kept =="
T21="${WORK}/inplace"
new_tree "${T21}"
mkdir -p "${T21}/opt/anas" "${T21}/elsewhere"
echo "OLD" > "${T21}/opt/anas/VERSION"
printf 'ANAS_PORT=3005\n' > "${T21}/default-anas"
ln "${T21}/default-anas" "${T21}/elsewhere/hardlink"
printf '# OLD unit\n' > "${T21}/systemd-dir/anasd.service"
HAVE_ACL=0
if setfacl -m "u:$(id -u):r" "${T21}/default-anas" 2>/dev/null; then HAVE_ACL=1; fi
run_phase1 "${T21}" "enabled" 'health_check() { return 1; }'
check "the other hard link sees the old bytes again (one inode, both names)" "grep -qx 'ANAS_PORT=3005' '${T21}/elsewhere/hardlink' && [ \"\$(stat -c %h '${T21}/default-anas')\" = 2 ]"
check "the unit is restored in place, old bytes" "grep -qx '# OLD unit' '${T21}/systemd-dir/anasd.service'"
if [ "${HAVE_ACL}" = 1 ]; then
  check "the env file keeps its ACL entry" "getfacl -p '${T21}/default-anas' 2>/dev/null | grep -q \"^user:$(id -un):r\""
else
  echo "  skip no POSIX ACLs on this filesystem"
fi
check "'node unchanged'" "grep -q 'node unchanged' '${T21}/out.log'"

echo "== cr3 review 3 (2b): a file phase 1 replaces (install) gets its ACL back across the temp+rename =="
T22="${WORK}/acl-replace"
new_tree "${T22}"
mkdir -p "${T22}/opt/anas"
echo "OLD" > "${T22}/opt/anas/VERSION"
printf 'OLD template\n' > "${T22}/tpl/default/anas-ahr-body.txt.hbs"
if setfacl -m "u:$(id -u):rw" "${T22}/tpl/default/anas-ahr-body.txt.hbs" 2>/dev/null; then
  run_phase1 "${T22}" "enabled" 'health_check() { return 1; }'
  check "the template has its old bytes and its ACL entry" "grep -qx 'OLD template' '${T22}/tpl/default/anas-ahr-body.txt.hbs' && getfacl -p '${T22}/tpl/default/anas-ahr-body.txt.hbs' 2>/dev/null | grep -q \"^user:$(id -un):rw\""
else
  echo "  skip no POSIX ACLs on this filesystem"
fi

echo "== cr3 review 3 (2c): when the rename fails, the temp holding the old bytes is KEPT and named =="
T23="${WORK}/keep-temp"
new_tree "${T23}"
mkdir -p "${T23}/opt/anas"
echo "OLD" > "${T23}/opt/anas/VERSION"
printf '#!/bin/sh\n# OLD md hook\n' > "${T23}/anas-md-event"
# Meanwhile the hook path becomes a non-empty directory: the rename cannot replace it.
run_phase1 "${T23}" "enabled" 'health_check() { rm -f "${t}/anas-md-event"; mkdir -p "${t}/anas-md-event/x"; return 1; }'
TMP23="$(ls -d "${T23}"/.anas-md-event.anas-restore.* 2>/dev/null | head -n1)"
check "the temp is kept" "[ -n '${TMP23}' ] && grep -q 'OLD md hook' '${TMP23}'"
check "and named in the sentence" "grep -q 'its old bytes are in ${TMP23}' '${T23}/out.log'"
check "no 'node unchanged'" "! grep -q 'node unchanged' '${T23}/out.log'"

echo "== cr3 review 3 (2d): a fresh install whose copy fails part way leaves no prefix =="
T24="${WORK}/partial-copy"
new_tree "${T24}"
run_phase1 "${T24}" "" 'cp() { mkdir -p "${PREFIX}/packages"; echo partial > "${PREFIX}/packages/x"; return 1; }'
check "the rollback ran" "grep -q 'rolling back' '${T24}/out.log'"
check "the part-way copy is removed" "[ ! -e '${T24}/opt/anas' ]"

echo "== cr3 review 3 (2e): directories that were there are never re-moded or removed; the ones this run made go =="
T25="${WORK}/dirs"
new_tree "${T25}"
mkdir -p "${T25}/opt/anas" "${T25}/envdir" "${T25}/systemd-dir/rtslib-fb-targetctl.service.d"
echo "OLD" > "${T25}/opt/anas/VERSION"
chmod 0750 "${T25}/envdir"
rmdir "${T25}/udev"
run_phase1 "${T25}" "enabled" 'ANAS_ENV_FILE="${t}/envdir/anas"; health_check() { return 1; }'
check "an existing 0750 directory stays 0750" "[ \"\$(stat -c %a '${T25}/envdir')\" = 750 ]"
check "an existing EMPTY drop-in directory is not removed" "[ -d '${T25}/systemd-dir/rtslib-fb-targetctl.service.d' ]"
check "the udev rules directory this run created is removed" "[ ! -e '${T25}/udev' ]"
check "install.sh never runs 'install -d' (it re-modes an existing directory)" "! grep -qE '^[^#]*install -d' '${INSTALL}'"

T25b="${WORK}/newparent"
new_tree "${T25b}"
# A fresh install whose PREFIX parent does not exist yet: the rollback removes
# the parent this run created, after the prefix inside it.
run_phase1 "${T25b}" "" 'PREFIX="${t}/newparent/opt/anas"; health_check() { return 1; }'
check "the prefix's parent this run created is removed (after the prefix)" "grep -q 'rolling back' '${T25b}/out.log' && [ ! -e '${T25b}/newparent' ]"

echo "== cr3 review 3 (2f): a file another process creates between the save and phase 1's write stops phase 1 =="
T26="${WORK}/race"
new_tree "${T26}"
mkdir -p "${T26}/opt/anas"
echo "OLD" > "${T26}/opt/anas/VERSION"
# udevadm runs just before the templates are installed: another tool drops one now.
run_phase1 "${T26}" "enabled" 'udevadm() { printf "THEIRS\n" > "${t}/tpl/default/anas-ahr-body.txt.hbs"; }'
check "phase 1 stopped with a sentence naming the file" "grep -q 'anas-ahr-body.txt.hbs appeared while ANAS was installing' '${T26}/out.log'"
check "their file is intact" "grep -qx THEIRS '${T26}/tpl/default/anas-ahr-body.txt.hbs'"
check "the rollback ran" "grep -q 'rolling back' '${T26}/out.log' && [ \"\$(cat '${T26}/opt/anas/VERSION')\" = OLD ]"

echo "== cr3 review 3 (2g, sync, leftovers, dead state) =="
check "restore_link names its temp with mktemp (never a fixed name)" "sed -n '/^restore_link()/,/^}/p' '${INSTALL}' | grep -q mktemp"
check "every unit and the env file is flushed after phase 1 writes it" "[ \"\$(grep -c 'sync -f -- \"\${SYSTEMD_DIR}/\${u}' '${INSTALL}')\" = 2 ] && grep -q 'sync -f -- \"\${ANAS_ENV_FILE}\"' '${INSTALL}'"
check "the dead HOOK_INSTALLED / ENV_FILE_FRESH / ISCSI_DROPIN_FRESH state is gone" "! grep -qE '(^|[^_A-Z])HOOK_INSTALLED|ENV_FILE_FRESH|ISCSI_DROPIN_FRESH' '${INSTALL}'"
T27="${WORK}/leftover"
mkdir -p "${T27}/systemd-dir" "${T27}/udev" "${T27}/tpl/default"
printf 'old bytes\n' > "${T27}/.anas-md-event.anas-restore.AbC123"
(
  export SYSTEMD_DIR="${T27}/systemd-dir" ANAS_ENV_FILE="${T27}/default-anas"
  export HOOK_DEST="${T27}/anas-md-event" CACHE_HOOK_DEST="${T27}/anas-cache-event" UDEV_RULES_DIR="${T27}/udev"
  export PVE_TEMPLATE_DIR="${T27}/tpl/default" ANAS_INSTALL_LIB_ONLY=1
  set --
  # shellcheck disable=SC1090
  source "${INSTALL}"
  FATAL=()
  preflight_owned_paths
) > "${T27}/out.log" 2>&1
check "a temp left by a killed earlier rollback is named on start, and kept" "grep -q '${T27}/.anas-md-event.anas-restore.AbC123 was left by an earlier ANAS installation' '${T27}/out.log' && [ -f '${T27}/.anas-md-event.anas-restore.AbC123' ]"

echo
echo "install-rollback: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]

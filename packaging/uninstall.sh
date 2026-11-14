#!/usr/bin/env bash
#
# Remove ANAS from a Proxmox VE node. Idempotent — safe to run repeatedly and
# safe to run on a partially-installed node.
#
set -euo pipefail

PREFIX="${PREFIX:-/opt/anas}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
ANAS_ENV_FILE="${ANAS_ENV_FILE:-/etc/default/anas}"

log()  { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
# Something the operator has to act on, but not a failed uninstall.
warn() { printf '    !! %s\n' "$*" >&2; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }

# Where systemd keeps a Persistent timer's last-fire stamp. The scrub timer's
# stamp is removed with the units so a later ANAS reinstall does not catch up a
# months-old missed occurrence (review R10).
TIMERS_STAMP_DIR="${TIMERS_STAMP_DIR:-/var/lib/systemd/timers}"

# Remove the ANAS SCHEDULE units (review F2/F8). ONE rule for all five unit
# families — `anas-snap-*`, `anas-backup-*`, `anas-repl-*`, `anas-cloud-*`,
# `anas-scrub.*` — and one reason for it: every family's runner lives in
# /opt/anas, which this
# uninstall is deleting (a cloud task's ExecStart is
# /opt/anas/packages/daemon/dist/cloud-task.js; the family was missing here
# from rclone.2 until cr.61, review M9). A systemd timer left behind keeps
# firing a runner that no longer exists, month after month; a lost schedule is
# the honest outcome of
# uninstalling, a broken one is not. Each family's timers are disabled --now,
# its unit files and Persistent stamps removed, and one line names the family
# and the count.
#
# mdcheck IS re-enabled (ruling 2026-09-14, reversing review F2): a node left
# with no parity check at all is not helping or guarding, and mdadm's
# `mdcheck_start`/`mdcheck_continue` timers are ENABLED BY DEFAULT on a stock
# node (SCHEDULES-GROUND-TRUTH). Turning them back on is not a guess about what
# this node had before ANAS — it is restoring the distro default, which is what
# a guest leaves behind. The printed line says that is what happened, and how
# to turn them off again (spindown operators run without a periodic check on
# purpose).
#
# Idempotent: every step is guarded, a partially-uninstalled node is fine.
remove_schedule_units() {
  local family f svc count
  for family in anas-snap anas-backup anas-repl anas-cloud; do
    count=0
    for f in "${SYSTEMD_DIR}/${family}"-*.service; do
      [ -e "${f}" ] || continue
      svc="${f##*/}"; svc="${svc%.service}"
      systemctl disable --now "${svc}.timer" >/dev/null 2>&1 || true
      rm -f "${SYSTEMD_DIR}/${svc}.service" "${SYSTEMD_DIR}/${svc}.timer"
      rm -f "${TIMERS_STAMP_DIR}/stamp-${svc}.timer"
      count=$((count + 1))
    done
    if [ "${count}" -gt 0 ]; then
      info "removed ${count} ANAS schedule unit pair(s) (${family}-*)"
    fi
  done

  if [ -f "${SYSTEMD_DIR}/anas-scrub.timer" ] || [ -f "${SYSTEMD_DIR}/anas-scrub.service" ]; then
    systemctl disable --now anas-scrub.timer >/dev/null 2>&1 || true
    rm -f "${SYSTEMD_DIR}/anas-scrub.timer" "${SYSTEMD_DIR}/anas-scrub.service"
    rm -f "${TIMERS_STAMP_DIR}/stamp-anas-scrub.timer"
    info "removed 1 ANAS schedule unit pair (anas-scrub.*)"
    # The node goes back to stock (ruling 2026-09-14): ANAS disabled mdadm's
    # timers when the periodic scrub was enabled, and the distro default is
    # that they are ON. Best-effort — a node without the mdcheck units (they
    # ship with mdadm, but a minimal install may not have them), or one where
    # they have been masked, costs the re-enable and nothing else.
    #
    # REPORT WHAT ACTUALLY HAPPENED (sixth pass, N7). The line used to print
    # "has been RESTORED" unconditionally, after a call ending in `|| true` —
    # so a masked or missing unit left the node with NO periodic md parity
    # check at all while the uninstaller said the opposite. That is the one
    # sentence an operator would act on, and it has to be true.
    if systemctl enable --now mdcheck_start.timer mdcheck_continue.timer >/dev/null 2>&1; then
      info "ANAS periodic scrub removed. mdadm's own parity check (mdcheck_start.timer, mdcheck_continue.timer) is the distro default. ANAS disabled it when the scrub was enabled, and it has been RESTORED;"
      info "run \`systemctl disable --now mdcheck_start.timer mdcheck_continue.timer\` if you do not want a periodic md parity check on this node."
    else
      warn "ANAS periodic scrub removed, but mdadm's own parity check (mdcheck_start.timer, mdcheck_continue.timer) could not be re-enabled (masked or not installed). The node is left with no periodic md parity check."
      warn "Run \`systemctl enable --now mdcheck_start.timer mdcheck_continue.timer\` by hand, or arrange a parity check another way."
    fi
  fi
}

# Remove the recycle-bin age-based cleanup timer + service (smbsvc.2). ONE
# static pair (enabled by install.sh) — the runner reads each share's deletion
# age from its smb.conf marker, so there are no per-share units to sweep.
#
# Deliberately NOT touched, ever: the `#recycle` directories themselves, and
# the `recycle:*` keys / markers in smb.conf. A checkbox never deletes data —
# the bins are real files a user may still want, and an uninstall that emptied
# them would be an owner's move, not a guest's. Shares keep their (now
# unswept) bins; if smbd is still serving them, the module keeps working.
remove_recycle_units() {
  if [ ! -f "${SYSTEMD_DIR}/anas-recycle.timer" ] && [ ! -f "${SYSTEMD_DIR}/anas-recycle.service" ]; then
    return 0
  fi
  systemctl disable --now anas-recycle.timer >/dev/null 2>&1 || true
  rm -f "${SYSTEMD_DIR}/anas-recycle.timer" "${SYSTEMD_DIR}/anas-recycle.service"
  rm -f "${TIMERS_STAMP_DIR}/stamp-anas-recycle.timer"
  info "removed 1 ANAS schedule unit pair (anas-recycle.*); every #recycle directory and its contents are left in place"
}

# The whole-file copy of pve-manager's index.html.tpl that older installs took
# once, as `index.html.tpl.anas-orig` (review L5, cr.61). Nothing ever read it:
# the script line is removed surgically by pve-integration/uninstall.sh, and
# the copy was never refreshed, so after a pve-manager upgrade it is a stale
# PVE file inside /usr/share/pve-manager that a by-hand "restore" would
# downgrade the UI with (the 2026-10-14 H2 hazard class, the AnyEvent.pm copy
# cr.7 retired). No copy is taken any more; one left behind is removed here,
# never used.
sweep_stale_tpl_backup() {
  local tpl="${PVE_TPL:-/usr/share/pve-manager/index.html.tpl}"
  if [ -f "${tpl}.anas-orig" ]; then
    rm -f "${tpl}.anas-orig"
    info "removed stale ${tpl}.anas-orig left by an older install (unused, never restored)"
  fi
}

# The mdadm.conf PROGRAM line that points mdadm --monitor at ANAS's md-event
# hook (CORE-L7). The daemon writes `PROGRAM <hook>` when an AHR pool is
# created and retires it when the last AHR pool is destroyed; an uninstall that
# deletes the hook while an AHR pool survives used to leave the line pointing
# at a binary that no longer exists, so every md event of the surviving arrays
# exec'd nothing. The ARRAY pins stay: they name the arrays on assembly and are
# useful without ANAS.
#
# WHICH LINES (cr3 review 3): every line the DAEMON reads as a PROGRAM line
# naming exactly our hook (parsers/mdadm-conf.ts parseLine + removeProgram):
# the keyword case-insensitive and abbreviable to three or more letters
# (`PROGRAM`, `program`, `PROG`, `pro`), any spacing, anything after the path
# once a blank separates it (a trailing `# comment`, the `\r` of a CRLF file).
# Never a line that starts with a blank (a continuation the daemon does not
# read), a `#` line, a longer path (`...anas-md-event-old`), or a foreign one.
#
# HOW (the file assembles arrays at boot): read byte for byte (C locale,
# `grep -a`: a Latin-1 comment or a NUL is a byte like any other); grep's 0 and
# 1 are its only successes; the lines are removed by NUMBER with GNU sed
# (which keeps a missing final newline missing); the result must have exactly
# the original's line count minus the removed lines and exactly its size minus
# their bytes, or nothing is renamed; the new file is written in the TARGET's
# directory (a symlinked mdadm.conf stays a link), carries the target's mode
# and owner, is flushed (`sync -f`) and renamed over the target. Any failure
# leaves mdadm.conf exactly as it was and says so; the running monitor is
# restarted only when the file changed.
MDADM_CONF="${MDADM_CONF:-/etc/mdadm/mdadm.conf}"
# Write `$1` minus the line numbers in `$3` (k lines, `$4` bytes) to the temp
# file `$2` and check it: 0 only when the result is exactly the original's
# line count minus k and its size minus the removed bytes.
md_conf_filtered() {
  local src="$1" tmp="$2" k="$4" bytes="$5" in_lines in_size out_lines out_size
  # shellcheck disable=SC2086
  LC_ALL=C sed $3 -- "${src}" > "${tmp}" || return 1
  in_lines="$(LC_ALL=C grep -a -c '' -- "${src}" || true)"
  out_lines="$(LC_ALL=C grep -a -c '' -- "${tmp}" || true)"
  in_size="$(stat -c %s -- "${src}")" || return 1
  out_size="$(stat -c %s -- "${tmp}")" || return 1
  [ -n "${in_lines}" ] && [ -n "${out_lines}" ] || return 1
  [ "${out_lines}" -eq $((in_lines - k)) ] && [ "${out_size}" -eq $((in_size - bytes)) ]
}

retire_md_program_hook() {
  local hook="$1" target dir tmp re lines n rc=0 k=0 removed_bytes=0 sed_expr=""
  [ -e "${MDADM_CONF}" ] || [ -L "${MDADM_CONF}" ] || return 0
  if ! target="$(readlink -f -- "${MDADM_CONF}")" || [ ! -f "${target}" ]; then
    warn "${MDADM_CONF} does not resolve to a regular file; ANAS's monitor hook line (PROGRAM ${hook}) was not looked for. Remove it by hand if it is there."
    return 0
  fi
  # The hook path as a literal inside the ERE.
  re="^[Pp][Rr][Oo]([Gg]([Rr]([Aa]([Mm])?)?)?)?[[:space:]]+$(printf '%s' "${hook}" | LC_ALL=C sed 's/[][\\.*^$+?(){}|]/\\&/g')([[:space:]].*)?$"
  lines="$(LC_ALL=C grep -a -n -E -- "${re}" "${target}")" || rc=$?
  if [ "${rc}" -eq 1 ]; then
    return 0
  fi
  if [ "${rc}" -ne 0 ]; then
    warn "could not read ${target} (grep exited ${rc}); ANAS's monitor hook line (PROGRAM ${hook}) was left in place. Remove it by hand."
    return 0
  fi
  while IFS=: read -r n _; do
    sed_expr="${sed_expr} -e ${n}d"
    k=$((k + 1))
    removed_bytes=$((removed_bytes + $(LC_ALL=C sed -n "${n}p" -- "${target}" | wc -c)))
  done <<<"${lines}"
  dir="$(dirname -- "${target}")"
  if ! tmp="$(mktemp -- "${dir}/.$(basename -- "${target}").anas.XXXXXX")"; then
    warn "could not create a temporary file in ${dir}; ANAS's monitor hook line (PROGRAM ${hook}) was left in ${target}. Remove it by hand."
    return 0
  fi
  if md_conf_filtered "${target}" "${tmp}" "${sed_expr}" "${k}" "${removed_bytes}" \
     && chmod --reference="${target}" -- "${tmp}" \
     && chown --reference="${target}" -- "${tmp}" \
     && sync -f -- "${tmp}" \
     && mv -f -T -- "${tmp}" "${target}"; then
    systemctl try-restart mdmonitor.service >/dev/null 2>&1 || true
    info "removed ANAS's monitor hook line (PROGRAM ${hook}) from ${MDADM_CONF}; mdadm's own event handling (MAILADDR) applies to the arrays that remain"
    return 0
  fi
  rm -f -- "${tmp:?}"
  warn "could not rewrite ${target} safely; it was left exactly as it was, and ANAS's monitor hook line (PROGRAM ${hook}) is still in it. Remove that line by hand."
  return 0
}

# AHR read caches that survive the uninstall (CORE-L7): the recovery from a
# lost cache device (`lvconvert --uncache`, AHR §13) is anasd's, triggered by
# the udev rule this uninstall removes. Without ANAS, a cache device that
# disappears makes every read on that pool fail until the operator uncaches it
# by hand. The slices are found by the GPT partition name ANAS wrote
# (`<pool>-cacheN`), the same name the rule matched. Read-only; says nothing
# when there are none or lsblk cannot tell.
warn_surviving_ahr_caches() {
  local labels
  labels="$(lsblk -nro PARTLABEL 2>/dev/null | grep -E -- '-cache[0-9]+$' || true)"
  [ -n "${labels}" ] || return 0
  warn "AHR read-cache slice(s) remain on this node: $(printf '%s' "${labels}" | tr '\n' ' ')"
  warn "ANAS recovered a pool automatically when its cache device disappeared; without ANAS, a lost cache device makes every read on that pool fail until you run 'lvconvert --uncache <vg>/<lv>' by hand."
}

usage() {
  cat <<EOF
ANAS uninstaller

Usage: sudo ./uninstall.sh [--prefix DIR]

Options:
  --prefix DIR   Install location to remove (default: /opt/anas).
  -h, --help     Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)   shift; [ "$#" -gt 0 ] || { err "--prefix needs an argument"; exit 2; }; PREFIX="$1" ;;
    --prefix=*) PREFIX="${1#*=}" ;;
    -h|--help)  usage; exit 0 ;;
    *) err "unknown option: $1"; usage >&2; exit 2 ;;
  esac
  shift
done

# ANAS_UNINSTALL_LIB_ONLY lets the test harness source this file to exercise
# remove_schedule_units against a throwaway SYSTEMD_DIR with a faked systemctl —
# the install.sh lib-mode pattern, no root, no real node.
if [ "${ANAS_UNINSTALL_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || true
fi

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  err "must run as root (EUID 0). Try: sudo ./uninstall.sh"
  exit 1
fi

log "Uninstalling ANAS (prefix: ${PREFIX})..."

# 1. Stop and disable services (ignore errors — may already be gone).
info "stopping and disabling services"
systemctl disable --now anasd anas >/dev/null 2>&1 || true

# ORDER (cr3.core): the PVE UI integration is reverted LAST, just before the
# prefix that holds its uninstaller is removed. Its uninstaller restarts
# pveproxy, and a hard restart kills a shell that runs inside pveproxy's
# cgroup — the PVE web shell (integration.r1). Run from there, the uninstall
# used to die at that step with every unit, schedule timer, hook, template and
# the env file still in place: the schedule timers went on firing runners
# under ${PREFIX}. Everything that does not need pveproxy is now removed first;
# a web-shell run that dies at the restart leaves only ${PREFIX} behind, and a
# re-run removes it.

# 3. Remove the systemd unit files and reload.
removed_unit=0
for u in anasd anas; do
  if [ -f "${SYSTEMD_DIR}/${u}.service" ]; then
    rm -f "${SYSTEMD_DIR}/${u}.service"
    removed_unit=1
  fi
done
if [ "${removed_unit}" -eq 1 ]; then
  info "removed systemd unit files"
fi

# 3a. Remove the ANAS schedule units (periodic scrub + the snapshot/backup/
# replication schedules + the cloud sync tasks) — all five families, and
# mdcheck restored to the
# distro default when the scrub timer was one of them.
# See the function above (review F2/F8).
remove_schedule_units

# 3a'. Remove the recycle-bin cleanup timer + service (smbsvc.2) — never any
# `#recycle` contents (see remove_recycle_units above).
remove_recycle_units

# 3b. Remove the iSCSI boot-ordering drop-in install.sh added beside
# rtslib-fb-targetctl.service. This is the ONLY iSCSI thing an uninstall touches.
#
# Deliberately NOT removed, ever:
#   * targetcli-fb / python3-rtslib-fb — dependencies, like samba and mdadm.
#     Removing a package the node may be using for something else is not a
#     guest's call, and python3-rtslib-fb's removal would take the boot restore
#     service with it.
#   * /etc/rtslib-fb-target/saveconfig.json and its backup/ rotation — that file
#     IS the node's iSCSI configuration: every target, every LUN, and above all
#     every LUN's unit serial, which is what initiators, ESXi, Windows and PVE's
#     own volids identify the disk by. Deleting it would silently change the
#     identity of every disk this node serves. It is data, and it stays.
#   * the live LIO configuration in configfs — the targets keep serving.
ISCSI_DROPIN_DIR="${ISCSI_DROPIN_DIR:-rtslib-fb-targetctl.service.d}"
ISCSI_DROPIN_FILE="${ISCSI_DROPIN_FILE:-anas-ordering.conf}"
if [ -f "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}" ]; then
  rm -f "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}"
  # Only if empty — another drop-in in that directory is not ours to remove.
  rmdir "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}" >/dev/null 2>&1 || true
  info "removed the iSCSI ordering drop-in (targetcli-fb, python3-rtslib-fb and the saved LIO configuration are left alone)"
fi

systemctl daemon-reload >/dev/null 2>&1 || true

# 3c. Remove the mdadm md-event hook installed by install.sh, and the PROGRAM
# line that points mdadm --monitor at it when an AHR pool outlives the
# uninstall (CORE-L7; the daemon retires it itself when the last AHR pool is
# destroyed). The ARRAY pins are not touched.
HOOK_DEST="${HOOK_DEST:-/usr/local/bin/anas-md-event}"
retire_md_program_hook "${HOOK_DEST}"
if [ -f "${HOOK_DEST}" ]; then
  rm -f "${HOOK_DEST}"
  info "removed md-event hook ${HOOK_DEST}"
fi

# 3c2. Remove the AHR read-cache removal hook and its udev rule (ahrcache.1
# slice 2). Both are ANAS's own files, named by ANAS, in the drop-in directory
# udev provides for exactly this — nothing else in /etc/udev/rules.d is read or
# touched (guest philosophy). Any `<pool>-cacheN` slice still on a disk stays
# where it is: that is the operator's data layout, and Detach cache is the verb
# that removes it.
CACHE_HOOK_DEST="${CACHE_HOOK_DEST:-/usr/local/bin/anas-cache-event}"
UDEV_RULES_DIR="${UDEV_RULES_DIR:-/etc/udev/rules.d}"
CACHE_RULE_DEST="${CACHE_RULE_DEST:-${UDEV_RULES_DIR}/99-anas-cache.rules}"
removed_cache_udev=0
if [ -f "${CACHE_HOOK_DEST}" ]; then
  rm -f "${CACHE_HOOK_DEST}"
  removed_cache_udev=1
fi
if [ -f "${CACHE_RULE_DEST}" ]; then
  rm -f "${CACHE_RULE_DEST}"
  removed_cache_udev=1
fi
if [ "${removed_cache_udev}" -eq 1 ]; then
  udevadm control --reload-rules >/dev/null 2>&1 || true
  info "removed AHR cache-event hook ${CACHE_HOOK_DEST} and ${CACHE_RULE_DEST}"
  warn_surviving_ahr_caches
fi

# 3d. Remove the ANAS notification templates install.sh drops into pve-manager's
# template dir. Only our own anas-named files are touched — never any other
# template in that shared directory (guest philosophy).
PVE_TEMPLATE_DIR="${PVE_TEMPLATE_DIR:-/usr/share/pve-manager/templates/default}"
removed_template=0
for tpl in anas-ahr-subject.txt.hbs anas-ahr-body.txt.hbs \
           anas-backup-subject.txt.hbs anas-backup-body.txt.hbs \
           anas-snapshot-subject.txt.hbs anas-snapshot-body.txt.hbs \
           anas-replication-subject.txt.hbs anas-replication-body.txt.hbs \
           anas-cloud-subject.txt.hbs anas-cloud-body.txt.hbs \
           anas-integration-subject.txt.hbs anas-integration-body.txt.hbs; do
  if [ -f "${PVE_TEMPLATE_DIR}/${tpl}" ]; then
    rm -f "${PVE_TEMPLATE_DIR}/${tpl}"
    removed_template=1
  fi
done
if [ "${removed_template}" -eq 1 ]; then
  info "removed ANAS notification templates from ${PVE_TEMPLATE_DIR}"
fi

# 3e. Remove the ANAS-owned gateway env file (issue #2). ANAS-owned, so it is
# safe to delete outright (unlike the surgical edits above).
if [ -f "${ANAS_ENV_FILE}" ]; then
  rm -f "${ANAS_ENV_FILE}"
  info "removed ${ANAS_ENV_FILE}"
fi

# 3f. Deliberately NOT removed, ever (stated so a later reader does not add the
# removal): the rclone package, and /etc/anas/rclone.conf alongside the rest of
# /etc/anas (creds/, ahr/) — the same treatment as /etc/anas/creds. rclone is a
# dependency like samba and mdadm (the node may be using it for something
# else), and the config store is ANAS's DATA — every cloud remote and its
# credentials. Deleting it would be an owner's move, not a guest's; a reinstall
# picks the store straight back up.

# 5. Revert the PVE UI integration if its uninstaller is still present — LAST
# before the prefix (see ORDER above): it may restart pveproxy.
if [ -x "${PREFIX}/packages/pve-integration/uninstall.sh" ]; then
  info "reverting PVE UI integration (pveproxy restarts: a PVE web shell running this closes here; re-run the uninstall to remove ${PREFIX} if it does)"
  "${PREFIX}/packages/pve-integration/uninstall.sh" || true
else
  info "pve-integration uninstaller not found (skipping)"
fi
# 5a. The stale index.html.tpl copy an older install took (review L5).
sweep_stale_tpl_backup

# 6. Remove the install prefix.
if [ -d "${PREFIX}" ]; then
  info "removing ${PREFIX}"
  rm -rf "${PREFIX}"
else
  info "${PREFIX} not present (nothing to remove)"
fi

echo
log "ANAS uninstalled."

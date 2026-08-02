#!/bin/sh
#
# anas-md-event — mdadm --monitor PROGRAM hook for ANAS AHR pools.
#
# Installed by the ANAS installer as /usr/local/bin/anas-md-event and wired via
# a surgical `PROGRAM /usr/local/bin/anas-md-event` line in /etc/mdadm/mdadm.conf
# (AHR-DESIGN §7.2, GT-11: mdmonitor runs out of the box on Debian — this hook
# makes its events land somewhere useful instead of root mail).
#
# Contract (mdadm.conf(5) / mdadm --monitor):
#   anas-md-event <event> <md-device> [<member-device>]
#     $1  event name (Fail, FailSpare, DegradedArray, RebuildFinished,
#         SparesMissing, RebuildStarted, Rebuild20, NewArray, SpareActive,
#         MoveSpare, DeviceDisappeared, TestMessage, ...)
#     $2  md device the event concerns (e.g. /dev/md127)
#     $3  member device, when the event concerns one (e.g. /dev/sdb2) — optional
#
# Output: one structured journald record via logger, tag `anas-ahr`, facility
# daemon, severity mapped from the event (AHR-DESIGN §7.2 table). Message body
# is key=value fields (EVENT= DEVICE= MEMBER=) per the journald audit
# conventions.
#
# Exit status: 0 after logging (never make mdadm's monitor loop unhappy);
# 64 (EX_USAGE) only when called without the mandatory <event> <md-device>.
#
set -u

if [ "$#" -lt 2 ]; then
  logger -t anas-ahr -p daemon.err "EVENT=UsageError DETAIL=called-with-$#-args EXPECTED=event-and-md-device"
  exit 64
fi

EVENT="$1"
DEVICE="$2"
MEMBER="${3:-}"

# sysfs root for md state — overridable so tests can fake it.
MD_SYSFS_BLOCK="${ANAS_MD_SYSFS_BLOCK:-/sys/block}"

# Total bad-block ranges recorded across the array's members, read from
# /sys/block/<md>/md/dev-*/bad_blocks ("sector length" per line — the ranges
# md could NOT reconstruct, e.g. a URE on a survivor during a degraded
# rebuild). Prints a number on success; prints nothing when sysfs is
# unreadable (fail-open — the caller degrades to generic wording).
count_bad_block_ranges() {
  _md_real=$(readlink -f "$1" 2>/dev/null) || return 0
  _md_name=${_md_real##*/}
  _md_dir="${MD_SYSFS_BLOCK}/${_md_name}/md"
  [ -d "$_md_dir" ] || return 0
  _total=0
  for _f in "$_md_dir"/dev-*/bad_blocks; do
    [ -f "$_f" ] || continue
    _n=$(grep -c . "$_f" 2>/dev/null) || _n=0
    _total=$((_total + _n))
  done
  echo "$_total"
}

# What the sync thread was actually doing, from
# /sys/block/<md>/md/last_sync_action (check/repair/resync/recover/reshape).
# mdadm --monitor names EVERY sync operation "Rebuild*" — the monthly mdcheck
# scrub arrives as RebuildStarted/RebuildFinished too, and a "rebuild
# finished" alert for a routine check window is alarming and wrong (operator,
# live on pve5 2026-08-04). Prints nothing when sysfs is unreadable.
last_sync_action() {
  _md_real=$(readlink -f "$1" 2>/dev/null) || return 0
  _f="${MD_SYSFS_BLOCK}/${_md_real##*/}/md/last_sync_action"
  [ -f "$_f" ] && cat "$_f" 2>/dev/null
}

# Parity-mismatch counter after a check (valid once a check has run; a real
# rebuild leaves it untouched). Prints nothing when unreadable.
mismatch_count() {
  _md_real=$(readlink -f "$1" 2>/dev/null) || return 0
  _f="${MD_SYSFS_BLOCK}/${_md_real##*/}/md/mismatch_cnt"
  [ -f "$_f" ] && cat "$_f" 2>/dev/null
}

# 11.17: on a sync completion, learn what finished and how it went — one
# sub-second sysfs read each — so the journald record and the notification
# can say which. NEVER auto-start a scrub (operator decision: a scrub is a
# many-hour/day operation; recommend, don't enforce).
BADBLOCKS=""
ACTION=""
MISMATCHES=""
case "$EVENT" in
  RebuildStarted | Rebuild?? | RebuildFinished)
    ACTION=$(last_sync_action "$DEVICE")
    ;;
esac
if [ "$EVENT" = "RebuildFinished" ]; then
  if [ "$ACTION" = "check" ]; then
    MISMATCHES=$(mismatch_count "$DEVICE")
  else
    BADBLOCKS=$(count_bad_block_ranges "$DEVICE")
  fi
fi

# Severity map (AHR-DESIGN §7.2): redundancy lost / at risk -> warning,
# redundancy restored -> notice, everything informational -> info.
case "$EVENT" in
  Fail | FailSpare | DegradedArray | SparesMissing)
    PRIORITY=warning
    ;;
  RebuildFinished)
    PRIORITY=notice
    ;;
  *)
    PRIORITY=info
    ;;
esac

LOGLINE="EVENT=${EVENT} DEVICE=${DEVICE}"
[ -n "$MEMBER" ] && LOGLINE="${LOGLINE} MEMBER=${MEMBER}"
[ -n "$ACTION" ] && LOGLINE="${LOGLINE} ACTION=${ACTION}"
[ -n "$MISMATCHES" ] && LOGLINE="${LOGLINE} MISMATCHES=${MISMATCHES}"
[ -n "$BADBLOCKS" ] && LOGLINE="${LOGLINE} BADBLOCKS=${BADBLOCKS}"
logger -t anas-ahr -p "daemon.${PRIORITY}" "$LOGLINE"

# Forward redundancy-affecting events through the PVE notification system
# (GT-17: PVE::Notify + the ANAS-shipped anas-ahr templates; args pass via
# @ARGV so there is no quoting/injection surface). Best-effort: a delivery
# failure is logged and swallowed — never make the monitor loop unhappy.
case "$EVENT" in
  Fail | FailSpare | DegradedArray | SparesMissing | RebuildFinished)
    NOTIFY_SEV=warning
    [ "$EVENT" = "RebuildFinished" ] && NOTIFY_SEV=info
    if [ -n "$MEMBER" ]; then
      MSG="mdadm reported ${EVENT} on ${DEVICE} (member ${MEMBER})"
    else
      MSG="mdadm reported ${EVENT} on ${DEVICE}"
    fi
    # 11.17: say what actually finished. mdadm calls every sync op "Rebuild",
    # but a routine check (the scheduled scrub) must not read like a disk was
    # rebuilt. Checks report the mismatch counter; real rebuilds report the
    # bad-block outcome. Always recommend — never start — a scrub.
    TITLE="md ${EVENT}: ${DEVICE}"
    if [ "$EVENT" = "RebuildFinished" ] && [ "$ACTION" = "check" ]; then
      TITLE="md check finished: ${DEVICE}"
      MSG="The scheduled parity check (scrub) on ${DEVICE} finished its run window — this is routine, no disk was rebuilt. Long checks pause and resume in daily windows until the whole array has been read."
      if [ -n "$MISMATCHES" ] && [ "$MISMATCHES" -gt 0 ] 2>/dev/null; then
        NOTIFY_SEV=warning
        MSG="${MSG} md counted ${MISMATCHES} parity mismatch(es) during this check — run a Scrub on this pool so btrfs checksums can identify any affected files."
      elif [ "$MISMATCHES" = "0" ]; then
        MSG="${MSG} No parity mismatches were counted."
      fi
    elif [ "$EVENT" = "RebuildFinished" ]; then
      if [ -n "$BADBLOCKS" ] && [ "$BADBLOCKS" -gt 0 ] 2>/dev/null; then
        NOTIFY_SEV=warning
        MSG="${MSG}. ${BADBLOCKS} unreadable sector range(s) are recorded on the array's members — data in those ranges could not be reconstructed during the rebuild. Run a Scrub on this pool to identify any affected files."
      elif [ "$BADBLOCKS" = "0" ]; then
        MSG="${MSG}. No unreadable sectors were recorded — the rebuild reconstructed everything exactly. As a precaution, a Scrub will verify all data checksums."
      else
        MSG="${MSG}. As a precaution, run a Scrub on this pool to verify all data checksums."
      fi
    fi
    perl -e 'use PVE::Notify; my ($sev, $title, $msg) = @ARGV; PVE::Notify::notify($sev, "anas-ahr", { title => $title, message => $msg }, { type => "anas-ahr" });' \
      "$NOTIFY_SEV" "$TITLE" "$MSG" 2>/dev/null \
      || logger -t anas-ahr -p daemon.info "EVENT=NotifyForwardFailed ORIG_EVENT=${EVENT} DEVICE=${DEVICE}"
    ;;
esac

exit 0
